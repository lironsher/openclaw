import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedWatcherAccount, WatcherInboundMessage } from "./types.js";

const SENSECRAFT_BOUNDARY = Buffer.from("\n---sensecraftboundary---\n", "utf8");
const PCM_SAMPLE_RATE = 16_000;
const PCM_BYTES_PER_SAMPLE = 2;
const BODY_PREVIEW_BYTES = 24;
const HEADER_VALUE_MAX_CHARS = 220;
const WATCHER_ENGLISH_ONLY_INSTRUCTION =
  "Reply in English only. Use plain ASCII characters and avoid Chinese characters.";
const WATCHER_ASCII_FALLBACK_REPLY =
  "Sorry, I can only return English text on this channel.";

let watcherRequestSeq = 0;

type LogSink = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type WatcherWebhookHandlerDeps = {
  account: ResolvedWatcherAccount;
  deliver: (msg: WatcherInboundMessage) => Promise<string | null>;
  log?: LogSink;
};

function createRequestId(): string {
  watcherRequestSeq += 1;
  return watcherRequestSeq.toString(36);
}

function trimForLog(value: string, maxChars = HEADER_VALUE_MAX_CHARS): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxChars)}...`;
}

function redactSecret(value: string): string {
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

function sanitizeUrlForLog(url: URL): string {
  const clone = new URL(url.toString());
  for (const key of clone.searchParams.keys()) {
    if (["token", "access_token", "api_key", "apikey", "key"].includes(key.toLowerCase())) {
      const value = clone.searchParams.get(key);
      if (value) {
        clone.searchParams.set(key, redactSecret(value));
      }
    }
  }
  return `${clone.pathname}${clone.search}`;
}

function sanitizeHeadersForLog(req: IncomingMessage): Record<string, string | string[]> {
  const safeHeaders: Record<string, string | string[]> = {};
  for (const [name, rawValue] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase();
    const isSecret = [
      "authorization",
      "x-watcher-token",
      "x-openclaw-watcher-token",
      "x-api-key",
      "proxy-authorization",
    ].includes(lowerName);

    if (typeof rawValue === "string") {
      const value = trimForLog(rawValue);
      safeHeaders[lowerName] = isSecret ? redactSecret(value) : value;
      continue;
    }

    if (Array.isArray(rawValue)) {
      safeHeaders[lowerName] = rawValue.map((entry) => {
        const value = trimForLog(entry);
        return isSecret ? redactSecret(value) : value;
      });
    }
  }
  return safeHeaders;
}

function toAsciiPreview(buffer: Buffer): string {
  return buffer
    .toString("latin1")
    .replace(/[^\x20-\x7E]/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function describeBodyForLog(body: Buffer, contentType: string | undefined): string {
  const firstNonWhitespace = body.find((byte) => ![9, 10, 13, 32].includes(byte));
  const looksLikeJson =
    firstNonWhitespace !== undefined &&
    (body[firstNonWhitespace] === 0x7b || body[firstNonWhitespace] === 0x5b);
  const preview = body.subarray(0, Math.min(BODY_PREVIEW_BYTES, body.length));
  const previewHex = preview.toString("hex");
  const previewAscii = toAsciiPreview(preview);

  return JSON.stringify({
    bytes: body.length,
    contentType: contentType ?? "unknown",
    hasWavHeader: hasWavHeader(body),
    hasSensecraftBoundary: body.indexOf(SENSECRAFT_BOUNDARY) >= 0,
    looksLikeJson,
    previewHex,
    previewAscii,
  });
}

export function hasWavHeader(audioBuffer: Buffer): boolean {
  if (audioBuffer.length < 12) {
    return false;
  }
  return (
    audioBuffer.toString("ascii", 0, 4) === "RIFF" &&
    audioBuffer.toString("ascii", 8, 12) === "WAVE"
  );
}

function createPcm16MonoWavHeader(dataSize: number, sampleRate = PCM_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * PCM_BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(PCM_BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

export function ensureWavAudioBuffer(audioBuffer: Buffer): Buffer {
  if (hasWavHeader(audioBuffer)) {
    return audioBuffer;
  }
  return Buffer.concat([createPcm16MonoWavHeader(audioBuffer.length), audioBuffer]);
}

function responseJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let finished = false;

    const fail = (error: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      reject(error);
    };

    req.on("data", (chunk: Buffer | string) => {
      if (finished) {
        return;
      }
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalSize += bufferChunk.length;
      if (totalSize > maxBytes) {
        req.destroy();
        fail(new Error(`Audio payload too large (max ${maxBytes} bytes)`));
        return;
      }
      chunks.push(bufferChunk);
    });
    req.on("end", () => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const first = value.find((entry) => entry.trim().length > 0);
    return first?.trim();
  }
  return undefined;
}

function getBearerToken(req: IncomingMessage): string | undefined {
  const auth = getHeader(req, "authorization");
  if (!auth) {
    return undefined;
  }
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function resolveSender(
  req: IncomingMessage,
  account: ResolvedWatcherAccount,
  url: URL,
): { from: string; senderName?: string } {
  const fromQuery = url.searchParams.get("sender")?.trim();
  const fromHeader = getHeader(req, account.senderIdHeader)?.trim();
  const remoteAddress = req.socket?.remoteAddress?.trim();
  const senderId = (fromQuery ?? fromHeader ?? remoteAddress ?? account.defaultFrom).toLowerCase();
  const senderName =
    url.searchParams.get("senderName")?.trim() ??
    getHeader(req, account.senderNameHeader)?.trim() ??
    undefined;
  return {
    from: senderId.length > 0 ? senderId : account.defaultFrom,
    senderName,
  };
}

function isSenderAllowed(senderId: string, account: ResolvedWatcherAccount): boolean {
  if (account.dmPolicy === "disabled") {
    return false;
  }
  if (account.dmPolicy === "open") {
    return true;
  }
  return account.allowFrom.includes(senderId.toLowerCase());
}

function extractString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function extractAsrText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : undefined;
  const choices = Array.isArray(record.choices) ? record.choices : undefined;
  const firstChoice =
    choices && choices.length > 0 && choices[0] && typeof choices[0] === "object"
      ? (choices[0] as Record<string, unknown>)
      : undefined;

  return (
    extractString(record.text) ??
    extractString(record.result) ??
    extractString(record.transcript) ??
    extractString(record.output_text) ??
    extractString(data?.text) ??
    extractString(data?.result) ??
    extractString(data?.transcript) ??
    extractString(firstChoice?.text)
  );
}

function extractAudioBase64(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : undefined;
  const audio =
    record.audio && typeof record.audio === "object"
      ? (record.audio as Record<string, unknown>)
      : undefined;
  const candidate =
    extractString(record.audio_base64) ??
    extractString(record.audio) ??
    extractString(record.data) ??
    extractString(data?.audio_base64) ??
    extractString(data?.audio) ??
    extractString(audio?.audio_base64) ??
    extractString(audio?.data);
  if (!candidate) {
    return undefined;
  }

  const dataUrlMatch = candidate.match(/^data:audio\/[a-z0-9.+-]+;base64,(.+)$/i);
  if (dataUrlMatch?.[1]) {
    return dataUrlMatch[1];
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(candidate)) {
    return candidate.replace(/\s+/g, "");
  }
  return undefined;
}

function resolveTtsModel(model: string): string {
  const normalized = model.trim();
  if (normalized.toLowerCase() === "glm-4-voice") {
    return "glm-tts";
  }
  return normalized;
}

async function responseErrorPreview(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) {
      return "";
    }
    return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
  } catch {
    return "";
  }
}

async function requestBigmodelAsr(params: {
  account: ResolvedWatcherAccount;
  audioWav: Buffer;
  signal: AbortSignal;
}): Promise<string> {
  const { account, audioWav, signal } = params;
  if (!account.bigmodelApiKey) {
    throw new Error(
      "bigmodelApiKey is missing. Configure channels.watcher.bigmodelApiKey or BIGMODEL_API_KEY.",
    );
  }

  const endpoint = new URL("/api/paas/v4/audio/transcriptions", account.bigmodelBaseUrl).toString();
  const formData = new FormData();
  const wavBlob = new Blob([new Uint8Array(audioWav)], { type: "audio/wav" });
  formData.append("model", account.asrModel);
  formData.append("file", wavBlob, "watcher.wav");
  // Compatibility with services that still expect this field name.
  formData.append("audio_file", wavBlob, "watcher.wav");
  if (account.asrLanguage) {
    formData.append("language", account.asrLanguage);
  }
  if (account.asrPrompt) {
    formData.append("prompt", account.asrPrompt);
  }
  formData.append("response_format", "json");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.bigmodelApiKey}`,
    },
    body: formData,
    signal,
  });
  if (!response.ok) {
    const preview = await responseErrorPreview(response);
    throw new Error(
      `ASR request failed with status ${response.status}${preview ? `: ${preview}` : ""}`,
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as unknown;
    const text = extractAsrText(payload);
    if (!text) {
      throw new Error("ASR response did not contain transcript text.");
    }
    return text;
  }

  const text = (await response.text()).trim();
  if (!text) {
    throw new Error("ASR response body is empty.");
  }
  return text;
}

async function requestBigmodelTts(params: {
  account: ResolvedWatcherAccount;
  text: string;
  signal: AbortSignal;
}): Promise<Buffer> {
  const { account, text, signal } = params;
  if (!account.bigmodelApiKey) {
    throw new Error(
      "bigmodelApiKey is missing. Configure channels.watcher.bigmodelApiKey or BIGMODEL_API_KEY.",
    );
  }

  const endpoint = new URL("/api/paas/v4/audio/speech", account.bigmodelBaseUrl).toString();
  const body: Record<string, unknown> = {
    model: resolveTtsModel(account.ttsModel),
    input: text,
    response_format: account.ttsResponseFormat,
    speed: account.ttsSpeed,
    volume: 1.0,
  };
  if (account.ttsVoice) {
    body.voice = account.ttsVoice;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.bigmodelApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const preview = await responseErrorPreview(response);
    throw new Error(
      `TTS request failed with status ${response.status}${preview ? `: ${preview}` : ""}`,
    );
  }

  const finalizeAudio = (audioBytes: Buffer): Buffer => {
    if (account.ttsResponseFormat.toLowerCase() === "wav") {
      return ensureWavAudioBuffer(audioBytes);
    }
    return audioBytes;
  };

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as unknown;
    const base64Audio = extractAudioBase64(payload);
    if (!base64Audio) {
      throw new Error("TTS JSON response did not contain audio bytes.");
    }
    return finalizeAudio(Buffer.from(base64Audio, "base64"));
  }

  const bytes = await response.arrayBuffer();
  return finalizeAudio(Buffer.from(bytes));
}

type WatcherTtsMeta = {
  enabled: boolean;
  attempted: boolean;
  ok?: boolean;
  format?: string;
  mime_type?: string;
  audio_bytes?: number;
  audio_has_wav_header?: boolean;
  error?: string;
};

export type WatcherJsonResponse = {
  code: number;
  msg: string;
  data: {
    request_id: string;
    sender: string;
    sender_name?: string;
    stt_result: string;
    reply_text: string;
    reply_wav_base64?: string;
    reply_wav_mime?: string;
    reply_wav_bytes?: number;
    asr_chars: number;
    reply_chars: number;
    tts: WatcherTtsMeta;
  };
};

export function buildWatcherJsonResponse(params: {
  requestId: string;
  sender: string;
  senderName?: string;
  sttResult: string;
  replyText: string;
  tts: WatcherTtsMeta;
  replyWavBase64?: string;
  replyWavMime?: string;
  replyWavBytes?: number;
  message?: string;
}): WatcherJsonResponse {
  const {
    requestId,
    sender,
    senderName,
    sttResult,
    replyText,
    tts,
    replyWavBase64,
    replyWavMime,
    replyWavBytes,
    message,
  } = params;
  return {
    code: 200,
    msg: message ?? "",
    data: {
      request_id: requestId,
      sender,
      ...(senderName ? { sender_name: senderName } : {}),
      stt_result: sttResult,
      reply_text: replyText,
      ...(replyWavBase64 ? { reply_wav_base64: replyWavBase64 } : {}),
      ...(replyWavMime ? { reply_wav_mime: replyWavMime } : {}),
      ...(replyWavBytes !== undefined ? { reply_wav_bytes: replyWavBytes } : {}),
      asr_chars: sttResult.length,
      reply_chars: replyText.length,
      tts,
    },
  };
}

function describeWatcherResponseForLog(response: WatcherJsonResponse): string {
  const tts = response.data.tts;
  if (!response.data.reply_wav_base64 && !tts.audio_bytes) {
    return JSON.stringify(response);
  }

  const safeTts = {
    ...tts,
  };
  const safeData: Record<string, unknown> = {
    ...response.data,
    tts: safeTts,
  };

  if (response.data.reply_wav_base64) {
    safeData.reply_wav_base64 = `[base64:${response.data.reply_wav_base64.length} chars]`;
  }

  return JSON.stringify({
    ...response,
    data: safeData,
  });
}

function resolveTtsMimeType(format: string, hasWavHeader: boolean): string {
  if (hasWavHeader) {
    return "audio/wav";
  }
  if (format === "mp3") {
    return "audio/mpeg";
  }
  if (format === "wav") {
    return "audio/wav";
  }
  return "application/octet-stream";
}

function asReadableErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildWatcherAgentPrompt(asrText: string): string {
  return `${WATCHER_ENGLISH_ONLY_INSTRUCTION}\n\nUser speech transcript:\n${asrText}`;
}

function enforceAsciiReplyText(text: string): string {
  const asciiOnly = text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "").trim();
  return asciiOnly.length > 0 ? asciiOnly : WATCHER_ASCII_FALLBACK_REPLY;
}

export function createWatcherWebhookHandler(deps: WatcherWebhookHandlerDeps) {
  const { account, deliver, log } = deps;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = createRequestId();
    const startedAt = Date.now();
    const url = new URL(req.url ?? account.webhookPath, "http://watcher.local");
    const remoteAddress = req.socket?.remoteAddress ?? "unknown";
    const safeUrl = sanitizeUrlForLog(url);
    const headersForLog = sanitizeHeadersForLog(req);
    log?.info?.(
      `watcher: inbound request id=${requestId} remote=${remoteAddress} method=${req.method ?? "unknown"} url=${safeUrl} headers=${JSON.stringify(headersForLog)}`,
    );

    const finishLog = (status: number, note: string) => {
      const elapsedMs = Date.now() - startedAt;
      log?.info?.(
        `watcher: request id=${requestId} status=${status} elapsedMs=${elapsedMs} ${note}`,
      );
    };

    const sendWatcherResponseWithLog = (params: {
      statusCode?: number;
      response: WatcherJsonResponse;
    }) => {
      log?.info?.(
        `watcher: request id=${requestId} response=${describeWatcherResponseForLog(params.response)}`,
      );
      responseJson(res, params.statusCode ?? 200, params.response);
    };

    if (req.method !== "POST") {
      finishLog(405, "rejected: method must be POST");
      responseJson(res, 405, { error: "Method not allowed. Use POST." });
      return;
    }

    const suppliedToken =
      getHeader(req, "x-watcher-token") ??
      getHeader(req, "x-openclaw-watcher-token") ??
      getBearerToken(req) ??
      url.searchParams.get("token")?.trim();
    if (account.webhookToken && suppliedToken !== account.webhookToken) {
      finishLog(401, "rejected: token mismatch");
      responseJson(res, 401, { error: "Invalid watcher webhook token." });
      return;
    }

    const { from, senderName } = resolveSender(req, account, url);
    if (!isSenderAllowed(from, account)) {
      finishLog(403, `rejected: sender=${from} policy=${account.dmPolicy}`);
      responseJson(res, 403, {
        error:
          account.dmPolicy === "disabled"
            ? "Watcher channel is disabled by dmPolicy=disabled."
            : "Sender is not in channels.watcher.allowFrom.",
      });
      return;
    }

    try {
      const rawAudio = await readBody(req, account.maxAudioBytes);
      const contentType = getHeader(req, "content-type");
      log?.info?.(
        `watcher: request id=${requestId} body=${describeBodyForLog(rawAudio, contentType)}`,
      );
      if (rawAudio.length === 0) {
        finishLog(400, "rejected: empty body");
        responseJson(res, 400, { error: "Audio stream body is empty." });
        return;
      }
      const audioWav = ensureWavAudioBuffer(rawAudio);
      const timeoutSignal = AbortSignal.timeout(account.requestTimeoutMs);
      const asrText = (
        await requestBigmodelAsr({
          account,
          audioWav,
          signal: timeoutSignal,
        })
      ).trim();

      if (!asrText) {
        finishLog(200, "asr returned empty transcript");
        sendWatcherResponseWithLog({
          response: buildWatcherJsonResponse({
            requestId,
            sender: from,
            senderName,
            sttResult: "",
            replyText: "I could not recognize your voice input.",
            tts: { enabled: account.ttsEnabled, attempted: false },
          }),
        });
        return;
      }

      log?.info?.(`watcher: request id=${requestId} ASR from ${from}: ${asrText.slice(0, 120)}`);

      const replyText = await deliver({
        body: buildWatcherAgentPrompt(asrText),
        from,
        senderName,
        sessionKey: `watcher-${from}`,
        accountId: account.accountId,
      });

      const rawScreenText = (replyText?.trim() ?? asrText).trim();
      const screenText = enforceAsciiReplyText(rawScreenText);
      if (screenText !== rawScreenText) {
        log?.warn?.(`watcher: request id=${requestId} non-ASCII reply text was sanitized`);
      }
      const ttsMeta: WatcherTtsMeta = {
        enabled: account.ttsEnabled,
        attempted: false,
      };
      let replyWavBase64: string | undefined;
      let replyWavBytes: number | undefined;
      let replyWavMime: string | undefined;

      if (account.ttsEnabled && screenText.length > 0) {
        try {
          const ttsResponseFormat = account.ttsResponseFormat.trim().toLowerCase();
          let ttsAudio = await requestBigmodelTts({
            account,
            text: screenText,
            signal: timeoutSignal,
          });
          if (ttsResponseFormat === "wav") {
            ttsAudio = ensureWavAudioBuffer(ttsAudio);
          }
          const wavHeader = hasWavHeader(ttsAudio);
          const ttsBase64 = ttsAudio.toString("base64");
          ttsMeta.attempted = true;
          ttsMeta.ok = true;
          ttsMeta.format = ttsResponseFormat;
          ttsMeta.mime_type = resolveTtsMimeType(ttsResponseFormat, wavHeader);
          ttsMeta.audio_bytes = ttsAudio.length;
          ttsMeta.audio_has_wav_header = wavHeader;

          if (wavHeader) {
            replyWavBase64 = ttsBase64;
            replyWavBytes = ttsAudio.length;
            replyWavMime = "audio/wav";
          }
        } catch (error) {
          const errorMessage = asReadableErrorMessage(error);
          ttsMeta.attempted = true;
          ttsMeta.ok = false;
          ttsMeta.error = errorMessage;
          log?.warn?.(`watcher: TTS failed: ${errorMessage}`);
        }
      }

      sendWatcherResponseWithLog({
        response: buildWatcherJsonResponse({
          requestId,
          sender: from,
          senderName,
          sttResult: asrText,
          replyText: screenText,
          tts: ttsMeta,
          replyWavBase64,
          replyWavMime,
          replyWavBytes,
        }),
      });
      finishLog(
        200,
        `ok: sender=${from} asrChars=${asrText.length} replyChars=${screenText.length}`,
      );
    } catch (error) {
      const message = asReadableErrorMessage(error);
      log?.error?.(`watcher: request id=${requestId} failed: ${message}`);
      sendWatcherResponseWithLog({
        statusCode: 500,
        response: buildWatcherJsonResponse({
          requestId,
          sender: from,
          senderName,
          sttResult: "",
          replyText: "",
          tts: {
            enabled: account.ttsEnabled,
            attempted: false,
            error: message,
          },
          message: `Watcher bridge error: ${message}`,
        }),
      });
      finishLog(500, "error response sent");
    }
  };
}

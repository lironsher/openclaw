import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedWatcherAccount, WatcherDmPolicy } from "./types.js";

const DEFAULT_WEBHOOK_PATH = "/v2/watcher/talk/audio_stream";
const DEFAULT_FROM = "watcher";
const DEFAULT_SENDER_ID_HEADER = "x-watcher-device-id";
const DEFAULT_SENDER_NAME_HEADER = "x-watcher-device-name";
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const DEFAULT_BIGMODEL_BASE_URL = "https://open.bigmodel.cn";
const DEFAULT_ASR_MODEL = "glm-asr-2512";
const DEFAULT_TTS_MODEL = "glm-tts";
const DEFAULT_TTS_RESPONSE_FORMAT = "wav";
const DEFAULT_TTS_SPEED = 1;

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== "boolean") {
    return fallback;
  }
  return value;
}

function normalizeWebhookPath(pathValue: unknown): string {
  const raw = readString(pathValue) ?? DEFAULT_WEBHOOK_PATH;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeBaseUrl(value: unknown): string {
  const raw = readString(value) ?? DEFAULT_BIGMODEL_BASE_URL;
  return raw.replace(/\/+$/g, "");
}

function normalizeAllowFrom(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
    .filter(Boolean);
}

function normalizeDmPolicy(value: unknown): WatcherDmPolicy {
  if (value === "open" || value === "allowlist" || value === "disabled") {
    return value;
  }
  return "open";
}

function resolveWatcherChannelConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const channelConfig = cfg.channels?.watcher;
  if (!channelConfig || typeof channelConfig !== "object") {
    return {};
  }
  return channelConfig as Record<string, unknown>;
}

export function listWatcherAccountIds(_cfg: OpenClawConfig): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveWatcherAccount(cfg: OpenClawConfig): ResolvedWatcherAccount {
  const channelConfig = resolveWatcherChannelConfig(cfg);
  const apiKeyFromConfig = readString(channelConfig.bigmodelApiKey);
  const apiKeyFromEnv = readString(process.env.BIGMODEL_API_KEY);

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: readBoolean(channelConfig.enabled, false),
    webhookPath: normalizeWebhookPath(channelConfig.webhookPath),
    webhookToken: readString(channelConfig.webhookToken),
    defaultFrom: readString(channelConfig.defaultFrom) ?? DEFAULT_FROM,
    senderIdHeader: (
      readString(channelConfig.senderIdHeader) ?? DEFAULT_SENDER_ID_HEADER
    ).toLowerCase(),
    senderNameHeader: (
      readString(channelConfig.senderNameHeader) ?? DEFAULT_SENDER_NAME_HEADER
    ).toLowerCase(),
    dmPolicy: normalizeDmPolicy(channelConfig.dmPolicy),
    allowFrom: normalizeAllowFrom(channelConfig.allowFrom),
    requestTimeoutMs: readNumber(channelConfig.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    maxAudioBytes: readNumber(channelConfig.maxAudioBytes, DEFAULT_MAX_AUDIO_BYTES),
    bigmodelApiKey: apiKeyFromConfig ?? apiKeyFromEnv ?? "",
    bigmodelBaseUrl: normalizeBaseUrl(channelConfig.bigmodelBaseUrl),
    asrModel: readString(channelConfig.asrModel) ?? DEFAULT_ASR_MODEL,
    asrLanguage: readString(channelConfig.asrLanguage),
    asrPrompt: readString(channelConfig.asrPrompt),
    ttsEnabled: readBoolean(channelConfig.ttsEnabled, true),
    ttsModel: readString(channelConfig.ttsModel) ?? DEFAULT_TTS_MODEL,
    ttsVoice: readString(channelConfig.ttsVoice),
    ttsResponseFormat: readString(channelConfig.ttsResponseFormat) ?? DEFAULT_TTS_RESPONSE_FORMAT,
    ttsSpeed: readNumber(channelConfig.ttsSpeed, DEFAULT_TTS_SPEED),
    ttsPrompt: readString(channelConfig.ttsPrompt),
    debugPrompts: readBoolean(channelConfig.debugPrompts, true),
  };
}

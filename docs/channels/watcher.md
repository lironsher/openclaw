---
summary: "Integrate Watcher webhook audio with OpenClaw and receive reply text + WAV separately in JSON"
read_when:
  - You are building a proxy/service between Watcher and OpenClaw
  - You need to read reply text and WAV separately from the response
title: "Watcher"
---

# Watcher

`watcher` is a webhook voice channel plugin for Seeed Watcher devices.
It accepts raw audio input, runs ASR + agent reply, and returns a **JSON response**
that separates:

- reply text (`data.reply_text`)
- optional WAV audio (`data.reply_wav_base64`)

This is useful when your own service handles final device-side protocol packaging.

## Protocol Overview

- Inbound: `POST /v2/watcher/talk/audio_stream` with audio bytes.
- Outbound: `application/json` (not binary boundary payload).

Pipeline:

1. Receive audio stream.
2. Normalize to WAV when needed.
3. Call BigModel ASR to get transcript.
4. Dispatch transcript to OpenClaw agent.
5. Dispatch the ASR transcript to OpenClaw without extra Watcher-specific prompt injection.
6. (Optional) Call BigModel TTS.
7. Return JSON with text and optional WAV base64.

## Response Contract

Successful responses use HTTP `200` and JSON:

```json
{
  "code": 200,
  "msg": "",
  "data": {
    "request_id": "k9",
    "sender": "test-device",
    "sender_name": "watcher-01",
    "stt_result": "hello",
    "reply_text": "Hello there.",
    "reply_wav_base64": "UklGRiQAAABXQVZFZm10IBAAAAABAAEA...",
    "reply_wav_mime": "audio/wav",
    "reply_wav_bytes": 48236,
    "asr_chars": 5,
    "reply_chars": 12,
    "tts": {
      "enabled": true,
      "attempted": true,
      "ok": true,
      "format": "wav",
      "mime_type": "audio/wav",
      "audio_bytes": 48236,
      "audio_has_wav_header": true
    }
  }
}
```

On failures, HTTP is `500` and `msg` contains the bridge error; `data.tts.error` may also be set.

## Receiver Integration

### Read reply text

Use:

- `data.reply_text` as the final reply text
- `data.stt_result` as ASR transcript for debugging/audit

### Read WAV audio separately

If `data.reply_wav_base64` exists:

1. Base64-decode it.
2. Save/play as `.wav` (`data.reply_wav_mime` is `audio/wav`).

If missing, treat as no-audio case (TTS disabled, empty reply, or TTS failure).

### Example decode

```bash
curl -sS \
  -X POST "http://127.0.0.1:18789/v2/watcher/talk/audio_stream?sender=test-device&token=your-shared-token" \
  --data-binary @sample.pcm \
  > watcher-response.json

jq -r '.data.reply_text' watcher-response.json
jq -r '.data.reply_wav_base64 // empty' watcher-response.json | base64 -d > reply.wav
```

## OpenClaw Config (Recommended)

```yaml
channels:
  watcher:
    enabled: true
    webhookPath: /v2/watcher/talk/audio_stream
    webhookToken: your-shared-token

    bigmodelApiKey: YOUR_BIGMODEL_API_KEY
    bigmodelBaseUrl: https://open.bigmodel.cn
    asrModel: glm-asr-2512
    asrLanguage: zh

    ttsEnabled: true
    ttsModel: glm-tts
    ttsVoice: female
    ttsResponseFormat: wav
    ttsSpeed: 1.0
```

## Config Reference

- `enabled`: enable watcher channel.
- `webhookPath`: webhook route path (default `/v2/watcher/talk/audio_stream`).
- `webhookToken`: optional shared secret for webhook auth.
- `bigmodelApiKey`: BigModel API key (or use `BIGMODEL_API_KEY` env).
- `bigmodelBaseUrl`: API base URL (default `https://open.bigmodel.cn`).
- `asrModel`: ASR model id (default `glm-asr-2512`).
- `asrLanguage`: optional language hint for ASR.
- `asrPrompt`: optional ASR prompt.
- `ttsEnabled`: enable speech output (default `true`).
- `ttsModel`: TTS model id (default `glm-tts`).
- `ttsVoice`: optional voice id.
- `ttsResponseFormat`: `pcm` | `wav` | `mp3` (default `wav`).
- `ttsSpeed`: speech speed, range `0.5` to `2.0`.
- `ttsPrompt`: optional TTS prompt.
- `debugPrompts`: log agent prompt + reply previews for Watcher requests (default `true`).
- `dmPolicy`: `open` | `allowlist` | `disabled`.
- `allowFrom`: allowed sender ids when `dmPolicy=allowlist`.
- `senderIdHeader`: header name for sender id (default `x-watcher-device-id`).
- `senderNameHeader`: header name for sender name (default `x-watcher-device-name`).
- `requestTimeoutMs`: ASR/TTS timeout budget per request.
- `maxAudioBytes`: max incoming audio payload size.

## Notes

- Reply text is produced directly from the OpenClaw agent using the ASR transcript as the inbound message body.
- If TTS succeeds with WAV output, you can consume `reply_wav_base64` directly.
- If TTS fails, text still returns normally and `tts.error` is populated.

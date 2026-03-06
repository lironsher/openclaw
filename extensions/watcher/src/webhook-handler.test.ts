import { describe, expect, it } from "vitest";
import {
  buildWatcherJsonResponse,
  ensureWavAudioBuffer,
  hasWavHeader,
} from "./webhook-handler.js";

describe("watcher webhook helpers", () => {
  it("adds wav header when raw pcm bytes are provided", () => {
    const rawPcm = Buffer.alloc(320, 1);
    const wav = ensureWavAudioBuffer(rawPcm);
    expect(hasWavHeader(wav)).toBe(true);
    expect(wav.length).toBe(rawPcm.length + 44);
  });

  it("keeps existing wav payload unchanged", () => {
    const withHeader = Buffer.concat([Buffer.from("RIFFxxxxWAVE", "ascii"), Buffer.alloc(200)]);
    const result = ensureWavAudioBuffer(withHeader);
    expect(result).toBe(withHeader);
  });

  it("builds watcher json response payload", () => {
    const response = buildWatcherJsonResponse({
      requestId: "abc123",
      sender: "test-device",
      senderName: "test-name",
      sttResult: "voice",
      replyText: "hello",
      tts: { enabled: false, attempted: false },
      replyWavBase64: "UklG...",
      replyWavMime: "audio/wav",
      replyWavBytes: 1234,
    });

    expect(response.code).toBe(200);
    expect(response.msg).toBe("");
    expect(response.data.request_id).toBe("abc123");
    expect(response.data.sender).toBe("test-device");
    expect(response.data.sender_name).toBe("test-name");
    expect(response.data.stt_result).toBe("voice");
    expect(response.data.reply_text).toBe("hello");
    expect(response.data.reply_wav_base64).toBe("UklG...");
    expect(response.data.reply_wav_mime).toBe("audio/wav");
    expect(response.data.reply_wav_bytes).toBe(1234);
    expect(response.data.asr_chars).toBe(5);
    expect(response.data.reply_chars).toBe(5);
    expect(response.data.tts.enabled).toBe(false);
    expect(response.data.tts.attempted).toBe(false);
  });

  // Text shaping rules are device-side; watcher returns raw text as-is.
});

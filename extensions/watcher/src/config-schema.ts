import { z } from "zod";

const WatcherDmPolicySchema = z.enum(["open", "allowlist", "disabled"]);
const WatcherTtsResponseFormatSchema = z.enum(["pcm", "wav", "mp3"]);

export const WatcherConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    webhookPath: z.string().optional(),
    webhookToken: z.string().optional(),
    defaultFrom: z.string().optional(),
    senderIdHeader: z.string().optional(),
    senderNameHeader: z.string().optional(),
    dmPolicy: WatcherDmPolicySchema.optional(),
    allowFrom: z.array(z.string()).optional(),
    requestTimeoutMs: z.number().int().min(1_000).max(180_000).optional(),
    maxAudioBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(20 * 1024 * 1024)
      .optional(),
    bigmodelApiKey: z.string().optional(),
    bigmodelBaseUrl: z.string().optional(),
    asrModel: z.string().optional(),
    asrLanguage: z.string().optional(),
    asrPrompt: z.string().optional(),
    ttsEnabled: z.boolean().optional(),
    ttsModel: z.string().optional(),
    ttsVoice: z.string().optional(),
    ttsResponseFormat: WatcherTtsResponseFormatSchema.optional(),
    ttsSpeed: z.number().min(0.5).max(2.0).optional(),
    ttsPrompt: z.string().optional(),
    debugPrompts: z.boolean().optional(),
  })
  .passthrough();

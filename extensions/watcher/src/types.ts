export type WatcherDmPolicy = "open" | "allowlist" | "disabled";

export type ResolvedWatcherAccount = {
  accountId: string;
  enabled: boolean;
  webhookPath: string;
  webhookToken?: string;
  defaultFrom: string;
  senderIdHeader: string;
  senderNameHeader: string;
  dmPolicy: WatcherDmPolicy;
  allowFrom: string[];
  requestTimeoutMs: number;
  maxAudioBytes: number;
  bigmodelApiKey: string;
  bigmodelBaseUrl: string;
  asrModel: string;
  asrLanguage?: string;
  asrPrompt?: string;
  ttsEnabled: boolean;
  ttsModel: string;
  ttsVoice?: string;
  ttsResponseFormat: string;
  ttsSpeed: number;
  ttsPrompt?: string;
  debugPrompts: boolean;
};

export type WatcherInboundMessage = {
  body: string;
  from: string;
  senderName?: string;
  sessionKey: string;
  accountId: string;
};

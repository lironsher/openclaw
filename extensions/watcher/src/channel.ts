import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk";
import { listWatcherAccountIds, resolveWatcherAccount } from "./accounts.js";
import { WatcherConfigSchema } from "./config-schema.js";
import { getWatcherRuntime } from "./runtime.js";
import type { ResolvedWatcherAccount, WatcherInboundMessage } from "./types.js";
import { createWatcherWebhookHandler } from "./webhook-handler.js";

const CHANNEL_ID = "watcher";
const WatcherChannelConfigSchema = buildChannelConfigSchema(WatcherConfigSchema);

const activeRouteUnregisters = new Map<string, () => void>();

function waitForWatcherAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise<void>(() => {});
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function extractReplyText(payload: {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
}): string {
  const parts: string[] = [];
  const text = payload.text?.trim();
  if (text) {
    parts.push(text);
  }
  if (payload.mediaUrl) {
    parts.push(`Attachment: ${payload.mediaUrl}`);
  }
  if (payload.mediaUrls?.length) {
    for (const mediaUrl of payload.mediaUrls) {
      if (mediaUrl) {
        parts.push(`Attachment: ${mediaUrl}`);
      }
    }
  }
  return parts.join("\n").trim();
}

function setWatcherEnabled(cfg: OpenClawConfig, enabled: boolean): OpenClawConfig {
  const channelConfig =
    cfg.channels?.watcher && typeof cfg.channels.watcher === "object"
      ? (cfg.channels.watcher as Record<string, unknown>)
      : {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      watcher: {
        ...channelConfig,
        enabled,
      },
    },
  };
}

async function dispatchWatcherInbound(
  account: ResolvedWatcherAccount,
  inbound: WatcherInboundMessage,
): Promise<string | null> {
  const runtime = getWatcherRuntime();
  const cfg = (await runtime.config.loadConfig()) as OpenClawConfig;

  const msgCtx = runtime.channel.reply.finalizeInboundContext({
    Body: inbound.body,
    BodyForAgent: inbound.body,
    RawBody: inbound.body,
    CommandBody: inbound.body,
    From: inbound.from,
    To: account.defaultFrom,
    SessionKey: inbound.sessionKey,
    AccountId: account.accountId,
    ChatType: "direct",
    SenderId: inbound.from,
    SenderName: inbound.senderName,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: inbound.from,
  });

  const finalReplies: string[] = [];
  const blocks: string[] = [];

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        const text = extractReplyText(payload);
        if (!text) {
          return;
        }
        if (info.kind === "final") {
          finalReplies.push(text);
          return;
        }
        blocks.push(text);
      },
    },
  });

  const latestFinal = finalReplies[finalReplies.length - 1]?.trim();
  if (latestFinal) {
    return latestFinal;
  }
  const mergedBlocks = blocks.join("\n\n").trim();
  return mergedBlocks.length > 0 ? mergedBlocks : null;
}

export const watcherPlugin: ChannelPlugin<ResolvedWatcherAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Watcher",
    selectionLabel: "Watcher (SenseCraft Private AI Service)",
    detailLabel: "Watcher (SenseCraft Private AI Service)",
    docsPath: "/channels/watcher",
    docsLabel: "watcher",
    blurb: "Webhook bridge for Watcher voice requests with built-in BigModel ASR + TTS.",
    order: 95,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    threads: false,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    effects: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.watcher"] },
  configSchema: WatcherChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listWatcherAccountIds(cfg as OpenClawConfig),
    resolveAccount: (cfg) => resolveWatcherAccount(cfg as OpenClawConfig),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => setWatcherEnabled(cfg as OpenClawConfig, enabled),
    isConfigured: (account) => Boolean(account.bigmodelApiKey.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.bigmodelApiKey.trim()),
      webhookPath: account.webhookPath,
      dmPolicy: account.dmPolicy,
    }),
    resolveAllowFrom: ({ cfg }) => resolveWatcherAccount(cfg as OpenClawConfig).allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter(Boolean),
  },
  pairing: {
    idLabel: "watcherSenderId",
    normalizeAllowEntry: (entry) => entry.trim().toLowerCase(),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.dmPolicy,
      allowFrom: account.allowFrom,
      policyPath: "channels.watcher.dmPolicy",
      allowFromPath: "channels.watcher.allowFrom",
      approveHint: "openclaw pairing approve watcher <code>",
      normalizeEntry: (raw) => raw.trim().toLowerCase(),
    }),
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      if (!account.bigmodelApiKey.trim()) {
        warnings.push(
          "- Watcher: bigmodelApiKey is missing (or BIGMODEL_API_KEY env is unset). ASR/TTS requests will fail.",
        );
      }
      if (account.dmPolicy === "allowlist" && account.allowFrom.length === 0) {
        warnings.push(
          '- Watcher: dmPolicy="allowlist" with empty allowFrom will block all senders.',
        );
      }
      return warnings;
    },
  },
  messaging: {
    normalizeTarget: (target) => target.replace(/^watcher:/i, "").trim() || undefined,
    targetResolver: {
      looksLikeId: (id) => Boolean(id.trim()),
      hint: "<watcherSenderId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  gateway: {
    startAccount: async ({ cfg, accountId, abortSignal, log }) => {
      const account = resolveWatcherAccount(cfg as OpenClawConfig);
      if (!account.enabled) {
        log?.info?.(`Watcher account ${accountId} is disabled, skipping.`);
        return { stop: () => {} };
      }

      const handler = createWatcherWebhookHandler({
        account,
        deliver: async (message) => dispatchWatcherInbound(account, message),
        log,
      });

      const routeKey = `${accountId}:${account.webhookPath}`;
      const previousRoute = activeRouteUnregisters.get(routeKey);
      if (previousRoute) {
        previousRoute();
        activeRouteUnregisters.delete(routeKey);
      }

      const unregister = registerPluginHttpRoute({
        path: account.webhookPath,
        pluginId: CHANNEL_ID,
        accountId: account.accountId,
        handler,
        log: (message) => log?.info?.(message),
      });
      activeRouteUnregisters.set(routeKey, unregister);
      log?.info?.(
        `Watcher webhook registered at ${account.webhookPath} (account: ${account.accountId}).`,
      );
      log?.info?.(
        `Watcher lifecycle hold armed (account: ${account.accountId}, abortSignalPresent=${abortSignal ? "yes" : "no"}, abortSignalAborted=${abortSignal?.aborted ? "yes" : "no"})`,
      );

      // Keep webhook channels alive for the account lifecycle.
      await waitForWatcherAbort(abortSignal);
      log?.info?.(`Watcher lifecycle hold released (account: ${account.accountId}).`);
      unregister();
      activeRouteUnregisters.delete(routeKey);
      log?.info?.(`Watcher account ${accountId} stopped.`);
    },
    stopAccount: async ({ cfg, accountId, log }) => {
      const account = resolveWatcherAccount(cfg as OpenClawConfig);
      const routeKey = `${accountId}:${account.webhookPath}`;
      const unregister = activeRouteUnregisters.get(routeKey);
      if (unregister) {
        unregister();
        activeRouteUnregisters.delete(routeKey);
      }
      log?.info?.(`Watcher account ${accountId} stopped.`);
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "",
      "### Watcher Voice Reply Hints",
      "- Keep replies concise and easy to speak.",
      "- Prefer short sentences over long paragraphs.",
      "- Avoid heavy markdown formatting in responses.",
    ],
  },
};

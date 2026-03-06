import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { watcherPlugin } from "./src/channel.js";
import { setWatcherRuntime } from "./src/runtime.js";

const plugin = {
  id: "watcher",
  name: "Watcher",
  description: "Watcher audio webhook channel plugin for OpenClaw",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWatcherRuntime(api.runtime);
    api.registerChannel({ plugin: watcherPlugin });
  },
};

export default plugin;

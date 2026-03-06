import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setWatcherRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getWatcherRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Watcher runtime not initialized");
  }
  return runtime;
}

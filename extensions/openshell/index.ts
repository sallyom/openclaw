// Openshell plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  createOpenShellSandboxBackendFactory,
  createOpenShellSandboxBackendManager,
} from "./src/backend.js";
import { createOpenShellPluginConfigSchema, resolveOpenShellPluginConfig } from "./src/config.js";
import { createOpenShellWorkerProvider } from "./src/worker-provider.js";

export default definePluginEntry({
  id: "openshell",
  name: "OpenShell Sandbox and Worker",
  description: "OpenShell-backed tool sandbox and per-session cloud worker provider.",
  configSchema: createOpenShellPluginConfigSchema(),
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const pluginConfig = resolveOpenShellPluginConfig(api.pluginConfig);
    api.registerWorkerProvider(createOpenShellWorkerProvider());
    registerSandboxBackend("openshell", {
      factory: createOpenShellSandboxBackendFactory({
        pluginConfig,
      }),
      manager: createOpenShellSandboxBackendManager({
        pluginConfig,
      }),
      resolveWorkdir: () => pluginConfig.remoteWorkspaceDir,
    });
  },
});

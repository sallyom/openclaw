import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

// Use MLflow TypeScript SDK with correct session/user metadata fields
import { createDiagnosticsMlflowService, getMLflowTraceContext } from "./src/service.js";

const plugin = {
  id: "diagnostics-mlflow",
  name: "Diagnostics MLFlow",
  description: "Export diagnostics events to MLFlow for LLM experiment tracking",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(createDiagnosticsMlflowService());
  },
};

export default plugin;

// Export trace context helper for external service integration (e.g., vLLM)
export { getMLflowTraceContext };

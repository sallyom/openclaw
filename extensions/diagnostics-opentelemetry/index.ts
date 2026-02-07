import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
// OpenTelemetry OTLP integration - exports traces to OTLP endpoints (MLflow, Jaeger, etc.)
import { createDiagnosticsOtelService, getOtelTraceContext } from "./src/service-otel.js";

const plugin = {
  id: "diagnostics-opentelemetry",
  name: "Diagnostics OpenTelemetry",
  description:
    "Export diagnostics events via OpenTelemetry Protocol (OTLP) to observability platforms",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(createDiagnosticsOtelService());
  },
};

export default plugin;

// Export trace context helper for external service integration (e.g., vLLM)
export { getOtelTraceContext };

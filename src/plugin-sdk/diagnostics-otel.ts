// Narrow plugin-sdk surface for the bundled diagnostics-otel plugin.
// Keep this list additive and scoped to the bundled diagnostics-otel surface.

export type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
export { emitDiagnosticEvent, onDiagnosticEvent } from "../infra/diagnostic-events.js";
export { registerLogTransport } from "../logging/logger.js";
export { redactSensitiveText } from "../logging/redact.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { resolveAgentIdentity } from "../agents/identity.js";
export { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
export type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "../plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";

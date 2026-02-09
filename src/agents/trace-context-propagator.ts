import type { StreamFn } from "@mariozechner/pi-agent-core";
import { context, trace, type Context } from "@opentelemetry/api";

// Global trace context registry key (shared with diagnostics-otel plugin)
const TRACE_CONTEXT_REGISTRY_KEY = Symbol.for("openclaw.diagnostics-otel.trace-contexts");

function getTraceContextFromRegistry(sessionKey: string): Context | undefined {
  const globalStore = globalThis as {
    [TRACE_CONTEXT_REGISTRY_KEY]?: Map<string, Context>;
  };
  return globalStore[TRACE_CONTEXT_REGISTRY_KEY]?.get(sessionKey);
}

/**
 * Wraps a streamFn to inject W3C Trace Context headers into outgoing LLM requests.
 * This enables distributed tracing from OpenClaw -> vLLM (or other LLM providers).
 *
 * @param streamFn - The original stream function to wrap
 * @param sessionKey - Optional session key to look up trace context from diagnostics-otel plugin
 * @returns A wrapped stream function that injects trace context headers
 */
export function wrapStreamFnWithTraceContext(streamFn: StreamFn, sessionKey?: string): StreamFn {
  return (model, messages, options) => {
    // Try to get active span from current context first
    let activeSpan = trace.getSpan(context.active());

    // Fallback: if no active span and we have a sessionKey, try to get trace context from global registry
    if (!activeSpan && sessionKey) {
      const traceContext = getTraceContextFromRegistry(sessionKey);
      if (traceContext) {
        activeSpan = trace.getSpan(traceContext);
      }
    }

    if (activeSpan) {
      const spanContext = activeSpan.spanContext();

      // Only propagate if the span context is valid and sampled
      if (spanContext.traceId && spanContext.spanId) {
        // Format W3C Trace Context traceparent header
        // Format: version-traceId-spanId-traceFlags
        // Example: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
        const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags
          .toString(16)
          .padStart(2, "0")}`;

        // Inject trace context into request headers
        const headersWithTrace = {
          ...options?.headers,
          traceparent,
          // Also add tracestate if available (for vendor-specific context)
          ...(spanContext.traceState && {
            tracestate: spanContext.traceState.serialize(),
          }),
        };

        // Call original streamFn with injected headers
        return streamFn(model, messages, {
          ...options,
          headers: headersWithTrace,
        });
      }
    }

    // No active span or invalid context - call original streamFn without modification
    return streamFn(model, messages, options);
  };
}

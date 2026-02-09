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

export function wrapStreamFnWithTraceContext(streamFn: StreamFn, sessionKey?: string): StreamFn {
  return (model, messages, options) => {
    let activeSpan = trace.getSpan(context.active());

    if (!activeSpan && sessionKey) {
      const traceContext = getTraceContextFromRegistry(sessionKey);
      if (traceContext) {
        activeSpan = trace.getSpan(traceContext);
      }
    }

    if (activeSpan) {
      const spanContext = activeSpan.spanContext();

      if (spanContext.traceId && spanContext.spanId) {
        const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags
          .toString(16)
          .padStart(2, "0")}`;

        const headersWithTrace = {
          ...options?.headers,
          traceparent,
          ...(spanContext.traceState && {
            tracestate: spanContext.traceState.serialize(),
          }),
        };

        return streamFn(model, messages, {
          ...options,
          headers: headersWithTrace,
        });
      }
    }

    return streamFn(model, messages, options);
  };
}

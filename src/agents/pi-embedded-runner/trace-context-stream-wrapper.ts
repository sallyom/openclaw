import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

type TraceHeaders = {
  traceparent: string;
  tracestate?: string;
};

const TRACE_CONTEXT_REGISTRY_KEY = Symbol.for("openclaw.diagnostics-otel.trace-headers");

function isOpenAICompatibleApi(api: unknown): boolean {
  return (
    api === "openai-completions" ||
    api === "openai-responses" ||
    api === "azure-openai-responses" ||
    api === "openai-codex-responses"
  );
}

function resolveTraceHeaders(sessionKey?: string): TraceHeaders | undefined {
  if (!sessionKey) {
    return undefined;
  }
  const globalStore = globalThis as {
    [TRACE_CONTEXT_REGISTRY_KEY]?: Map<string, TraceHeaders>;
  };
  return globalStore[TRACE_CONTEXT_REGISTRY_KEY]?.get(sessionKey);
}

export function createTraceContextHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
  sessionKey?: string,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isOpenAICompatibleApi(model?.api)) {
      return underlying(model, context, options);
    }
    const traceHeaders = resolveTraceHeaders(sessionKey);
    if (!traceHeaders) {
      return underlying(model, context, options);
    }
    return underlying(model, context, {
      ...options,
      headers: {
        ...traceHeaders,
        ...options?.headers,
      },
    });
  };
}

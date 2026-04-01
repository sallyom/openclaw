import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createTraceContextHeadersWrapper } from "./trace-context-stream-wrapper.js";

type TraceHeaders = {
  traceparent: string;
  tracestate?: string;
};

const TRACE_CONTEXT_REGISTRY_KEY = Symbol.for("openclaw.diagnostics-otel.trace-headers");

function getRegistry(): Map<string, TraceHeaders> {
  const globalStore = globalThis as {
    [TRACE_CONTEXT_REGISTRY_KEY]?: Map<string, TraceHeaders>;
  };
  if (!globalStore[TRACE_CONTEXT_REGISTRY_KEY]) {
    globalStore[TRACE_CONTEXT_REGISTRY_KEY] = new Map();
  }
  return globalStore[TRACE_CONTEXT_REGISTRY_KEY];
}

describe("trace context stream wrapper", () => {
  afterEach(() => {
    getRegistry().clear();
  });

  it("adds trace headers to OpenAI-compatible requests for the active session", () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({ headers: options?.headers });
      return createAssistantMessageEventStream();
    };

    getRegistry().set("agent:main:session", {
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      tracestate: "vendor=value",
    });

    const wrapped = createTraceContextHeadersWrapper(baseStreamFn, "agent:main:session");
    const model = {
      api: "openai-completions",
      provider: "vllm",
      id: "vllm/qwen3-coder",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void wrapped(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toEqual([
      {
        headers: {
          traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
          tracestate: "vendor=value",
          "X-Custom": "1",
        },
      },
    ]);
  });

  it("does not add trace headers to non OpenAI-compatible requests", () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({ headers: options?.headers });
      return createAssistantMessageEventStream();
    };

    getRegistry().set("agent:main:session", {
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    });

    const wrapped = createTraceContextHeadersWrapper(baseStreamFn, "agent:main:session");
    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "anthropic/sonnet-4.6",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };

    void wrapped(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toEqual([
      {
        headers: {
          "X-Custom": "1",
        },
      },
    ]);
  });
});

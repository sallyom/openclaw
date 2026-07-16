import { describe, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";

const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(() => ({ kind: "stream" })),
}));

vi.mock("../llm/stream.js", () => ({ streamSimple: mocks.streamSimple }));

import { createWorkerLocalInferenceStream } from "./local-inference.runtime.js";

describe("worker local inference", () => {
  it("uses the local model route with a non-secret placeholder credential", () => {
    const model = {
      provider: "openai",
      id: "gpt-5.4",
      name: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://inference.local/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 128_000,
    } as Model;
    const context = { messages: [] };
    const signal = new AbortController().signal;
    const stream = createWorkerLocalInferenceStream({
      model,
      options: { reasoning: "medium", maxTokens: 2_048 },
      sessionId: "session-1",
    });

    expect(stream({ context, signal })).toEqual({ kind: "stream" });
    expect(mocks.streamSimple).toHaveBeenCalledWith(model, context, {
      apiKey: "unused",
      maxTokens: 2_048,
      reasoning: "medium",
      sessionId: "session-1",
      signal,
    });
  });
});

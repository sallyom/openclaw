import type { WorkerInferenceOptions } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { mapThinkingLevel } from "../agents/embedded-agent-runner/utils.js";
import { streamSimple } from "../llm/stream.js";
import type { Context, Model, SimpleStreamOptions } from "../llm/types.js";

export function createWorkerLocalInferenceStream(params: {
  model: Model;
  options: WorkerInferenceOptions;
  sessionId: string;
}) {
  const configured = params.options;
  return (request: { context: Context; signal?: AbortSignal }) => {
    const options: SimpleStreamOptions = {
      ...(configured.temperature === undefined ? {} : { temperature: configured.temperature }),
      ...(configured.maxTokens === undefined ? {} : { maxTokens: configured.maxTokens }),
      ...(configured.reasoning === undefined
        ? {}
        : { reasoning: mapThinkingLevel(configured.reasoning) }),
      ...(configured.thinkingBudgets === undefined
        ? {}
        : { thinkingBudgets: { ...configured.thinkingBudgets } }),
      apiKey: "unused",
      sessionId: params.sessionId,
      ...(request.signal ? { signal: request.signal } : {}),
    };
    return streamSimple(params.model, request.context, options);
  };
}

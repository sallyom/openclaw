import { createNativeModelOwnedRuntimeModel } from "../agents/embedded-agent-runner/run/setup.js";
import type { Model } from "../llm/types.js";
import type { WorkerLaunchInference } from "./launch-descriptor.js";

export function createWorkerRuntimeModel(params: {
  modelRef: { provider: string; model: string };
  inference: WorkerLaunchInference;
}): Model {
  const model = createNativeModelOwnedRuntimeModel({
    provider:
      params.inference.mode === "local" ? params.inference.provider : params.modelRef.provider,
    modelId: params.inference.mode === "local" ? params.inference.model : params.modelRef.model,
  });
  if (params.inference.mode === "gateway-proxy") {
    return model;
  }
  return {
    ...model,
    api: params.inference.api,
    baseUrl: params.inference.baseUrl,
  } as Model;
}

import { describe, expect, it } from "vitest";
import { createWorkerRuntimeModel } from "./runtime-model.js";

describe("worker runtime model", () => {
  it("uses the validated local route identity instead of the requested reference", () => {
    expect(
      createWorkerRuntimeModel({
        modelRef: { provider: "wrong-provider", model: "wrong-model" },
        inference: {
          mode: "local",
          api: "anthropic-messages",
          baseUrl: "https://inference.local",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
        },
      }),
    ).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://inference.local",
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    });
  });
});

import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn(() => ({}));
const resolveDefaultAgentIdMock = vi.fn((_cfg: unknown) => "main");

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: (cfg: unknown) => resolveDefaultAgentIdMock(cfg),
}));

import { resolveGatewayRequestContext } from "./http-utils.js";

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

afterEach(() => {
  loadConfigMock.mockReset();
  resolveDefaultAgentIdMock.mockReset();
  loadConfigMock.mockReturnValue({});
  resolveDefaultAgentIdMock.mockReturnValue("main");
});

describe("resolveGatewayRequestContext", () => {
  it("uses normalized x-openclaw-message-channel when enabled", () => {
    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-message-channel": " Custom-Channel " }),
      model: "openclaw",
      sessionPrefix: "openai",
      defaultMessageChannel: "webchat",
      useMessageChannelHeader: true,
    });

    expect(result.messageChannel).toBe("custom-channel");
  });

  it("uses default messageChannel when header support is disabled", () => {
    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-message-channel": "custom-channel" }),
      model: "openclaw",
      sessionPrefix: "openresponses",
      defaultMessageChannel: "webchat",
      useMessageChannelHeader: false,
    });

    expect(result.messageChannel).toBe("webchat");
  });

  it("routes bare openclaw to the configured default agent", () => {
    loadConfigMock.mockReturnValue({
      agents: { list: [{ id: "somalley_mercury", default: true }] },
    });
    resolveDefaultAgentIdMock.mockReturnValue("somalley_mercury");

    const result = resolveGatewayRequestContext({
      req: createReq(),
      model: "openclaw",
      sessionPrefix: "openai",
      defaultMessageChannel: "webchat",
    });

    expect(result.agentId).toBe("somalley_mercury");
    expect(result.sessionKey).toContain("agent:somalley_mercury:");
  });

  it("includes session prefix and user in generated session key", () => {
    const result = resolveGatewayRequestContext({
      req: createReq(),
      model: "openclaw",
      user: "alice",
      sessionPrefix: "openresponses",
      defaultMessageChannel: "webchat",
    });

    expect(result.sessionKey).toContain("openresponses-user:alice");
  });
});

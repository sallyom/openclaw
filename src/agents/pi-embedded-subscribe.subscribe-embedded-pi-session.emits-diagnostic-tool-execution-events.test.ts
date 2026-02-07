import { describe, expect, it, vi } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

type SessionEventHandler = (evt: unknown) => void;

describe("subscribeEmbeddedPiSession", () => {
  it("emits tool.execution diagnostic event on tool_execution_end", () => {
    resetDiagnosticEventsForTest();

    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-diag-tool",
    });

    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    handler?.({
      type: "tool_execution_start",
      toolName: "web_search",
      toolCallId: "call-diag-1",
      args: { query: "test" },
    });

    handler?.({
      type: "tool_execution_end",
      toolName: "web_search",
      toolCallId: "call-diag-1",
      isError: false,
      result: { output: "search results" },
    });

    unsub();

    const toolEvents = events.filter((e) => e.type === "tool.execution");
    expect(toolEvents).toHaveLength(1);

    const evt = toolEvents[0];
    expect(evt.toolName).toBe("web_search");
    expect(evt.toolCallId).toBe("call-diag-1");
    expect(evt.toolType).toBe("function");
    expect(evt.durationMs).toBeTypeOf("number");
    expect(evt.durationMs).toBeGreaterThanOrEqual(0);
    expect(evt.error).toBeUndefined();
  });

  it("emits tool.execution with error when tool fails", () => {
    resetDiagnosticEventsForTest();

    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-diag-tool-err",
    });

    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    handler?.({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "call-diag-err",
      args: { command: "failing-cmd" },
    });

    handler?.({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "call-diag-err",
      isError: true,
      result: { details: { error: "command not found" } },
    });

    unsub();

    const toolEvents = events.filter((e) => e.type === "tool.execution");
    expect(toolEvents).toHaveLength(1);

    const evt = toolEvents[0];
    expect(evt.toolName).toBe("exec");
    expect(evt.error).toBe("command not found");
  });

  it("records durationMs from tool start to end", () => {
    resetDiagnosticEventsForTest();

    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-diag-timing",
    });

    const events: DiagnosticEventPayload[] = [];
    const unsub = onDiagnosticEvent((evt) => events.push(evt));

    vi.useFakeTimers();
    try {
      handler?.({
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "call-timing",
        args: { path: "/tmp/test" },
      });

      vi.advanceTimersByTime(150);

      handler?.({
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "call-timing",
        isError: false,
        result: "file contents",
      });
    } finally {
      vi.useRealTimers();
    }

    unsub();

    const evt = events.find((e) => e.type === "tool.execution");
    expect(evt.durationMs).toBe(150);
  });
});

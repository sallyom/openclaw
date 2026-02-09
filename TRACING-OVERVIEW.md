# OpenClaw Distributed Tracing Overview

This document describes the OpenTelemetry instrumentation added to OpenClaw for distributed tracing and observability.

## What We Instrumented

OpenClaw now emits OpenTelemetry traces that capture the full lifecycle of agent interactions:

- **Message processing** from incoming requests (WhatsApp, cron jobs, etc.)
- **LLM API calls** to inference providers (vLLM, OpenAI, etc.)
- **Tool executions** (read, exec, write, etc.)
- **Distributed tracing** with W3C Trace Context propagation to downstream services

All traces are exported to an OTLP endpoint (MLflow in our deployment) for visualization and analysis.

---

## High-Level Architecture Flow

When a message arrives at OpenClaw:

```
1. Message arrives (WhatsApp webhook, cron trigger, etc.)
   ↓
2. Message queued in processing lane
   ↓ [ROOT SPAN STARTS HERE]
3. Agent processes message
   ↓ [LLM SPAN]
4. LLM generates response with tool calls
   ↓ [TOOL SPANS]
5. Tools execute (read files, run commands, etc.)
   ↓
6. Agent finalizes response
   ↓ [ROOT SPAN ENDS HERE]
7. Response delivered to user
```

---

## Trace Hierarchy

We create a **nested span hierarchy** that mirrors the logical flow:

```
message.process (root span)
├── llm_request (vLLM span via W3C propagation)
│   └── llm.nerc.openai/gpt-oss-20b (OpenClaw LLM span)
├── tool.read (tool span)
├── tool.exec (tool span)
└── tool.write (tool span)
```

### Root Span: `message.process`

- **When**: Created when a message is queued for processing
- **Where**: `src/logging/diagnostic.ts` → `logMessageQueued()`
- **Captured by**: `extensions/diagnostics-otel/src/service.ts` → `recordMessageQueued()`
- **Attributes**: session key, agent ID, channel, queue depth
- **Ends**: When message processing completes or errors

### LLM Spans

- **When**: Created when model usage is recorded
- **Where**: `src/auto-reply/reply/agent-runner.ts` → emits `model.usage` diagnostic event
- **Captured by**: `extensions/diagnostics-otel/src/service.ts` → `recordModelUsage()`
- **Attributes**: provider, model, tokens (input/output/cache), cost, prompt, completion
- **Special**: Also sets prompt/completion on root span for MLflow UI compatibility

### Tool Spans

- **When**: Created when tools finish execution
- **Where**: `src/agents/pi-embedded-subscribe.handlers.tools.ts` → `handleToolExecutionEnd()` emits `tool.execution`
- **Captured by**: `extensions/diagnostics-otel/src/service.ts` → `recordToolExecution()`
- **Attributes**: tool name, tool type, tool call ID, duration, error (if any)
- **Nested under**: Root span using `trace.setSpan()` and parent context

---

## Code Locations

### 1. Diagnostic Events (Core Instrumentation)

**Message lifecycle events:**

- `src/logging/diagnostic.ts`
  - `logMessageQueued()` - emits `message.queued` event
  - `logMessageProcessed()` - emits `message.processed` event

**Model usage events:**

- `src/auto-reply/reply/agent-runner.ts` (lines 456-482)
  - Emits `model.usage` with tokens, cost, prompt, completion

**Tool execution events:**

- `src/agents/pi-embedded-subscribe.handlers.tools.ts` (lines 221-234)
  - Emits `tool.execution` with sessionKey, duration, error

**Cron job instrumentation:**

- `src/cron/isolated-agent/run.ts`
  - Emits `message.queued` before agent run (line 375-382)
  - Emits `message.processed` after completion/error (lines 435-456)

### 2. OpenTelemetry Plugin (Span Creation)

**Location:** `extensions/diagnostics-otel/src/service.ts`

**Root span creation:**

- `recordMessageQueued()` (lines ~823-890)
  - Creates `message.process` span with `SpanKind.SERVER`
  - Stores in `activeTraces` map by sessionKey
  - Creates trace context for W3C propagation

**LLM span creation:**

- `recordModelUsage()` (lines ~661-720)
  - Creates nested `llm.{provider}.{model}` span
  - Sets GenAI semantic convention attributes
  - Sets prompt/completion on root span for MLflow

**Tool span creation:**

- `recordToolExecution()` (lines 1006-1080)
  - Looks up activeTrace by sessionKey
  - Creates nested `tool.{toolName}` span with parent context
  - Falls back to standalone span if no activeTrace found

**Root span completion:**

- `recordMessageProcessed()` (lines ~903-930)
  - Sets span status (OK or ERROR)
  - Ends root span
  - Removes from activeTraces map

### 3. Session Context Propagation

**Agent run context registration:**

- `src/infra/agent-events.ts`
  - `registerAgentRunContext()` - stores sessionKey per runId
  - `emitAgentEvent()` - enriches events with sessionKey from context

**Session parameters flow:**

- `src/agents/pi-embedded-runner/run/attempt.ts` (lines 626-644)
  - Passes sessionKey, sessionId, channel to `subscribeEmbeddedPiSession()`

- `src/agents/pi-embedded-subscribe.types.ts` (lines 7-12)
  - Added sessionKey, sessionId, channel to params

- `src/agents/pi-embedded-subscribe.handlers.tools.ts` (lines 229-231)
  - Includes sessionKey in tool.execution events

---

## W3C Trace Context Propagation

We inject W3C Trace Context headers into outgoing LLM requests to enable distributed tracing across service boundaries.

### How It Works

1. **Global registry** stores active trace contexts by sessionKey
   - `extensions/diagnostics-otel/src/service.ts` (lines 80-100)
   - Uses `Symbol.for()` for cross-module access

2. **Trace context wrapper** injects headers into LLM requests
   - `src/agents/trace-context-propagator.ts`
   - Wraps `streamFn` to inject `traceparent` and `tracestate` headers
   - Looks up trace context from global registry using sessionKey

3. **Applied during agent run**
   - `src/agents/pi-embedded-runner/run/attempt.ts` (lines 519-522)
   - `wrapStreamFnWithTraceContext(streamFn, sessionKey)`

### Result

When OpenClaw calls vLLM (or other LLM providers), the request includes:

```
traceparent: 00-<traceId>-<spanId>-01
```

This allows vLLM to create child spans under OpenClaw's trace, giving end-to-end visibility:

- OpenClaw queue time
- vLLM queue time, prefill time, decode time
- Total request latency across both services

---

## MLflow Compatibility

The instrumentation includes MLflow-specific attributes to populate the MLflow UI:

### Request/Response Columns

Set on the **root span** (not LLM span) because MLflow reads from root:

- `gen_ai.prompt` - User's input message
- `gen_ai.completion` - Assistant's response
- `mlflow.span.inputs` - JSON-formatted input
- `mlflow.span.outputs` - JSON-formatted output

### Session/User Columns

- `mlflow.trace.session` - OpenClaw sessionKey
- `mlflow.trace.user` - Agent ID

### GenAI Semantic Conventions (v1.38+)

All spans follow OpenTelemetry GenAI spec:

- `gen_ai.system` - Provider name (openai, anthropic, etc.)
- `gen_ai.request.model` / `gen_ai.response.model`
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`
- `gen_ai.operation.name` - Operation type (chat, execute_tool, etc.)
- `gen_ai.tool.name` / `gen_ai.tool.type` / `gen_ai.tool.call.id`

---

## Configuration

### Enable Tracing

**Config file:** `~/.openclaw/openclaw.json`

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "serviceName": "openclaw",
      "sampleRate": 1.0
    }
  }
}
```

### Environment Variables

- `OTEL_EXPORTER_OTLP_ENDPOINT` - OTLP endpoint URL (overrides config)
- `OTEL_SERVICE_NAME` - Service name (overrides config)
- `OPENCLAW_OTEL_DEBUG=1` - Enable debug logging for trace events

### Plugin

Tracing is implemented as an OpenClaw plugin:

- **Plugin ID:** `diagnostics-otel`
- **Location:** `extensions/diagnostics-otel/`
- **Auto-loaded** when `diagnostics.otel.enabled: true`

---

## Debugging

### Enable Debug Logging

```bash
export OPENCLAW_OTEL_DEBUG=1
```

Debug logs show:

- `diagnostics-otel: created root span for session=...`
- `diagnostics-otel: no active trace for tool.execution sessionKey=... tool=...`
- `diagnostics-otel: exporting N spans. first=...`

### Common Issues

**Tools appearing as standalone traces:**

- **Symptom:** Tool spans with null session/request/response, separate trace IDs
- **Cause:** `message.queued` event not emitted (e.g., cron jobs before our fix)
- **Fix:** Ensure all execution paths emit `message.queued` before processing

**Empty Request/Response columns in MLflow:**

- **Symptom:** Traces visible but Request/Response columns blank
- **Cause:** Prompt/completion not set on root span
- **Fix:** Ensure `model.usage` events include `prompt` and `completion` fields

**No vLLM spans:**

- **Symptom:** Only OpenClaw spans visible, no vLLM children
- **Cause:** W3C headers not reaching vLLM, or vLLM not configured for OTLP
- **Fix:** Verify vLLM has `--otlp-traces-endpoint` configured

---

## Testing

### Manual Test Flow

1. Send a message to OpenClaw (WhatsApp, cron, etc.)
2. Check gateway logs for trace creation:
   ```bash
   oc logs -c gateway <pod> | grep "created root span"
   ```
3. View trace in MLflow UI:
   - Navigate to Traces → select experiment
   - Look for nested hierarchy: `message.process` → `llm_request` → `llm.*` → `tool.*`
   - Verify Request/Response/Session columns populated

### Expected Trace Structure

```
message.process (4.5s)
├── llm_request (4.0s) [from vLLM]
│   └── llm.nerc.openai/gpt-oss-20b (3.8s)
├── tool.read (0.08s)
├── tool.exec (0.25s)
└── tool.write (0.05s)
```

---

## Implementation Summary

| Component           | Purpose                              | Key Files                                                                                                                                                         |
| ------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diagnostic Events   | Core instrumentation points          | `src/logging/diagnostic.ts`<br>`src/auto-reply/reply/agent-runner.ts`<br>`src/agents/pi-embedded-subscribe.handlers.tools.ts`<br>`src/cron/isolated-agent/run.ts` |
| OTel Plugin         | Span creation and export             | `extensions/diagnostics-otel/src/service.ts`                                                                                                                      |
| Session Propagation | Context flow through agent execution | `src/agents/pi-embedded-subscribe.types.ts`<br>`src/agents/pi-embedded-runner/run/attempt.ts`<br>`src/infra/agent-events.ts`                                      |
| W3C Propagation     | Distributed tracing to LLM providers | `src/agents/trace-context-propagator.ts`<br>`extensions/diagnostics-otel/src/service.ts` (global registry)                                                        |

---

## Future Enhancements

Potential areas for expansion:

- **Memory operations** - Trace long-term memory reads/writes
- **Remote skills** - Trace skill execution across network boundaries
- **Gateway routing** - Trace message routing decisions
- **Compaction** - Trace session transcript compaction operations
- **Custom metrics** - Add histograms for queue depth, response latency, etc.

---

For questions or issues, see:

- OpenTelemetry Semantic Conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- MLflow Tracing Docs: https://mlflow.org/docs/latest/llms/tracing/index.html
- OpenClaw Diagnostics: `docs/diagnostics/`

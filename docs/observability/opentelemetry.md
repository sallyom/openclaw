# OpenTelemetry Tracing in OpenClaw

OpenClaw includes built-in **OpenTelemetry Protocol (OTLP)** instrumentation for distributed tracing of agent message processing, LLM calls, and tool executions.

## What Gets Traced

**Root Span** (`message.process`)

- Represents the full lifecycle of processing a user message
- Duration: Total time from queue to response
- Attributes: session ID, agent ID, channel, queue depth

**Child Spans** (`llm.{provider}.{model}`)

- Each LLM inference call (Claude, GPT, Gemini, etc.)
- Token usage (input, output, total)
- Prompt and completion text
- Model provider and name

**Nested Spans** (`tool.{name}`)

- Individual tool executions (Read, Write, Bash, etc.)
- Tool call ID and run ID
- Error status if tool fails

## Architecture

OpenClaw uses **pure OTLP** with manual trace reconstruction across event boundaries:

```
User Message
    ↓
message.queued event → Create root span with sessionKey
    ↓
model.usage event → Create child LLM span (lookup parent by sessionKey)
    ↓
tool start/end events → Create nested tool spans
    ↓
message.processed event → End root span, flush via OTLP
```

This is necessary because OpenClaw is a **multi-tenant, event-driven messaging gateway** managing hundreds of concurrent sessions across 10+ messaging platforms. Automatic context propagation doesn't work across async event boundaries and message queues.

## Configuration

### Enabling/Disabling Tracing

**Tracing is disabled by default.** You must explicitly enable it using one of these methods:

**Method 1: Config file (explicit control)**

```json
{
  "diagnostics": {
    "opentelemetry": {
      "enabled": true, // Explicitly enable
      "otlpEndpoint": "http://localhost:4318/v1/traces"
    }
  }
}
```

**Method 2: Environment variable (auto-enable)**

```bash
# Setting this env var automatically enables tracing
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://localhost:4318/v1/traces"
```

**Method 3: Leave disabled (default)**

```bash
# No config, no env var = tracing stays disabled
# Gateway logs: (tracing disabled)
```

**Priority order:**

1. If `diagnostics.opentelemetry.enabled` is explicitly set in config → uses that value
2. Otherwise, if `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` env var exists → auto-enables
3. Otherwise → **disabled**

**To disable tracing even when env var is set:**

```json
{
  "diagnostics": {
    "opentelemetry": {
      "enabled": false // Overrides env var
    }
  }
}
```

### Additional Headers

For backends requiring authentication or experiment routing:

```json
{
  "diagnostics": {
    "opentelemetry": {
      "enabled": true,
      "otlpEndpoint": "https://mlflow.example.com/v1/traces",
      "otlpHeaders": {
        "Authorization": "Bearer <token>",
        "x-mlflow-experiment-id": "4"
      }
    }
  }
}
```

## Deployment Options

### Option 1: Direct to MLflow

Point directly to MLflow's OTLP endpoint:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://mlflow.example.com/v1/traces"
```

MLflow populates its **Traces** tab using these span attributes:

- `mlflow.trace.session` → Session column
- `mlflow.trace.user` → User column
- `gen_ai.prompt` → Request column (from root span)
- `gen_ai.completion` → Response column (from root span)
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` → Token metrics

### Option 2: Via OpenTelemetry Collector

Use an OTEL collector sidecar for batching, sampling, or multi-backend routing:

```yaml
# Kubernetes/OpenShift deployment
annotations:
  sidecar.opentelemetry.io/inject: "openclaw-sidecar"

env:
  - name: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    value: http://localhost:4318/v1/traces
  - name: OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
    value: http/protobuf
```

Collector config can route to multiple backends:

```yaml
exporters:
  otlp/mlflow:
    endpoint: https://mlflow.example.com/v1/traces
  otlp/jaeger:
    endpoint: http://jaeger:4318/v1/traces

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, resource]
      exporters: [otlp/mlflow, otlp/jaeger]
```

### Option 3: Other OTLP Backends

Works with any OTLP-compatible backend:

**Jaeger:**

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://jaeger:4318/v1/traces"
```

**Grafana Tempo:**

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://tempo.example.com:4318/v1/traces"
```

**Honeycomb:**

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://api.honeycomb.io/v1/traces"
# Add API key via otlpHeaders in config
```

## Semantic Conventions

OpenClaw follows **OpenTelemetry GenAI semantic conventions** for LLM observability:

| Attribute                    | Description        | Example                             |
| ---------------------------- | ------------------ | ----------------------------------- |
| `gen_ai.system`              | LLM provider       | `anthropic`, `openai`               |
| `gen_ai.request.model`       | Model requested    | `claude-3-5-sonnet-20241022`        |
| `gen_ai.response.model`      | Model used         | `claude-3-5-sonnet-20241022`        |
| `gen_ai.usage.input_tokens`  | Input tokens       | `1234`                              |
| `gen_ai.usage.output_tokens` | Output tokens      | `567`                               |
| `gen_ai.usage.total_tokens`  | Total tokens       | `1801`                              |
| `gen_ai.prompt`              | User's message     | `"What is the capital of France?"`  |
| `gen_ai.completion`          | Assistant's reply  | `"The capital of France is Paris."` |
| `session.id`                 | Session identifier | `agent:adminbot:telegram:123456`    |
| `enduser.id`                 | User/agent ID      | `adminbot`                          |

### OpenClaw-Specific Attributes

| Attribute              | Description                                 |
| ---------------------- | ------------------------------------------- |
| `openclaw.session_key` | Full session key                            |
| `openclaw.agent_id`    | Agent identifier                            |
| `openclaw.channel`     | Messaging channel (telegram, discord, etc.) |
| `openclaw.source`      | Message source                              |
| `openclaw.queue_depth` | Queue depth at message arrival              |

### MLflow-Specific Attributes

For MLflow UI column population:

| Attribute              | MLflow Column             |
| ---------------------- | ------------------------- |
| `mlflow.trace.session` | Session                   |
| `mlflow.trace.user`    | User                      |
| `mlflow.spanInputs`    | Request (from root span)  |
| `mlflow.spanOutputs`   | Response (from root span) |

## Implementation Details

### Code Location

**Core Service**: `src/diagnostics/opentelemetry/service.ts`

OpenTelemetry instrumentation runs as a **core service** (not a plugin) to avoid dual-package hazards with event listener registration.

**Integration**: `src/gateway/server.impl.ts`

Started during gateway initialization:

```typescript
import { startOpenTelemetryDiagnostics } from "../diagnostics/opentelemetry/service.js";

const stopOpenTelemetry = await startOpenTelemetryDiagnostics(config, logger);

// ... later during shutdown
await stopOpenTelemetry();
```

### Event-Driven Trace Reconstruction

OpenClaw uses `sessionKey` as a correlation ID to manually reconstruct traces across async event boundaries:

```typescript
// Map of active traces keyed by sessionKey
const activeTraces = new Map<string, ActiveTrace>();

// On message.queued: create root span
onDiagnosticEvent(async (evt) => {
  if (evt.type === "message.queued") {
    const rootSpan = tracer.startSpan("message.process", { ... });
    activeTraces.set(evt.sessionKey, { span: rootSpan, ... });
  }

  // On model.usage: create child LLM span
  if (evt.type === "model.usage") {
    const activeTrace = activeTraces.get(evt.sessionKey);
    const parentContext = trace.setSpan(context.active(), activeTrace.span);
    const llmSpan = tracer.startSpan(`llm.${provider}.${model}`, { ... }, parentContext);
    llmSpan.end();
  }

  // On message.processed: end root span
  if (evt.type === "message.processed") {
    const activeTrace = activeTraces.get(evt.sessionKey);
    activeTrace.span.end();
    activeTraces.delete(evt.sessionKey);
  }
});
```

This manual approach is necessary because:

- Events cross async boundaries (queues, retries)
- Multiple sessions execute concurrently
- Thread-local storage doesn't work with async/await
- No automatic context propagation across event emitters

This is the same pattern used by **distributed microservices** with OpenTelemetry (manual W3C `traceparent` header propagation).

### Tool Span Nesting

Tool executions create child spans under the root `message.process` span:

```typescript
onAgentEvent((evt) => {
  if (evt.stream === "tool") {
    const { phase, name, toolCallId } = evt.data;

    if (phase === "start") {
      const activeTrace = activeTraces.get(evt.sessionKey);
      const parentContext = trace.setSpan(context.active(), activeTrace.span);

      const span = tracer.startSpan(
        `tool.${name}`,
        {
          attributes: {
            "tool.name": name,
            "tool.call_id": toolCallId,
          },
        },
        parentContext,
      );

      activeSpans.set(toolCallId, span);
    }

    if (phase === "end") {
      const span = activeSpans.get(toolCallId);
      span.end();
      activeSpans.delete(toolCallId);
    }
  }
});
```

This creates a trace hierarchy:

```
message.process (2431ms)
├── llm.anthropic.claude-3-5-sonnet-20241022 (1823ms)
│   ├── tool.Read (45ms)
│   ├── tool.Grep (89ms)
│   └── tool.Edit (102ms)
└── llm.anthropic.claude-3-5-sonnet-20241022 (412ms)
```

## Verification

**Check if tracing is enabled:**

```bash
kubectl logs deployment/openclaw -c gateway | grep -i "opentelemetry\|otlp"
```

**When disabled (default):**

```
OpenTelemetry tracing disabled (set diagnostics.opentelemetry.enabled or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT to enable)
```

**When enabled:**

```
OpenTelemetry tracing initialized (OTLP endpoint: http://localhost:4318/v1/traces, headers: {})
Creating OTLP trace for sessionKey=agent:adminbot:telegram:123456
OTLP trace started with attributes: mlflow.trace.session=agent:adminbot:telegram:123456 mlflow.trace.user=adminbot
OTLP trace ended for sessionKey=agent:adminbot:telegram:123456 outcome=completed
```

**MLflow UI:**

Navigate to your experiment's **Traces** tab and verify:

- ✅ Request column shows user messages
- ✅ Response column shows assistant replies
- ✅ Session column populated with `agent:{agentId}:{channel}:{conversationId}`
- ✅ User column shows `{agentId}`
- ✅ Click trace to see nested span hierarchy (message → llm → tools)

**Jaeger UI:**

Navigate to Jaeger and search for service `openclaw`:

- ✅ See traces with operation `message.process`
- ✅ Expand to see child spans (llm calls, tool executions)
- ✅ View span tags for full context

## Trace Context Propagation

For external services that support distributed tracing (e.g., vLLM with OpenTelemetry), OpenClaw can inject W3C trace context headers:

```typescript
import { getOtelTraceContext } from "../diagnostics/opentelemetry/service.js";

const traceHeaders = getOtelTraceContext(sessionKey);
if (traceHeaders) {
  // Add to outbound HTTP request:
  // traceparent: 00-{traceId}-{spanId}-01
  // tracestate: ...
}
```

This links external service spans into the OpenClaw trace.

## Further Reading

- **OpenTelemetry GenAI Conventions**: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- **MLflow Tracing**: https://mlflow.org/docs/latest/genai/tracing/
- **OTLP Specification**: https://opentelemetry.io/docs/specs/otlp/
- **W3C Trace Context**: https://www.w3.org/TR/trace-context/

# OpenTelemetry Instrumentation in OpenClaw

## What is Instrumentation?

**Instrumentation** is the process of adding observability to your application by emitting telemetry data (traces, metrics, logs) about what's happening during execution.

For LLM applications, this means tracking:
- **Traces**: Full request/response lifecycle showing what happened
- **Spans**: Individual operations (LLM calls, tool executions) within a trace
- **Metrics**: Token usage, costs, latency, error rates
- **Context**: Session IDs, user identifiers, model names

This data flows to observability platforms like **MLflow**, **Langfuse**, or any OpenTelemetry-compatible backend for debugging, evaluation, and monitoring.

## Why OpenClaw Instrumentation is Different

### Simple Agent (Auto-instrumentation Works)
```python
# Typical single-function agent
from mlflow.langchain.autolog import autolog
autolog()  # ✨ Automatically captures everything

chain = prompt | llm | parser
result = chain.invoke({"input": "hello"})
```

**Why it's easy:**
- Single execution context (one trace at a time)
- Linear flow: prompt → LLM → response → done
- Runs in one thread/async context
- Library monkey-patching captures everything automatically

### OpenClaw (Production Messaging Gateway)

OpenClaw is a **multi-tenant, event-driven messaging system** that routes messages between:
- 10+ messaging platforms (Telegram, Discord, WhatsApp, Signal, etc.)
- Multiple LLM providers (Anthropic, OpenAI, Google, etc.)
- Hundreds of concurrent agent sessions
- Extensible plugin system

**Why auto-instrumentation doesn't work:**

1. **Event-Driven Architecture**
   - Execution happens across distributed events: `message.queued` → `model.usage` → `message.processed`
   - Events are decoupled from execution flow
   - Must manually correlate events via `sessionKey` to reconstruct traces

2. **Multi-Session Concurrency**
   - Manages hundreds of sessions simultaneously
   - Session keys like: `agent:{agentId}:{channel}:{conversationId}`
   - Must track active traces in a Map, look up by sessionKey
   - No automatic context propagation

3. **Asynchronous Message Queues**
   - Multi-lane queuing with non-deterministic timing
   - Messages can be queued, dequeued, retried, aborted
   - Can't rely on thread-local or async context storage

4. **Module Boundaries (Plugin System)**
   - Plugins run in separate module instances
   - Must avoid dual package hazard (separate listener Sets)
   - Context doesn't automatically propagate across boundaries

### This is Normal for Production Systems

OpenClaw faces the same challenges as **microservices using OpenTelemetry**:
- Manual trace context propagation (like HTTP `traceparent` headers)
- Reconstruct distributed traces from correlation IDs
- Handle async boundaries, retries, queues
- No automatic context inheritance

## OpenTelemetry Implementation in OpenClaw

### Architecture

OpenClaw uses **OpenTelemetry Protocol (OTLP)** with manual trace reconstruction:

```
User Message
    ↓
message.queued event → Create root span (sessionKey)
    ↓
model.usage event → Create child LLM span (lookup parent by sessionKey)
    ↓
message.processed event → End span, flush to backend
    ↓
Set trace tags via backend API (session, user metadata)
```

### Code Locations

#### Core OpenClaw (Diagnostic Events)

**Event Schema** (`src/infra/diagnostic-events.ts`)
- Defines `DiagnosticUsageEvent` with `prompt` and `completion` fields
- Events emitted throughout agent execution lifecycle
- Plugins subscribe to these events for observability

**Event Emission** (`src/auto-reply/reply/agent-runner.ts`)
- Emits `model.usage` events with token counts, costs, and prompt/completion text
- Emits `message.queued` and `message.processed` lifecycle events
- Includes `sessionKey` for trace correlation

#### MLflow Extension (OpenTelemetry OTLP)

**Location**: `extensions/diagnostics-mlflow/`

**Main Implementation** (`extensions/diagnostics-mlflow/src/service-otel.ts`)
- Subscribes to diagnostic events via `onDiagnosticEvent()`
- Creates OpenTelemetry spans with proper parent-child relationships
- Sets semantic conventions for GenAI observability
- Exports traces via OTLP to MLflow's `/v1/traces` endpoint
- Calls MLflow REST API to set User tags (workaround for OTLP limitation)

**Key Features:**
- **Root span creation** on `message.queued` with session metadata
- **Child LLM spans** on `model.usage` with token metrics and prompt/completion
- **Nested trace hierarchy** showing full execution flow
- **Request/Response columns** populated via `mlflow.spanInputs` and `mlflow.spanOutputs` on root span
- **User identification** via K8s ServiceAccount token parsing (tamper-resistant)
- **Session tracking** via OpenTelemetry `session.id` attribute

### What Gets Tracked

**Traces (Full Lifecycle):**
- Request: User's message text
- Response: Assistant's reply
- Session: Conversation identifier
- User: ServiceAccount + Agent name (e.g., `openclaw-oauth-proxy-adminbot`)
- Duration: Total processing time
- Status: Success/error outcome

**Spans (Individual Operations):**
- `message.process` - Root span for entire message flow
- `llm.{provider}.{model}` - LLM inference calls
- Token usage (input, output, cache read/write)
- Cost per call
- Latency metrics

**Metrics (Time Series):**
- `tokens.input`, `tokens.output`, `tokens.total`
- `tokens.cache_read`, `tokens.cache_write`
- `cost.usd` - LLM costs
- `latency.model_ms` - Inference time
- `latency.message_ms` - Total processing time

## Configuration

Add to `openclaw.json`:

```json
{
  "diagnostics": {
    "mlflow": {
      "enabled": true,
      "trackingUri": "https://mlflow.example.com",
      "experimentName": "OpenClaw",
      "trackTokenUsage": true,
      "trackCosts": true,
      "trackLatency": true,
      "trackTraces": true
    }
  }
}
```

Or use environment variables:
```bash
export MLFLOW_TRACKING_URI="https://mlflow.example.com"
export MLFLOW_EXPERIMENT_NAME="OpenClaw"
```

## Kubernetes/OpenShift Deployment

OpenClaw can optionally use an **OpenTelemetry Collector sidecar** for additional processing:

```yaml
annotations:
  sidecar.opentelemetry.io/inject: "openclaw-sidecar"

env:
- name: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  value: http://localhost:4318/v1/traces
- name: OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
  value: http/protobuf
- name: K8S_SERVICE_ACCOUNT  # For user identification
  valueFrom:
    fieldRef:
      fieldPath: spec.serviceAccountName
```

The collector can:
- Batch telemetry for better performance
- Apply resource attributes (namespace, environment)
- Route to multiple backends simultaneously
- Sample high-volume traces

## Verification

**Check logs for trace creation:**
```bash
kubectl logs deployment/openclaw -c gateway | grep "OTLP trace"
```

Expected output:
```
OTLP trace started: traceId=4a44ab492018... sessionKey=agent:adminbot:cron:...
Set MLflow user tag: openclaw-oauth-proxy-adminbot for trace tr-4a44ab492018...
OTLP trace ended: traceId=4a44ab492018... outcome=completed duration=2431ms
```

**MLflow UI:**
Navigate to your experiment's Traces tab and verify:
- ✅ Request column shows user messages
- ✅ Response column shows assistant replies
- ✅ Session column populated
- ✅ User column shows `{serviceaccount}-{agentname}`
- ✅ Click trace to see nested span hierarchy

## Key Implementation Details

### Why Manual Context Propagation?

OpenClaw **cannot** use automatic context propagation because:
- Events cross async boundaries (queues, retries)
- Multiple sessions execute concurrently
- Plugin system creates module boundaries
- Thread-local storage doesn't work with async/await

**Solution**: Use `sessionKey` as correlation ID, manually look up active traces from a Map.

### Why REST API for User Tags?

MLflow's OTLP endpoint automatically extracts some attributes (`session.id`) to trace metadata, but **not** `enduser.id` or custom tags.

**Workaround**: After OTLP trace is flushed, call:
```typescript
await client.patch(`/api/3.0/mlflow/traces/${traceId}/tags`, {
  key: "mlflow.user",
  value: userIdentifier
});
```

This populates the User column in MLflow UI.

### Why Read K8s Token Instead of Env Var?

**Security**: Reading ServiceAccount name from the K8s-mounted JWT token is more tamper-resistant than an environment variable.

```typescript
const token = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8");
const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
const serviceAccount = payload["kubernetes.io/serviceaccount/service-account.name"];
```

Agent code can't easily forge this without cluster-admin privileges.

**Fallback**: On non-K8s environments (local dev, Docker), defaults to `"openclaw"`.

## Further Reading

- **Extension README**: `extensions/diagnostics-mlflow/README.md` - Configuration and deployment guide
- **MLflow Tracing**: https://mlflow.org/docs/latest/genai/tracing/
- **OpenTelemetry GenAI Conventions**: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- **OpenClaw Plugin Development**: `docs/plugins/`

---

**Bottom Line**: OpenClaw's instrumentation requires manual trace reconstruction because it's a production-grade, multi-tenant messaging gateway—not a simple single-function agent. This is the same complexity faced by any distributed system using OpenTelemetry.

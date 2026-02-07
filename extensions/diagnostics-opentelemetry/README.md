# OpenTelemetry Observability for OpenClaw

OpenClaw integrates with OpenTelemetry (OTLP) to export comprehensive observability data to platforms like MLflow, Jaeger, Grafana, and others. Track model usage, costs, latency, and full trace data with session and user context.

## Features

- **Automatic trace creation** for every message processed
- **Session and user tracking** - Filter traces by agent and conversation
- **Token usage and cost tracking** - Monitor LLM consumption and spending
- **Latency metrics** - Track model and message processing times
- **Span hierarchy** - See the full execution flow including tool calls
- **Prompt tracking** - View prompts sent to LLMs for debugging and evaluation

## Configuration

Add to your `openclaw.json`:

```json
{
  "diagnostics": {
    "mlflow": {
      "enabled": true,
      "trackingUri": "https://your-mlflow-server.com",
      "experimentName": "OpenClaw",
      "experimentId": "4",
      "trackTokenUsage": true,
      "trackCosts": true,
      "trackLatency": true,
      "trackTraces": true,
      "batchSize": 100,
      "flushIntervalMs": 5000
    }
  }
}
```

### Configuration Options

| Option            | Type    | Default              | Description                         |
| ----------------- | ------- | -------------------- | ----------------------------------- |
| `enabled`         | boolean | `false`              | Enable MLflow integration           |
| `trackingUri`     | string  | -                    | MLflow server URL                   |
| `experimentName`  | string  | `"openclaw-default"` | Experiment name                     |
| `experimentId`    | string  | -                    | Experiment ID (alternative to name) |
| `trackTokenUsage` | boolean | `true`               | Track token consumption             |
| `trackCosts`      | boolean | `true`               | Track LLM costs                     |
| `trackLatency`    | boolean | `true`               | Track processing times              |
| `trackTraces`     | boolean | `true`               | Enable trace/span tracking          |
| `batchSize`       | number  | `100`                | Batch size for metrics              |
| `flushIntervalMs` | number  | `5000`               | Flush interval in milliseconds      |

### Environment Variables

Set these environment variables or use the config file:

```bash
export MLFLOW_TRACKING_URI="https://your-mlflow-server.com"
export MLFLOW_EXPERIMENT_NAME="OpenClaw"
```

## MLflow UI

After configuration, traces will appear in your MLflow experiment with the following columns populated:

### Traces Tab

| Column   | Example Value          | Description                            |
| -------- | ---------------------- | -------------------------------------- |
| Session  | `agent:shadowman:main` | Session key for grouping conversations |
| User     | `shadowman`            | Agent ID that processed the message    |
| Prompt   | "Hello, how are you?"  | User's message (preview)               |
| Model    | `claude-sonnet-4.5`    | LLM model used                         |
| Status   | ✅ Success             | Trace outcome                          |
| Duration | 2.3s                   | Total processing time                  |

### Filtering Traces

Filter by session or user in the MLflow UI:

```
metadata.`mlflow.trace.session` = 'agent:shadowman:main'
metadata.`mlflow.trace.user` = 'shadowman'
```

### Span Hierarchy

Click on a trace to see the full execution flow:

```
📊 message.process (2.3s)
  └─ 🤖 llm.anthropic.claude-sonnet-4.5 (2.1s)
      ├─ Input tokens: 1,234
      ├─ Output tokens: 567
      └─ Cost: $0.0123
  └─ 🔧 tool.read_file (0.1s)
  └─ 🔧 tool.bash (0.05s)
```

## Metrics Tracked

MLflow automatically tracks these metrics:

### Token Metrics

- `tokens.input` - Input tokens consumed
- `tokens.output` - Output tokens generated
- `tokens.total` - Total tokens used
- `tokens.cache_read` - Cache read tokens (prompt caching)
- `tokens.cache_write` - Cache write tokens

### Cost Metrics

- `cost.usd` - Total cost in USD

### Latency Metrics

- `latency.model_ms` - LLM inference time
- `latency.message_ms` - Total message processing time

### Usage Metrics

- `model.{model_name}.requests` - Request count per model
- `message.outcome.{outcome}` - Messages by outcome (completed/error)

## Deployment

### Kubernetes/OpenShift

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openclaw
spec:
  template:
    spec:
      containers:
        - name: gateway
          image: quay.io/your-org/openclaw:latest
          env:
            - name: MLFLOW_TRACKING_URI
              valueFrom:
                secretKeyRef:
                  name: openclaw-secrets
                  key: MLFLOW_TRACKING_URI
            - name: MLFLOW_EXPERIMENT_NAME
              value: "OpenClaw"
```

### Docker

```bash
docker run -d \
  -e MLFLOW_TRACKING_URI=https://your-mlflow-server.com \
  -e MLFLOW_EXPERIMENT_NAME=OpenClaw \
  quay.io/your-org/openclaw:latest
```

## Verification

### Check Gateway Logs

After sending a message, verify traces are being created:

```bash
# Kubernetes/OpenShift
oc logs <pod-name> -c gateway --tail=50 | grep -i mlflow

# Docker
docker logs <container-id> | grep -i mlflow
```

Expected output:

```
MLFlow experiment ID: 4
MLflow tracing SDK initialized
Creating MLflow trace for sessionKey=agent:shadowman:main
Set trace metadata: mlflow.trace.session=agent:shadowman:main mlflow.trace.user=shadowman
MLflow span created: spanId=... traceId=...
Flushed trace ... to MLflow
```

### Check MLflow UI

1. Navigate to your MLflow server
2. Select your experiment (e.g., "OpenClaw")
3. Click the **Traces** tab
4. Verify traces appear with Session and User columns populated
5. Click a trace to see span details and metrics

## Troubleshooting

### Traces not appearing

**Check configuration:**

```bash
# Verify plugin is enabled
cat ~/.openclaw/openclaw.json | jq '.diagnostics.mlflow.enabled'

# Verify tracking URI
cat ~/.openclaw/openclaw.json | jq '.diagnostics.mlflow.trackingUri'
```

**Check logs:**

```bash
# Look for initialization
oc logs <pod> -c gateway | grep "MLflow tracing SDK initialized"

# Look for trace creation
oc logs <pod> -c gateway | grep "Creating MLflow trace"
```

**Common issues:**

- MLflow tracking URI incorrect or unreachable
- Experiment doesn't exist (check experiment ID/name)
- Network/firewall blocking gateway → MLflow communication

### Session/User columns blank

**Verify metadata is being set:**

```bash
oc logs <pod> -c gateway | grep "Set trace metadata"
```

Expected: `Set trace metadata: mlflow.trace.session=... mlflow.trace.user=...`

**Check MLflow version:**

- Session/user tracking requires MLflow 2.0+
- Verify experiment is using SQL backend (not file-based)

### High latency

**Reduce flush interval:**

```json
{
  "diagnostics": {
    "mlflow": {
      "flushIntervalMs": 1000,
      "batchSize": 10
    }
  }
}
```

## Requirements

- **MLflow Server**: Version 2.0 or higher
- **Storage Backend**: SQL-based (PostgreSQL, MySQL, SQLite)
- **Network**: Gateway must reach MLflow tracking URI

## Further Reading

- [MLflow Tracing Documentation](https://mlflow.org/docs/latest/genai/tracing/)
- [MLflow TypeScript SDK](https://www.mlflow.org/docs/latest/api_reference/typescript_api/mlflow-tracing/)
- [OpenClaw Plugin Development](../../docs/plugins/)

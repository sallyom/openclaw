/**
 * MLFlow integration for OpenClaw
 * Tracks model usage, experiments, costs, performance metrics, AND traces with spans
 * Uses official MLflow TypeScript SDK (mlflow-tracing) for MLflow 3.9+
 */

import axios, { type AxiosInstance } from "axios";
import type {
  AgentEventPayload,
  DiagnosticEventPayload,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import { onAgentEvent, onDiagnosticEvent } from "openclaw/plugin-sdk";
import * as mlflow from "mlflow-tracing";
import { flushTraces, SpanStatusCode, updateCurrentTrace, withSpan } from "mlflow-tracing";

interface MLFlowConfig {
  enabled?: boolean;
  trackingUri?: string;
  experimentName?: string;
  experimentId?: string; // NEW: Direct experiment ID (alternative to name)
  artifactLocation?: string;
  tags?: Record<string, string>;
  trackTokenUsage?: boolean;
  trackCosts?: boolean;
  trackLatency?: boolean;
  trackTraces?: boolean; // Enable trace/span tracking via TypeScript SDK
  batchSize?: number;
  flushIntervalMs?: number;
}

interface MLFlowRun {
  run_id: string;
  experiment_id: string;
  user_id: string;
  status: string;
  start_time: number;
  end_time?: number;
  artifact_uri: string;
  lifecycle_stage: string;
}

interface MetricBatch {
  key: string;
  value: number;
  timestamp: number;
  step?: number;
}

interface ActiveSpan {
  span: ReturnType<typeof mlflow.startSpan>;
  name: string;
  startedAt: number;
}

interface ActiveTrace {
  requestId: string;
  startedAt: number;
  sessionKey?: string;
  channel?: string;
  rootSpan?: ActiveSpan;
}

/**
 * Get trace context for external service propagation (e.g., vLLM)
 * Returns headers that can be added to HTTP requests to downstream services
 * for distributed trace joining
 */
export function getMLflowTraceContext(sessionKey?: string): Record<string, string> | null {
  if (!sessionKey || !activeTracesGlobal.has(sessionKey)) {
    return null;
  }

  const trace = activeTracesGlobal.get(sessionKey);
  if (!trace?.rootSpan) {
    return null;
  }

  // Return W3C Trace Context headers for distributed tracing
  // These can be used by vLLM and other services that support OpenTelemetry/W3C standards
  return {
    "traceparent": `00-${trace.requestId}-${trace.rootSpan.span.spanId || "0000000000000000"}-01`,
    "tracestate": `mlflow=requestId:${trace.requestId}`,
    "X-MLflow-Request-Id": trace.requestId,
    "X-MLflow-Span-Id": trace.rootSpan.span.spanId || "",
    "X-Session-Key": sessionKey,
  };
}

// Global registry for cross-service trace access
const activeTracesGlobal = new Map<string, ActiveTrace>();

export function createDiagnosticsMlflowService(): OpenClawPluginService {
  let client: AxiosInstance | null = null;
  let experimentId: string | null = null;
  let runId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeAgentEvents: (() => void) | null = null;
  let metricQueue: MetricBatch[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let requestCounter = 0;
  let tracingInitialized = false;

  // Trace/span tracking using MLflow SDK
  // Use global map for external access (e.g., vLLM trace joining)
  const activeTraces = activeTracesGlobal;
  const activeSpans = new Map<string, ActiveSpan>(); // spanId (toolCallId) -> span

  async function ensureExperiment(
    cfg: MLFlowConfig,
    trackingUri: string,
  ): Promise<string> {
    // If experimentId provided directly, use it
    if (cfg.experimentId) {
      return cfg.experimentId;
    }

    const experimentName = cfg.experimentName || "openclaw-default";

    try {
      // Try to get existing experiment
      const response = await client!.get("/api/2.0/mlflow/experiments/get-by-name", {
        params: { experiment_name: experimentName },
      });

      return response.data.experiment.experiment_id;
    } catch (error) {
      // Create new experiment if not found
      const createResponse = await client!.post("/api/2.0/mlflow/experiments/create", {
        name: experimentName,
        artifact_location: cfg.artifactLocation,
        tags: Object.entries(cfg.tags || {}).map(([key, value]) => ({ key, value })),
      });

      return createResponse.data.experiment_id;
    }
  }

  async function createRun(expId: string, cfg: MLFlowConfig): Promise<string> {
    const response = await client!.post("/api/2.0/mlflow/runs/create", {
      experiment_id: expId,
      start_time: Date.now(),
      tags: [
        { key: "openclaw.service", value: "gateway" },
        { key: "openclaw.version", value: process.env.OPENCLAW_VERSION || "unknown" },
        ...Object.entries(cfg.tags || {}).map(([key, value]) => ({ key, value })),
      ],
    });

    return response.data.run.info.run_id;
  }

  async function logMetrics(metrics: MetricBatch[]): Promise<void> {
    if (!runId || metrics.length === 0) {
      return;
    }

    try {
      await client!.post("/api/2.0/mlflow/runs/log-batch", {
        run_id: runId,
        metrics: metrics.map((m) => ({
          key: m.key,
          value: m.value,
          timestamp: m.timestamp,
          step: m.step ?? requestCounter,
        })),
      });
    } catch (error) {
      console.error("Failed to log MLFlow metrics:", error);
    }
  }

  function queueMetric(key: string, value: number, timestamp: number = Date.now()): void {
    metricQueue.push({
      key,
      value,
      timestamp,
      step: requestCounter,
    });
  }

  async function flushMetrics(cfg: MLFlowConfig): Promise<void> {
    if (metricQueue.length === 0) {
      return;
    }

    const batch = metricQueue.splice(0, cfg.batchSize || 100);
    await logMetrics(batch);
  }

  async function flushTracesIfNeeded(): Promise<void> {
    if (!tracingInitialized) {
      return;
    }

    try {
      await flushTraces();
    } catch (error) {
      console.error("Failed to flush MLFlow traces:", error);
    }
  }

  function scheduleFlush(cfg: MLFlowConfig): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
    }

    flushTimer = setTimeout(
      async () => {
        try {
          await flushMetrics(cfg);
          await flushTracesIfNeeded();
        } catch (err) {
          console.error("Failed to flush MLFlow data:", err);
        }
        scheduleFlush(cfg);
      },
      cfg.flushIntervalMs || 5000,
    );
  }

  return {
    id: "diagnostics-mlflow",

    async start(ctx) {
      const cfg = (ctx.config.diagnostics?.mlflow as MLFlowConfig | undefined) || {};

      // Enable if explicitly configured, or if MLFLOW_TRACKING_URI env var is set
      const enabled = cfg.enabled ?? (!!process.env.MLFLOW_TRACKING_URI);
      if (!enabled) {
        return;
      }

      const trackingUri =
        cfg.trackingUri || process.env.MLFLOW_TRACKING_URI || "http://mlflow:5000";

      // Extract hostname from trackingUri for Host header (required by MLflow --allowed-hosts)
      // Note: Use hostname (without port) to avoid "DNS rebinding attack" error
      const url = new URL(trackingUri);
      const hostHeader = url.hostname;

      client = axios.create({
        baseURL: trackingUri,
        timeout: 10000,
        headers: {
          "Content-Type": "application/json",
        },
      });

      // Use interceptor to set Host header (axios may override headers set in create())
      client.interceptors.request.use((config) => {
        config.headers["Host"] = hostHeader;
        return config;
      });

      try {
        // Ensure experiment exists
        experimentId = await ensureExperiment(cfg, trackingUri);
        ctx.logger.info(`MLFlow experiment ID: ${experimentId}`);

        // Create run for metrics tracking
        runId = await createRun(experimentId, cfg);
        ctx.logger.info(`MLFlow run ID: ${runId}`);

        // Start flush timer
        scheduleFlush(cfg);

        const tracesEnabled = cfg.trackTraces ?? true; // Default: enabled

        // Initialize MLflow tracing SDK if traces enabled
        if (tracesEnabled) {
          try {
            mlflow.init({
              trackingUri,
              experimentId,
            });
            tracingInitialized = true;
            ctx.logger.info("MLflow tracing SDK initialized");
          } catch (error) {
            ctx.logger.warn(`Failed to initialize MLflow tracing SDK: ${String(error)}`);
            ctx.logger.warn("Continuing with metrics-only tracking");
          }
        }

        // Subscribe to diagnostic events (for metrics AND trace/span lifecycle)
        console.log('[MLflow] ABOUT TO SUBSCRIBE to diagnostic events');
        unsubscribe = onDiagnosticEvent(async (evt: DiagnosticEventPayload) => {
          requestCounter++;

          // DEBUG: Log every diagnostic event to verify handler is called
          console.log(`[MLflow] Diagnostic event received: type=${evt.type} sessionKey=${(evt as any).sessionKey || 'N/A'}`);

          switch (evt.type) {
            case "message.queued": {
              // Start root trace for message processing
              if (!tracingInitialized) {
                ctx.logger.warn(`message.queued but tracing not initialized (sessionKey=${evt.sessionKey})`);
                break;
              }

              if (!evt.sessionKey) {
                ctx.logger.warn("message.queued but no sessionKey provided");
                break;
              }

              try {
                ctx.logger.info(`Creating MLflow trace for sessionKey=${evt.sessionKey}`);

                // Create root span using MLflow SDK
                // Extract agent ID from sessionKey (format: agent:{agentId}:{channel}:{conversationId?})
                const agentId = evt.sessionKey?.split(":")[1] || "unknown";

                const rootSpan = mlflow.startSpan({
                  name: "message.process",
                  spanType: mlflow.SpanType.CHAIN,
                  inputs: {
                    session_key: evt.sessionKey,
                    channel: evt.channel,
                    source: evt.source,
                    queue_depth: evt.queueDepth,
                  },
                  attributes: {
                    // MLflow session/user attributes (may be recognized by server)
                    "mlflow.trace.session": evt.sessionKey,
                    "mlflow.trace.user": agentId,
                    // OpenClaw-specific attributes
                    "openclaw.sessionKey": evt.sessionKey,
                    "openclaw.agentId": agentId,
                    "openclaw.channel": evt.channel || "unknown",
                    "openclaw.source": evt.source,
                    "openclaw.queueDepth": evt.queueDepth || 0,
                    "openclaw.timestamp": evt.ts || Date.now(),
                    "openclaw.requestCounter": requestCounter,
                    "service.name": "openclaw-gateway",
                    "service.version": process.env.OPENCLAW_VERSION || "unknown",
                    "deployment.environment": process.env.NODE_ENV || "production",
                    "deployment.namespace": process.env.POD_NAMESPACE || "unknown",
                  },
                });

                // Set trace-level metadata for MLflow session/user grouping
                // Try both tags and metadata to ensure compatibility
                updateCurrentTrace({
                  tags: {
                    "mlflow.trace.session": evt.sessionKey,
                    "mlflow.trace.user": agentId,
                  },
                  metadata: {
                    "mlflow.trace.session": evt.sessionKey,
                    "mlflow.trace.user": agentId,
                  },
                });

                ctx.logger.info(`MLflow span created: spanId=${rootSpan.spanId} traceId=${rootSpan.traceId}`);

                // WORKAROUND: TypeScript SDK v0.1.2 doesn't send session/user tags to MLflow
                // Manually set tags via REST API after trace creation
                try {
                  if (client) {
                    await client.post("/api/2.0/mlflow/traces/set-trace-tag", {
                      request_id: rootSpan.traceId,
                      key: "mlflow.trace.session",
                      value: evt.sessionKey,
                    });
                    await client.post("/api/2.0/mlflow/traces/set-trace-tag", {
                      request_id: rootSpan.traceId,
                      key: "mlflow.trace.user",
                      value: agentId,
                    });
                    ctx.logger.info(`Set session/user tags for trace ${rootSpan.traceId}`);
                  }
                } catch (tagError) {
                  ctx.logger.warn(`Failed to set session/user tags: ${String(tagError)}`);
                }

                activeTraces.set(evt.sessionKey, {
                  requestId: rootSpan.traceId,
                  startedAt: evt.ts || Date.now(),
                  sessionKey: evt.sessionKey,
                  channel: evt.channel,
                  rootSpan: {
                    span: rootSpan,
                    name: "message.process",
                    startedAt: evt.ts || Date.now(),
                  },
                });

                ctx.logger.info(
                  `MLflow trace started: traceId=${rootSpan.traceId} sessionKey=${evt.sessionKey} channel=${evt.channel || "unknown"}`,
                );
              } catch (error) {
                ctx.logger.error(`Failed to start message trace: ${String(error)}`);
              }
              break;
            }

            case "model.usage": {
              // Track metrics
              if (cfg.trackTokenUsage && evt.usage) {
                if (evt.usage.input) {
                  queueMetric("tokens.input", evt.usage.input, evt.ts);
                }
                if (evt.usage.output) {
                  queueMetric("tokens.output", evt.usage.output, evt.ts);
                }
                if (evt.usage.total) {
                  queueMetric("tokens.total", evt.usage.total, evt.ts);
                }
                if (evt.usage.cacheRead) {
                  queueMetric("tokens.cache_read", evt.usage.cacheRead, evt.ts);
                }
                if (evt.usage.cacheWrite) {
                  queueMetric("tokens.cache_write", evt.usage.cacheWrite, evt.ts);
                }
              }

              if (cfg.trackCosts && evt.costUsd) {
                queueMetric("cost.usd", evt.costUsd, evt.ts);
              }

              if (cfg.trackLatency && evt.durationMs) {
                queueMetric("latency.model_ms", evt.durationMs, evt.ts);
              }

              if (evt.model) {
                queueMetric(`model.${evt.model}.requests`, 1, evt.ts);
              }

              // Create model call span as child of message span
              if (tracingInitialized && evt.sessionKey) {
                const trace = activeTraces.get(evt.sessionKey);
                if (trace?.rootSpan) {
                  try {
                    // Create LLM span with trace context for proper nesting
                    // Include prompt in inputs for MLflow Prompt column (used in agent evaluations)
                    const modelSpan = mlflow.startSpan({
                      name: `model.${evt.provider}.${evt.model}`,
                      spanType: mlflow.SpanType.LLM,
                      inputs: {
                        provider: evt.provider,
                        model: evt.model,
                        session_key: evt.sessionKey,
                        // Include prompt for agent evaluation (Prompt column in MLflow UI)
                        ...(evt.prompt && { prompt: evt.prompt }),
                      },
                      attributes: {
                        "model.provider": evt.provider || "unknown",
                        "model.name": evt.model || "unknown",
                        "model.input_tokens": evt.usage?.input || 0,
                        "model.output_tokens": evt.usage?.output || 0,
                        "model.total_tokens": evt.usage?.total || 0,
                        "model.cache_read_tokens": evt.usage?.cacheRead || 0,
                        "model.cache_write_tokens": evt.usage?.cacheWrite || 0,
                        "model.cost_usd": evt.costUsd || 0,
                        "model.duration_ms": evt.durationMs || 0,
                        "trace.parent.request_id": trace.requestId,
                      },
                    });

                    // End span immediately with outputs
                    modelSpan.end({
                      outputs: {
                        usage: evt.usage,
                        cost_usd: evt.costUsd,
                        duration_ms: evt.durationMs,
                      },
                      status: SpanStatusCode.OK,
                    });
                  } catch (error) {
                    ctx.logger.warn(`Failed to create model span: ${String(error)}`);
                  }
                }
              }
              break;
            }

            case "message.processed": {
              if (cfg.trackLatency && evt.durationMs) {
                queueMetric("latency.message_ms", evt.durationMs, evt.ts);
              }

              queueMetric(`message.outcome.${evt.outcome || "unknown"}`, 1, evt.ts);

              // End root trace/span
              if (tracingInitialized && evt.sessionKey) {
                const trace = activeTraces.get(evt.sessionKey);
                if (trace?.rootSpan) {
                  try {
                    const durationMs = Date.now() - trace.startedAt;
                    trace.rootSpan.span.end({
                      outputs: {
                        outcome: evt.outcome,
                        reason: evt.reason,
                        durationMs,
                        // Include trace context for external service joining
                        trace_id: trace.requestId,
                        span_id: trace.rootSpan.span.spanId,
                      },
                      status: evt.outcome === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
                      ...(evt.error && { statusMessage: evt.error }),
                    });

                    // Log trace completion metadata
                    ctx.logger.info(
                      `MLflow trace ended: requestId=${trace.requestId} sessionKey=${evt.sessionKey} outcome=${evt.outcome} duration=${durationMs}ms spanId=${trace.rootSpan.span.spanId}`,
                    );

                    // Immediately flush traces to MLflow (don't wait for timer)
                    flushTracesIfNeeded().catch((err) =>
                      ctx.logger.warn(`Failed to flush traces after completion: ${String(err)}`),
                    );
                  } catch (error) {
                    ctx.logger.error(`Failed to end message span: ${String(error)}`);
                  }
                  activeTraces.delete(evt.sessionKey);
                } else {
                  ctx.logger.warn(
                    `message.processed but no active trace found for sessionKey=${evt.sessionKey}`,
                  );
                }
              }
              break;
            }

            case "webhook.processed": {
              if (cfg.trackLatency && evt.durationMs) {
                queueMetric("latency.webhook_ms", evt.durationMs, evt.ts);
              }
              break;
            }

            case "queue.lane.dequeue": {
              if (evt.waitMs) {
                queueMetric("queue.wait_ms", evt.waitMs, evt.ts);
              }
              break;
            }
          }
        });
        console.log('[MLflow] SUCCESSFULLY SUBSCRIBED to diagnostic events');

        // Subscribe to agent events for comprehensive span tracking
        if (tracesEnabled && tracingInitialized) {
          unsubscribeAgentEvents = onAgentEvent((evt: AgentEventPayload) => {
            // Find the active trace for this session
            const trace = evt.sessionKey ? activeTraces.get(evt.sessionKey) : null;

            switch (evt.stream) {
              case "tool": {
                if (!trace) return;

                const data = evt.data as {
                  phase?: "start" | "end";
                  name?: string;
                  toolCallId?: string;
                  args?: Record<string, unknown>;
                  result?: unknown;
                  error?: string;
                };

                const phase = data.phase;
                const toolName = data.name || "unknown";
                const toolCallId = data.toolCallId || `tool-${Date.now()}`;

                if (phase === "start") {
                  try {
                    const span = mlflow.startSpan({
                      name: `tool.${toolName}`,
                      spanType: mlflow.SpanType.TOOL,
                      inputs: data.args || {},
                      attributes: {
                        "tool.name": toolName,
                        "tool.call_id": toolCallId,
                        "tool.run_id": evt.runId,
                        "trace.parent.request_id": trace.requestId,
                      },
                    });

                    activeSpans.set(toolCallId, {
                      span,
                      name: `tool.${toolName}`,
                      startedAt: evt.ts,
                    });
                  } catch (error) {
                    ctx.logger.warn(`Failed to start tool span for ${toolName}: ${String(error)}`);
                  }
                } else if (phase === "end") {
                  const activeSpan = activeSpans.get(toolCallId);
                  if (activeSpan) {
                    try {
                      activeSpan.span.end({
                        outputs: { result: data.result },
                        status: data.error ? SpanStatusCode.ERROR : SpanStatusCode.OK,
                        ...(data.error && { statusMessage: data.error }),
                      });
                    } catch (error) {
                      ctx.logger.warn(`Failed to end tool span for ${toolName}: ${String(error)}`);
                    }
                    activeSpans.delete(toolCallId);
                  }
                }
                break;
              }

              case "lifecycle": {
                if (!trace) return;

                const data = evt.data as {
                  phase?: "start" | "end";
                  startedAt?: number;
                  endedAt?: number;
                };
                const spanId = `lifecycle-${evt.runId}`;

                if (data.phase === "start" && !activeSpans.has(spanId)) {
                  try {
                    const span = mlflow.startSpan({
                      name: "agent.lifecycle",
                      spanType: mlflow.SpanType.AGENT,
                      inputs: { runId: evt.runId, sessionKey: evt.sessionKey },
                      attributes: {
                        "agent.runId": evt.runId,
                        "agent.sessionKey": evt.sessionKey || "unknown",
                        "agent.startedAt": data.startedAt || evt.ts,
                        "trace.parent.request_id": trace.requestId,
                      },
                    });

                    activeSpans.set(spanId, {
                      span,
                      name: "agent.lifecycle",
                      startedAt: data.startedAt || evt.ts,
                    });
                  } catch (error) {
                    ctx.logger.warn(`Failed to start lifecycle span: ${String(error)}`);
                  }
                } else if (data.phase === "end") {
                  const activeSpan = activeSpans.get(spanId);
                  if (activeSpan) {
                    try {
                      const durationMs = (data.endedAt || evt.ts) - activeSpan.startedAt;
                      activeSpan.span.end({
                        outputs: { endedAt: data.endedAt || evt.ts, durationMs },
                        status: SpanStatusCode.OK,
                      });
                      activeSpans.delete(spanId);
                    } catch (error) {
                      ctx.logger.warn(`Failed to end lifecycle span: ${String(error)}`);
                    }
                  }
                }
                break;
              }

              case "compaction": {
                if (!trace) return;

                const data = evt.data as { phase?: "start" | "end"; willRetry?: boolean };
                const spanId = `compaction-${evt.runId}-${evt.seq}`;

                if (data.phase === "start" && !activeSpans.has(spanId)) {
                  try {
                    const span = mlflow.startSpan({
                      name: "agent.compaction",
                      spanType: mlflow.SpanType.AGENT,
                      inputs: { runId: evt.runId },
                      attributes: {
                        "agent.runId": evt.runId,
                        "compaction.phase": "start",
                        "trace.parent.request_id": trace.requestId,
                      },
                    });

                    activeSpans.set(spanId, {
                      span,
                      name: "agent.compaction",
                      startedAt: evt.ts,
                    });
                  } catch (error) {
                    ctx.logger.warn(`Failed to start compaction span: ${String(error)}`);
                  }
                } else if (data.phase === "end") {
                  const activeSpan = activeSpans.get(spanId);
                  if (activeSpan) {
                    try {
                      activeSpan.span.end({
                        outputs: { willRetry: data.willRetry },
                        status: data.willRetry ? SpanStatusCode.ERROR : SpanStatusCode.OK,
                        ...(data.willRetry && { statusMessage: "Compaction retry scheduled" }),
                      });
                      activeSpans.delete(spanId);
                    } catch (error) {
                      ctx.logger.warn(`Failed to end compaction span: ${String(error)}`);
                    }
                  }
                }
                break;
              }

              case "assistant": {
                if (!trace) return;

                const data = evt.data as { delta?: string; final?: boolean };
                const spanId = `assistant-${evt.runId}`;

                if (data.delta && !activeSpans.has(spanId)) {
                  try {
                    const span = mlflow.startSpan({
                      name: "assistant.stream",
                      spanType: mlflow.SpanType.LLM,
                      inputs: { runId: evt.runId },
                      attributes: {
                        "assistant.runId": evt.runId,
                        "assistant.streaming": true,
                        "trace.parent.request_id": trace.requestId,
                      },
                    });

                    activeSpans.set(spanId, {
                      span,
                      name: "assistant.stream",
                      startedAt: evt.ts,
                    });
                  } catch (error) {
                    ctx.logger.warn(`Failed to start assistant span: ${String(error)}`);
                  }
                } else if (data.final) {
                  const activeSpan = activeSpans.get(spanId);
                  if (activeSpan) {
                    try {
                      activeSpan.span.end({
                        outputs: { final: true },
                        status: SpanStatusCode.OK,
                      });
                      activeSpans.delete(spanId);
                    } catch (error) {
                      ctx.logger.warn(`Failed to end assistant span: ${String(error)}`);
                    }
                  }
                }
                break;
              }

              case "error": {
                if (!trace) return;

                const data = evt.data as { error?: string; message?: string; stack?: string };
                try {
                  // Create error span
                  const errorSpan = mlflow.startSpan({
                    name: "agent.error",
                    spanType: mlflow.SpanType.UNKNOWN,
                    inputs: { runId: evt.runId, error: data.error || data.message },
                    attributes: {
                      "error.message": data.error || data.message || "Unknown error",
                      "error.runId": evt.runId,
                      "error.sessionKey": evt.sessionKey || "unknown",
                      "trace.parent.request_id": trace.requestId,
                    },
                  });

                  errorSpan.setStatus(SpanStatusCode.ERROR, data.error || data.message || "Unknown error");
                  errorSpan.end({
                    outputs: { error: data.error, message: data.message, stack: data.stack },
                  });
                } catch (error) {
                  ctx.logger.warn(`Failed to create error span: ${String(error)}`);
                }
                break;
              }
            }
          });
        }

        ctx.logger.info(
          `diagnostics-mlflow: started (metrics${tracesEnabled && tracingInitialized ? " + traces" : ""})`,
        );
      } catch (error) {
        ctx.logger.error(`diagnostics-mlflow: failed to start: ${String(error)}`);
        throw error;
      }
    },

    async stop() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      // Final flush of metrics
      if (metricQueue.length > 0) {
        await logMetrics(metricQueue);
        metricQueue = [];
      }

      // End any remaining spans
      for (const [, activeSpan] of activeSpans) {
        try {
          activeSpan.span.setStatus(SpanStatusCode.ERROR, "Service stopped");
          activeSpan.span.end();
        } catch {
          // Ignore errors during cleanup
        }
      }
      activeSpans.clear();

      // End any remaining traces
      for (const [, trace] of activeTraces) {
        if (trace.rootSpan) {
          try {
            trace.rootSpan.span.setStatus(SpanStatusCode.ERROR, "Service stopped");
            trace.rootSpan.span.end();
          } catch {
            // Ignore errors during cleanup
          }
        }
      }
      activeTraces.clear();

      // Final flush of traces (CRITICAL: sends buffered traces to MLflow)
      await flushTracesIfNeeded();

      // End run
      if (runId && client) {
        try {
          await client.post("/api/2.0/mlflow/runs/update", {
            run_id: runId,
            status: "FINISHED",
            end_time: Date.now(),
          });
        } catch (error) {
          console.error("Failed to end MLFlow run:", error);
        }
      }

      unsubscribe?.();
      unsubscribe = null;
      unsubscribeAgentEvents?.();
      unsubscribeAgentEvents = null;
      client = null;
      experimentId = null;
      runId = null;
      tracingInitialized = false;
    },
  } satisfies OpenClawPluginService;
}

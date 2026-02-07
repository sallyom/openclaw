/**
 * MLFlow integration for OpenClaw using OpenTelemetry
 * Sends traces to MLflow via OTLP endpoint (/v1/traces)
 * Uses GenAI semantic conventions for LLM observability
 */

import type {
  AgentEventPayload,
  DiagnosticEventPayload,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
// OpenTelemetry imports
import { trace, context, SpanStatusCode, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from "@opentelemetry/semantic-conventions";
import axios, { type AxiosInstance } from "axios";
import { onAgentEvent, onDiagnosticEvent } from "openclaw/plugin-sdk";

interface MLFlowConfig {
  enabled?: boolean;
  trackingUri?: string;
  experimentName?: string;
  experimentId?: string;
  otlpEndpoint?: string; // OTLP endpoint (default: {trackingUri}/v1/traces)
  otlpHeaders?: Record<string, string>; // Additional OTLP headers
  artifactLocation?: string;
  tags?: Record<string, string>;
  trackTokenUsage?: boolean;
  trackCosts?: boolean;
  trackLatency?: boolean;
  trackTraces?: boolean;
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

interface ActiveTrace {
  span: Span;
  startedAt: number;
  sessionKey?: string;
  channel?: string;
  agentId?: string;
}

// GenAI semantic convention attribute names (based on OpenTelemetry GenAI spec)
const GENAI_ATTRS = {
  // System and model
  SYSTEM: "gen_ai.system",
  REQUEST_MODEL: "gen_ai.request.model",
  RESPONSE_MODEL: "gen_ai.response.model",

  // Token usage
  INPUT_TOKENS: "gen_ai.usage.input_tokens",
  OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  TOTAL_TOKENS: "gen_ai.usage.total_tokens",

  // Prompts and completions
  PROMPT: "gen_ai.prompt",
  COMPLETION: "gen_ai.completion",

  // Session and user (OpenTelemetry semantic conventions)
  SESSION_ID: "session.id",
  USER_ID: "enduser.id", // OpenTelemetry standard
  THREAD_ID: "thread.id",

  // MLflow-specific (for MLflow UI columns)
  MLFLOW_TRACE_SESSION: "mlflow.trace.session",
  MLFLOW_TRACE_USER: "mlflow.trace.user",
  MLFLOW_SPAN_INPUTS: "mlflow.spanInputs",
  MLFLOW_SPAN_OUTPUTS: "mlflow.spanOutputs",

  // OpenClaw-specific
  OPENCLAW_SESSION_KEY: "openclaw.session_key",
  OPENCLAW_AGENT_ID: "openclaw.agent_id",
  OPENCLAW_CHANNEL: "openclaw.channel",
  OPENCLAW_SOURCE: "openclaw.source",
  OPENCLAW_QUEUE_DEPTH: "openclaw.queue_depth",
} as const;

// Global registry for cross-service trace access
const activeTracesGlobal = new Map<string, ActiveTrace>();

/**
 * Get trace context for external service propagation (e.g., vLLM)
 * Returns W3C trace context headers
 */
export function getOtelTraceContext(sessionKey?: string): Record<string, string> | null {
  if (!sessionKey || !activeTracesGlobal.has(sessionKey)) {
    return null;
  }

  const trace = activeTracesGlobal.get(sessionKey);
  if (!trace?.span) {
    return null;
  }

  const spanContext = trace.span.spanContext();

  // Return W3C Trace Context headers
  return {
    traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-01`,
    tracestate: spanContext.traceState?.serialize() || "",
  };
}

export function createDiagnosticsOtelService(): OpenClawPluginService {
  let client: AxiosInstance | null = null;
  let experimentId: string | null = null;
  let runId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeAgentEvents: (() => void) | null = null;
  let metricQueue: MetricBatch[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let requestCounter = 0;
  let tracingInitialized = false;

  // OpenTelemetry provider and tracer
  let provider: NodeTracerProvider | null = null;
  let tracer: ReturnType<typeof trace.getTracer> | null = null;

  // Active traces and spans
  const activeTraces = activeTracesGlobal;
  const activeSpans = new Map<string, Span>(); // spanId (toolCallId) -> span

  async function ensureExperiment(cfg: MLFlowConfig, trackingUri: string): Promise<string> {
    if (cfg.experimentId) {
      return cfg.experimentId;
    }

    const experimentName = cfg.experimentName || "openclaw-default";

    try {
      const response = await client!.get("/api/2.0/mlflow/experiments/get-by-name", {
        params: { experiment_name: experimentName },
      });

      return response.data.experiment.experiment_id;
    } catch (error) {
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

  function scheduleFlush(cfg: MLFlowConfig): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
    }

    flushTimer = setTimeout(async () => {
      try {
        await flushMetrics(cfg);
      } catch (err) {
        console.error("Failed to flush MLFlow metrics:", err);
      }
      scheduleFlush(cfg);
    }, cfg.flushIntervalMs || 5000);
  }

  return {
    id: "diagnostics-opentelemetry",

    async start(ctx) {
      const cfg = (ctx.config.diagnostics?.mlflow as MLFlowConfig | undefined) || {};

      const enabled = cfg.enabled ?? !!process.env.MLFLOW_TRACKING_URI;
      if (!enabled) {
        return;
      }

      const trackingUri =
        cfg.trackingUri || process.env.MLFLOW_TRACKING_URI || "http://mlflow:5000";

      // OTLP endpoint for traces (MLflow 3.6+ supports /v1/traces)
      const otlpEndpoint = cfg.otlpEndpoint || `${trackingUri}/v1/traces`;

      const url = new URL(trackingUri);
      const hostHeader = url.hostname;

      client = axios.create({
        baseURL: trackingUri,
        timeout: 10000,
        headers: {
          "Content-Type": "application/json",
        },
      });

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

        const tracesEnabled = cfg.trackTraces ?? true;

        // Initialize OpenTelemetry tracing if enabled
        if (tracesEnabled) {
          try {
            // Create resource with service metadata
            const resource = resourceFromAttributes({
              [SEMRESATTRS_SERVICE_NAME]: "openclaw-gateway",
              [SEMRESATTRS_SERVICE_VERSION]: process.env.OPENCLAW_VERSION || "unknown",
              [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || "production",
            });

            // Configure OTLP exporter - explicitly read environment variables
            const otlpTracesEndpoint =
              process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || otlpEndpoint;
            const otlpTracesHeaders = process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS
              ? Object.fromEntries(
                  process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS.split(",").map((h) => {
                    const [key, value] = h.split("=");
                    return [key.trim(), value.trim()];
                  }),
                )
              : {
                  "x-mlflow-experiment-id": experimentId,
                  "x-mlflow-workspace": process.env.POD_NAMESPACE || "openclaw",
                };

            ctx.logger.info(
              `OTLP exporter config: endpoint=${otlpTracesEndpoint} headers=${JSON.stringify(otlpTracesHeaders)}`,
            );

            const exporter = new OTLPTraceExporter({
              url: otlpTracesEndpoint,
              headers: otlpTracesHeaders,
            });

            // Create span processor
            const spanProcessor = new BatchSpanProcessor(exporter, {
              scheduledDelayMillis: cfg.flushIntervalMs || 5000,
            });

            // Create tracer provider with span processor
            provider = new NodeTracerProvider({
              resource,
              spanProcessors: [spanProcessor],
            });

            // Register provider
            provider.register();

            // Get tracer
            tracer = trace.getTracer("openclaw-gateway", process.env.OPENCLAW_VERSION || "1.0.0");

            tracingInitialized = true;
            ctx.logger.info(`OpenTelemetry tracing initialized (OTLP endpoint: ${otlpEndpoint})`);
          } catch (error) {
            ctx.logger.warn(`Failed to initialize OpenTelemetry tracing: ${String(error)}`);
            ctx.logger.warn("Continuing with metrics-only tracking");
          }
        }

        // Subscribe to diagnostic events
        unsubscribe = onDiagnosticEvent(async (evt: DiagnosticEventPayload) => {
          requestCounter++;

          switch (evt.type) {
            case "message.queued": {
              // Start root trace for message processing
              if (!tracingInitialized || !tracer) {
                ctx.logger.warn(
                  `message.queued but tracing not initialized (sessionKey=${evt.sessionKey})`,
                );
                break;
              }

              if (!evt.sessionKey) {
                ctx.logger.warn("message.queued but no sessionKey provided");
                break;
              }

              try {
                ctx.logger.info(`Creating OTLP trace for sessionKey=${evt.sessionKey}`);

                // Extract agent ID from sessionKey (format: agent:{agentId}:{channel}:...)
                const agentId = evt.sessionKey?.split(":")[1] || "unknown";

                // Create root span
                const span = tracer.startSpan("message.process", {
                  kind: 1, // SpanKind.INTERNAL
                  attributes: {
                    // GenAI semantic conventions
                    [GENAI_ATTRS.SESSION_ID]: evt.sessionKey,
                    [GENAI_ATTRS.USER_ID]: agentId,
                    [GENAI_ATTRS.THREAD_ID]: evt.sessionKey,

                    // MLflow-specific (for UI columns)
                    [GENAI_ATTRS.MLFLOW_TRACE_SESSION]: evt.sessionKey,
                    [GENAI_ATTRS.MLFLOW_TRACE_USER]: agentId,

                    // OpenClaw-specific attributes
                    [GENAI_ATTRS.OPENCLAW_SESSION_KEY]: evt.sessionKey,
                    [GENAI_ATTRS.OPENCLAW_AGENT_ID]: agentId,
                    [GENAI_ATTRS.OPENCLAW_CHANNEL]: evt.channel || "unknown",
                    [GENAI_ATTRS.OPENCLAW_SOURCE]: evt.source || "unknown",
                    [GENAI_ATTRS.OPENCLAW_QUEUE_DEPTH]: evt.queueDepth || 0,

                    // Standard semantic conventions
                    "openclaw.timestamp": evt.ts || Date.now(),
                    "openclaw.request_counter": requestCounter,
                  },
                });

                // Store trace
                activeTraces.set(evt.sessionKey, {
                  span,
                  startedAt: evt.ts || Date.now(),
                  sessionKey: evt.sessionKey,
                  agentId,
                  channel: evt.channel,
                });

                const spanContext = span.spanContext();
                ctx.logger.info(
                  `OTLP trace started: traceId=${spanContext.traceId} spanId=${spanContext.spanId} sessionKey=${evt.sessionKey} session.id=${evt.sessionKey} user.id=${agentId}`,
                );
              } catch (error) {
                ctx.logger.error(`Failed to start OTLP trace: ${String(error)}`);
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

              // Create LLM span as child of message span
              if (tracingInitialized && tracer && evt.sessionKey) {
                const activeTrace = activeTraces.get(evt.sessionKey);
                if (activeTrace?.span) {
                  try {
                    // Set prompt/completion on ROOT span for MLflow UI columns
                    // MLflow reads from root span only to populate Request/Response columns
                    if (evt.prompt) {
                      activeTrace.span.setAttribute(GENAI_ATTRS.PROMPT, evt.prompt);
                      activeTrace.span.setAttribute(
                        GENAI_ATTRS.MLFLOW_SPAN_INPUTS,
                        JSON.stringify({ role: "user", content: evt.prompt }),
                      );
                    }

                    if (evt.completion) {
                      activeTrace.span.setAttribute(GENAI_ATTRS.COMPLETION, evt.completion);
                      activeTrace.span.setAttribute(
                        GENAI_ATTRS.MLFLOW_SPAN_OUTPUTS,
                        JSON.stringify({ role: "assistant", content: evt.completion }),
                      );
                    }

                    // Create context with parent span
                    const parentContext = trace.setSpan(context.active(), activeTrace.span);

                    // Create child span in the context of the parent
                    const childSpan = tracer.startSpan(
                      `llm.${evt.provider}.${evt.model}`,
                      {
                        kind: 1, // SpanKind.INTERNAL
                        attributes: {
                          // GenAI semantic conventions
                          [GENAI_ATTRS.SYSTEM]: evt.provider || "unknown",
                          [GENAI_ATTRS.REQUEST_MODEL]: evt.model || "unknown",
                          [GENAI_ATTRS.RESPONSE_MODEL]: evt.model || "unknown",
                          [GENAI_ATTRS.INPUT_TOKENS]: evt.usage?.input || 0,
                          [GENAI_ATTRS.OUTPUT_TOKENS]: evt.usage?.output || 0,
                          [GENAI_ATTRS.TOTAL_TOKENS]: evt.usage?.total || 0,

                          // Prompt and completion for child span (also kept for reference)
                          ...(evt.prompt && { [GENAI_ATTRS.PROMPT]: evt.prompt }),
                          ...(evt.completion && { [GENAI_ATTRS.COMPLETION]: evt.completion }),

                          // Additional metrics
                          "llm.cost_usd": evt.costUsd || 0,
                          "llm.duration_ms": evt.durationMs || 0,
                          "llm.cache_read_tokens": evt.usage?.cacheRead || 0,
                          "llm.cache_write_tokens": evt.usage?.cacheWrite || 0,
                        },
                      },
                      parentContext,
                    );

                    // End span immediately
                    childSpan.setStatus({ code: SpanStatusCode.OK });
                    childSpan.end();
                  } catch (error) {
                    ctx.logger.warn(`Failed to create LLM span: ${String(error)}`);
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

              // End root trace span
              if (tracingInitialized && evt.sessionKey) {
                const trace = activeTraces.get(evt.sessionKey);
                if (trace?.span) {
                  try {
                    const durationMs = Date.now() - trace.startedAt;

                    // Set outcome as attribute
                    trace.span.setAttribute("message.outcome", evt.outcome || "unknown");
                    trace.span.setAttribute("message.reason", evt.reason || "");
                    trace.span.setAttribute("message.duration_ms", durationMs);

                    // Set status
                    if (evt.outcome === "error") {
                      trace.span.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: evt.error || "Unknown error",
                      });
                    } else {
                      trace.span.setStatus({ code: SpanStatusCode.OK });
                    }

                    // End span
                    trace.span.end();

                    const spanContext = trace.span.spanContext();
                    ctx.logger.info(
                      `OTLP trace ended: traceId=${spanContext.traceId} sessionKey=${evt.sessionKey} outcome=${evt.outcome} duration=${durationMs}ms`,
                    );
                  } catch (error) {
                    ctx.logger.error(`Failed to end OTLP trace: ${String(error)}`);
                  }
                  activeTraces.delete(evt.sessionKey);
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

        // Subscribe to agent events for tool/lifecycle spans
        if (tracesEnabled && tracingInitialized && tracer) {
          unsubscribeAgentEvents = onAgentEvent((evt: AgentEventPayload) => {
            const activeTrace = evt.sessionKey ? activeTraces.get(evt.sessionKey) : null;

            switch (evt.stream) {
              case "tool": {
                if (!activeTrace || !tracer) return;

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
                    // Create context with parent span for nesting
                    const parentContext = trace.setSpan(context.active(), activeTrace.span);

                    const span = tracer.startSpan(
                      `tool.${toolName}`,
                      {
                        kind: 1,
                        attributes: {
                          "tool.name": toolName,
                          "tool.call_id": toolCallId,
                          "tool.run_id": evt.runId,
                        },
                      },
                      parentContext,
                    ); // Pass parent context for nesting

                    activeSpans.set(toolCallId, span);
                  } catch (error) {
                    ctx.logger.warn(`Failed to start tool span for ${toolName}: ${String(error)}`);
                  }
                } else if (phase === "end") {
                  const span = activeSpans.get(toolCallId);
                  if (span) {
                    try {
                      if (data.error) {
                        span.setStatus({
                          code: SpanStatusCode.ERROR,
                          message: data.error,
                        });
                      } else {
                        span.setStatus({ code: SpanStatusCode.OK });
                      }
                      span.end();
                    } catch (error) {
                      ctx.logger.warn(`Failed to end tool span for ${toolName}: ${String(error)}`);
                    }
                    activeSpans.delete(toolCallId);
                  }
                }
                break;
              }

              case "error": {
                if (!activeTrace) return;

                const data = evt.data as { error?: string; message?: string; stack?: string };
                try {
                  // Record error event on the parent span
                  activeTrace.span.recordException({
                    name: data.error || data.message || "Unknown error",
                    message: data.message,
                    stack: data.stack,
                  });
                  activeTrace.span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: data.error || data.message || "Unknown error",
                  });
                } catch (error) {
                  ctx.logger.warn(`Failed to record error on span: ${String(error)}`);
                }
                break;
              }
            }
          });
        }

        ctx.logger.info(
          `diagnostics-opentelemetry: started (metrics${tracesEnabled && tracingInitialized ? " + OTLP traces" : ""})`,
        );
      } catch (error) {
        ctx.logger.error(`diagnostics-opentelemetry: failed to start: ${String(error)}`);
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
      for (const [, span] of activeSpans) {
        try {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "Service stopped" });
          span.end();
        } catch {
          // Ignore errors during cleanup
        }
      }
      activeSpans.clear();

      // End any remaining traces
      for (const [, trace] of activeTraces) {
        if (trace.span) {
          try {
            trace.span.setStatus({ code: SpanStatusCode.ERROR, message: "Service stopped" });
            trace.span.end();
          } catch {
            // Ignore errors during cleanup
          }
        }
      }
      activeTraces.clear();

      // Shutdown OpenTelemetry provider (flushes all pending spans)
      if (provider) {
        await provider.shutdown();
        provider = null;
        tracer = null;
        tracingInitialized = false;
      }

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
    },
  } satisfies OpenClawPluginService;
}

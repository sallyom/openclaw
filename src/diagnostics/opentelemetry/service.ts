/**
 * OpenTelemetry instrumentation for OpenClaw
 * Exports traces via OTLP protocol to observability backends
 * (MLflow, Jaeger, Grafana, OTEL collectors, etc.)
 */

import type { Logger } from "tslog";
import { trace, context, SpanStatusCode, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from "@opentelemetry/semantic-conventions";
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentEventPayload } from "../../infra/agent-events.js";
import type { DiagnosticEventPayload } from "../../infra/diagnostic-events.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { onDiagnosticEvent } from "../../infra/diagnostic-events.js";

interface OpenTelemetryConfig {
  enabled?: boolean;
  otlpEndpoint?: string; // OTLP endpoint (e.g., http://localhost:4318/v1/traces, https://mlflow/v1/traces)
  otlpHeaders?: Record<string, string>; // Additional OTLP headers (e.g., {"x-mlflow-experiment-id": "4"})
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

  const activeTrace = activeTracesGlobal.get(sessionKey);
  if (!activeTrace?.span) {
    return null;
  }

  const spanContext = activeTrace.span.spanContext();

  // Return W3C Trace Context headers
  return {
    traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-01`,
    tracestate: spanContext.traceState?.serialize() || "",
  };
}

export async function startOpenTelemetryDiagnostics(
  config: OpenClawConfig,
  logger: Logger<unknown>,
): Promise<() => Promise<void>> {
  const cfg = (config.diagnostics?.opentelemetry as OpenTelemetryConfig | undefined) || {};

  const enabled = cfg.enabled ?? !!process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!enabled) {
    logger.info(
      "OpenTelemetry tracing disabled (set diagnostics.opentelemetry.enabled or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT to enable)",
    );
    return async () => {}; // No-op cleanup
  }

  const otlpEndpoint =
    cfg.otlpEndpoint ||
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    "http://localhost:4318/v1/traces";

  const otlpHeaders = cfg.otlpHeaders || {};

  let unsubscribe: (() => void) | null = null;
  let unsubscribeAgentEvents: (() => void) | null = null;
  let provider: NodeTracerProvider | null = null;
  let tracer: ReturnType<typeof trace.getTracer> | null = null;

  // Active traces and spans
  const activeTraces = activeTracesGlobal;
  const activeSpans = new Map<string, Span>(); // toolCallId -> span

  try {
    // Initialize OpenTelemetry tracing
    const resource = resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: "openclaw",
      [SEMRESATTRS_SERVICE_VERSION]: process.env.npm_package_version || "unknown",
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]:
        process.env.NODE_ENV || process.env.OPENCLAW_ENV || "production",
    });

    provider = new NodeTracerProvider({ resource });

    const exporter = new OTLPTraceExporter({
      url: otlpEndpoint,
      headers: otlpHeaders,
    });

    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    provider.register();

    tracer = trace.getTracer("openclaw", process.env.npm_package_version || "1.0.0");

    logger.info(
      `OpenTelemetry tracing initialized (OTLP endpoint: ${otlpEndpoint}, headers: ${JSON.stringify(otlpHeaders)})`,
    );

    // Subscribe to diagnostic events for trace/span lifecycle
    unsubscribe = onDiagnosticEvent(async (evt: DiagnosticEventPayload) => {
      switch (evt.type) {
        case "message.queued": {
          // Start root trace for message processing
          if (!tracer) return;
          if (!evt.sessionKey) {
            logger.warn("message.queued but no sessionKey provided");
            return;
          }

          try {
            logger.info(`Creating OTLP trace for sessionKey=${evt.sessionKey}`);

            // Extract agent ID from sessionKey (format: agent:{agentId}:{channel}:{conversationId?})
            const agentId = evt.sessionKey?.split(":")[1] || "unknown";

            const rootSpan = tracer.startSpan("message.process", {
              kind: 1, // SERVER
              attributes: {
                [GENAI_ATTRS.SESSION_ID]: evt.sessionKey,
                [GENAI_ATTRS.USER_ID]: agentId,
                [GENAI_ATTRS.OPENCLAW_SESSION_KEY]: evt.sessionKey,
                [GENAI_ATTRS.OPENCLAW_AGENT_ID]: agentId,
                [GENAI_ATTRS.OPENCLAW_CHANNEL]: evt.channel || "unknown",
                [GENAI_ATTRS.OPENCLAW_SOURCE]: evt.source,
                [GENAI_ATTRS.OPENCLAW_QUEUE_DEPTH]: evt.queueDepth || 0,

                // CRITICAL: MLflow UI reads these for Session/User columns
                [GENAI_ATTRS.MLFLOW_TRACE_SESSION]: evt.sessionKey,
                [GENAI_ATTRS.MLFLOW_TRACE_USER]: agentId,
              },
            });

            logger.info(
              `OTLP trace started with attributes: mlflow.trace.session=${evt.sessionKey} mlflow.trace.user=${agentId}`,
            );

            // Store trace with agentId for later
            activeTraces.set(evt.sessionKey, {
              span: rootSpan,
              startedAt: evt.ts || Date.now(),
              sessionKey: evt.sessionKey,
              agentId,
              channel: evt.channel,
            });
          } catch (error) {
            logger.error(`Failed to start OTLP trace: ${String(error)}`);
          }
          break;
        }

        case "model.usage": {
          // Create LLM span
          const activeTrace = evt.sessionKey ? activeTraces.get(evt.sessionKey) : null;
          if (!activeTrace || !tracer) return;

          try {
            const parentContext = trace.setSpan(context.active(), activeTrace.span);

            const llmSpan = tracer.startSpan(
              `llm.${evt.provider || "unknown"}.${evt.model || "unknown"}`,
              {
                kind: 3, // CLIENT
                attributes: {
                  [GENAI_ATTRS.SYSTEM]: evt.provider || "unknown",
                  [GENAI_ATTRS.REQUEST_MODEL]: evt.model || "unknown",
                  [GENAI_ATTRS.RESPONSE_MODEL]: evt.model || "unknown",
                  [GENAI_ATTRS.INPUT_TOKENS]: evt.usage?.input || evt.usage?.promptTokens || 0,
                  [GENAI_ATTRS.OUTPUT_TOKENS]: evt.usage?.output || 0,
                  [GENAI_ATTRS.TOTAL_TOKENS]: evt.usage?.total || 0,
                  [GENAI_ATTRS.PROMPT]: evt.prompt || "",
                  [GENAI_ATTRS.COMPLETION]: evt.completion || "",
                },
              },
              parentContext,
            );

            // Set span inputs/outputs for MLflow UI
            llmSpan.setAttribute(
              GENAI_ATTRS.MLFLOW_SPAN_INPUTS,
              JSON.stringify({ prompt: evt.prompt }),
            );
            llmSpan.setAttribute(
              GENAI_ATTRS.MLFLOW_SPAN_OUTPUTS,
              JSON.stringify({ completion: evt.completion }),
            );

            llmSpan.end();
          } catch (error) {
            logger.warn(`Failed to create LLM span: ${String(error)}`);
          }
          break;
        }

        case "message.processed": {
          // End root trace
          const activeTrace = evt.sessionKey ? activeTraces.get(evt.sessionKey) : null;
          if (!activeTrace) return;

          try {
            if (evt.outcome === "error" && evt.error) {
              activeTrace.span.setStatus({
                code: SpanStatusCode.ERROR,
                message: evt.error,
              });
            } else {
              activeTrace.span.setStatus({ code: SpanStatusCode.OK });
            }

            activeTrace.span.end();
            activeTraces.delete(evt.sessionKey!);

            logger.info(`OTLP trace ended for sessionKey=${evt.sessionKey} outcome=${evt.outcome}`);
          } catch (error) {
            logger.error(`Failed to end OTLP trace: ${String(error)}`);
          }
          break;
        }
      }
    });

    // Subscribe to agent events for tool/lifecycle spans
    if (tracer) {
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
                    kind: 1, // SERVER
                    attributes: {
                      "tool.name": toolName,
                      "tool.call_id": toolCallId,
                      "tool.run_id": evt.runId,
                    },
                  },
                  parentContext,
                );

                activeSpans.set(toolCallId, span);
              } catch (error) {
                logger.warn(`Failed to start tool span for ${toolName}: ${String(error)}`);
              }
            } else if (phase === "end") {
              const span = activeSpans.get(toolCallId);
              if (span) {
                try {
                  if (data.error) {
                    span.setStatus({ code: SpanStatusCode.ERROR, message: data.error });
                  } else {
                    span.setStatus({ code: SpanStatusCode.OK });
                  }
                  span.end();
                } catch (error) {
                  logger.warn(`Failed to end tool span for ${toolName}: ${String(error)}`);
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
              logger.warn(`Failed to record error on span: ${String(error)}`);
            }
            break;
          }
        }
      });
    }

    logger.info("diagnostics-opentelemetry: started (OTLP traces enabled)");
  } catch (error) {
    logger.error(`diagnostics-opentelemetry: failed to start: ${String(error)}`);
    throw error;
  }

  // Return cleanup function
  return async () => {
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
    for (const [, activeTrace] of activeTraces) {
      if (activeTrace.span) {
        try {
          activeTrace.span.setStatus({ code: SpanStatusCode.ERROR, message: "Service stopped" });
          activeTrace.span.end();
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
    }

    unsubscribe?.();
    unsubscribe = null;
    unsubscribeAgentEvents?.();
    unsubscribeAgentEvents = null;
  };
}

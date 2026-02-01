/**
 * Langfuse integration for OpenClaw
 * Provides LLM-specific observability: traces, generations, scores
 */

import { Langfuse } from "langfuse";
import type { DiagnosticEventPayload, OpenClawPluginService } from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";

interface LangfuseConfig {
  enabled?: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  release?: string;
  environment?: string;
  flushAt?: number;
  flushInterval?: number;
  requestTimeout?: number;
}

export function createDiagnosticsLangfuseService(): OpenClawPluginService {
  let langfuse: Langfuse | null = null;
  let unsubscribe: (() => void) | null = null;

  // Track active traces and generations
  const sessionTraces = new Map<string, any>();
  const messageGenerations = new Map<string, any>();

  return {
    id: "diagnostics-langfuse",

    async start(ctx) {
      const cfg = ctx.config.diagnostics?.langfuse as LangfuseConfig | undefined;

      if (!cfg?.enabled) {
        return;
      }

      const publicKey =
        cfg.publicKey || process.env.LANGFUSE_PUBLIC_KEY;
      const secretKey =
        cfg.secretKey || process.env.LANGFUSE_SECRET_KEY;
      const baseUrl =
        cfg.baseUrl || process.env.LANGFUSE_HOST || "https://cloud.langfuse.com";

      if (!publicKey || !secretKey) {
        ctx.logger.warn(
          "diagnostics-langfuse: missing credentials (LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY)",
        );
        return;
      }

      langfuse = new Langfuse({
        publicKey,
        secretKey,
        baseUrl,
        release: cfg.release || process.env.OPENCLAW_VERSION || "unknown",
        environment: cfg.environment || process.env.NODE_ENV || "production",
        flushAt: cfg.flushAt || 15,
        flushInterval: cfg.flushInterval || 10000,
        requestTimeout: cfg.requestTimeout || 10000,
      });

      // Subscribe to diagnostic events
      unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        if (!langfuse) return;

        switch (evt.type) {
          case "message.queued": {
            // Start a new trace for this message/session
            if (evt.sessionKey) {
              const trace = langfuse.trace({
                id: evt.sessionKey,
                name: "openclaw-session",
                userId: evt.channel || "unknown",
                metadata: {
                  channel: evt.channel,
                  source: evt.source,
                  sessionKey: evt.sessionKey,
                  sessionId: evt.sessionId,
                },
                tags: [evt.channel || "unknown", evt.source || "unknown"],
              });
              sessionTraces.set(evt.sessionKey, trace);
            }
            break;
          }

          case "model.usage": {
            // Create a generation for this model call
            const trace =
              evt.sessionKey && sessionTraces.get(evt.sessionKey);

            if (trace) {
              const generation = trace.generation({
                name: evt.model || "unknown-model",
                model: evt.model,
                modelParameters: {
                  provider: evt.provider,
                },
                startTime: evt.timestamp
                  ? new Date(evt.timestamp - (evt.durationMs || 0))
                  : undefined,
                endTime: evt.timestamp ? new Date(evt.timestamp) : undefined,
                usage: {
                  input: evt.usage?.input,
                  output: evt.usage?.output,
                  total: evt.usage?.total,
                  unit: "TOKENS",
                },
                metadata: {
                  provider: evt.provider,
                  channel: evt.channel,
                  sessionKey: evt.sessionKey,
                  sessionId: evt.sessionId,
                  cacheRead: evt.usage?.cacheRead,
                  cacheWrite: evt.usage?.cacheWrite,
                  contextLimit: evt.context?.limit,
                  contextUsed: evt.context?.used,
                },
              });

              if (evt.costUsd !== undefined) {
                generation.update({
                  usage: {
                    input: evt.usage?.input,
                    output: evt.usage?.output,
                    total: evt.usage?.total,
                    unit: "TOKENS",
                    inputCost: evt.costUsd,
                    outputCost: 0,
                    totalCost: evt.costUsd,
                  },
                });
              }

              // Store for potential updates
              const genKey = `${evt.sessionKey}:${evt.timestamp}`;
              messageGenerations.set(genKey, generation);
            }
            break;
          }

          case "message.processed": {
            // Update trace with outcome
            const trace =
              evt.sessionKey && sessionTraces.get(evt.sessionKey);

            if (trace) {
              trace.update({
                output: {
                  outcome: evt.outcome,
                  reason: evt.reason,
                  durationMs: evt.durationMs,
                },
                metadata: {
                  outcome: evt.outcome,
                  reason: evt.reason,
                  messageId: evt.messageId,
                  chatId: evt.chatId,
                },
              });

              // Add a score if there was an error
              if (evt.outcome === "error") {
                trace.score({
                  name: "error",
                  value: 1,
                  comment: evt.error || evt.reason,
                });
              } else if (evt.outcome === "success") {
                trace.score({
                  name: "success",
                  value: 1,
                });
              }
            }
            break;
          }

          case "webhook.processed": {
            // Create a span for webhook processing
            const trace = langfuse.trace({
              name: "webhook",
              metadata: {
                channel: evt.channel,
                updateType: evt.updateType,
                chatId: evt.chatId,
                durationMs: evt.durationMs,
              },
              tags: ["webhook", evt.channel || "unknown"],
            });

            if (evt.durationMs) {
              trace.span({
                name: `webhook.${evt.updateType || "unknown"}`,
                startTime: evt.timestamp
                  ? new Date(evt.timestamp - evt.durationMs)
                  : undefined,
                endTime: evt.timestamp ? new Date(evt.timestamp) : undefined,
                metadata: {
                  channel: evt.channel,
                  updateType: evt.updateType,
                },
              });
            }
            break;
          }

          case "webhook.error": {
            // Create an error event
            langfuse.event({
              name: "webhook.error",
              metadata: {
                channel: evt.channel,
                updateType: evt.updateType,
                error: evt.error,
                chatId: evt.chatId,
              },
              level: "ERROR",
            });
            break;
          }

          case "session.stuck": {
            // Create an error event for stuck sessions
            const trace =
              evt.sessionKey && sessionTraces.get(evt.sessionKey);

            if (trace) {
              trace.event({
                name: "session.stuck",
                metadata: {
                  state: evt.state,
                  ageMs: evt.ageMs,
                  queueDepth: evt.queueDepth,
                },
                level: "ERROR",
              });

              trace.score({
                name: "stuck",
                value: 1,
                comment: `Session stuck in ${evt.state} for ${evt.ageMs}ms`,
              });
            }
            break;
          }
        }
      });

      ctx.logger.info("diagnostics-langfuse: started");
    },

    async stop() {
      unsubscribe?.();
      unsubscribe = null;

      // Flush any pending data
      if (langfuse) {
        await langfuse.flushAsync();
        await langfuse.shutdownAsync();
        langfuse = null;
      }

      sessionTraces.clear();
      messageGenerations.clear();
    },
  } satisfies OpenClawPluginService;
}

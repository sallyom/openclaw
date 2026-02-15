// Anthropic Vertex AI streaming implementation.
//
// This mirrors pi-ai's built-in streamAnthropic but swaps the client constructor
// from `new Anthropic({ apiKey })` to `new AnthropicVertex({ projectId, region })`
// for GCP IAM authentication. A custom stream function is necessary because:
//   1. pi-ai hardcodes `new Anthropic(...)` — no way to inject AnthropicVertex
//   2. Vertex rewrites `/v1/messages` to a project-scoped path that only
//      AnthropicVertex.buildRequest() knows how to construct
//
// Ideally pi-ai would accept a pluggable client constructor so providers like
// Vertex wouldn't need to duplicate the streaming logic. (Bedrock doesn't have
// this problem — pi-ai has a built-in bedrock-converse-stream provider.)

import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  Message,
  SimpleStreamOptions,
  StopReason,
} from "@mariozechner/pi-ai";
import {
  calculateCost,
  createAssistantMessageEventStream,
  parseStreamingJson,
} from "@mariozechner/pi-ai";

// ── Wire-format types for the Anthropic streaming API ───────────────────────
// Minimal types for the SSE events and message params. The Anthropic SDK
// validates at runtime; these just satisfy the compiler for event field access.

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

interface StreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string; input?: Record<string, unknown> };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  message?: {
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

// Mutable content block with temporary tracking fields used during streaming.
// The `index` and `partialJson` fields are deleted before the final output.
interface StreamBlock {
  type: string;
  text?: string;
  thinking?: string;
  thinkingSignature?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  index?: number;
  partialJson?: string;
}

// ── Message conversion ──────────────────────────────────────────────────────

function convertMessages(messages: Message[]): unknown[] {
  const result: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const blocks: unknown[] = [];
        for (const part of msg.content) {
          if (part.type === "text") {
            blocks.push({ type: "text", text: part.text });
          } else if (part.type === "image") {
            blocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: (part.mimeType || "image/png") as ImageMediaType,
                data: part.data,
              },
            });
          }
        }
        if (blocks.length > 0) {
          result.push({ role: "user", content: blocks });
        }
      }
    } else if (msg.role === "assistant") {
      const blocks: unknown[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          blocks.push({ type: "text", text: part.text });
        } else if (part.type === "thinking") {
          blocks.push({
            type: "thinking",
            thinking: part.thinking,
            signature: part.thinkingSignature ?? "",
          });
        } else if (part.type === "toolCall") {
          blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.arguments });
        }
      }
      if (blocks.length > 0) {
        result.push({ role: "assistant", content: blocks });
      }
    } else if (msg.role === "toolResult") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        is_error: msg.isError,
        content: msg.content.map((part) =>
          part.type === "image"
            ? {
                type: "image",
                source: {
                  type: "base64",
                  media_type: (part.mimeType || "image/png") as ImageMediaType,
                  data: part.data,
                },
              }
            : { type: "text", text: part.text },
        ),
      };
      // Merge consecutive tool results into the same user message
      const last = result[result.length - 1] as { role?: string; content?: unknown[] } | undefined;
      if (
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((b) => (b as { type: string }).type === "tool_result")
      ) {
        last.content.push(toolResult);
        continue;
      }
      result.push({ role: "user", content: [toolResult] });
    }
  }
  return result;
}

function convertTools(tools: Context["tools"]): unknown[] | undefined {
  if (!tools?.length) {
    return undefined;
  }
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters ?? { type: "object", properties: {} },
  }));
}

// ── Stream function ─────────────────────────────────────────────────────────

function mapStopReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_use") {
    return "toolUse";
  }
  if (reason === "max_tokens") {
    return "length";
  }
  return "stop";
}

export function createAnthropicVertexStreamFn(projectId: string, region: string): StreamFn {
  return (model, context, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };

      // Mutable block array — tracks `index` and `partialJson` during streaming,
      // which are cleaned up before emitting the final output.
      const blocks: StreamBlock[] = [];
      // Alias so event stream sees the same reference
      output.content = blocks as AssistantMessage["content"];

      try {
        const client = new AnthropicVertex({ projectId, region });
        const messages = convertMessages(context.messages ?? []);
        const tools = convertTools(context.tools);

        const params: Record<string, unknown> = {
          model: model.id,
          messages,
          max_tokens: options?.maxTokens ?? model.maxTokens ?? 8192,
          stream: true,
          ...(context.systemPrompt ? { system: context.systemPrompt } : {}),
          ...(tools ? { tools, tool_choice: { type: "auto" } } : {}),
          ...(typeof options?.temperature === "number" ? { temperature: options.temperature } : {}),
        };

        // Enable extended thinking if requested
        if (options?.reasoning) {
          const budgets = options.thinkingBudgets;
          const budgetTokens =
            (budgets && options.reasoning in budgets
              ? budgets[options.reasoning as keyof typeof budgets]
              : undefined) ?? 10000;
          params.thinking = { type: "enabled", budget_tokens: budgetTokens };
        }

        options?.onPayload?.(params);

        // Stream using the same raw SSE event pattern as pi-ai's streamAnthropic
        const anthropicStream = client.messages.stream(
          params as Parameters<typeof client.messages.stream>[0],
          { signal: options?.signal },
        );

        stream.push({ type: "start", partial: output });

        for await (const event of anthropicStream as AsyncIterable<StreamEvent>) {
          if (event.type === "message_start") {
            const u = event.message?.usage;
            if (u) {
              output.usage.input = u.input_tokens || 0;
              output.usage.output = u.output_tokens || 0;
              output.usage.cacheRead = u.cache_read_input_tokens || 0;
              output.usage.cacheWrite = u.cache_creation_input_tokens || 0;
              output.usage.totalTokens =
                output.usage.input +
                output.usage.output +
                output.usage.cacheRead +
                output.usage.cacheWrite;
              calculateCost(model, output.usage);
            }
          } else if (event.type === "content_block_start") {
            const cb = event.content_block;
            const idx = event.index ?? 0;
            if (cb?.type === "text") {
              blocks.push({ type: "text", text: "", index: idx });
              stream.push({ type: "text_start", contentIndex: blocks.length - 1, partial: output });
            } else if (cb?.type === "thinking") {
              blocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: idx });
              stream.push({
                type: "thinking_start",
                contentIndex: blocks.length - 1,
                partial: output,
              });
            } else if (cb?.type === "tool_use") {
              blocks.push({
                type: "toolCall",
                id: cb.id,
                name: cb.name,
                arguments: cb.input ?? {},
                partialJson: "",
                index: idx,
              });
              stream.push({
                type: "toolcall_start",
                contentIndex: blocks.length - 1,
                partial: output,
              });
            }
          } else if (event.type === "content_block_delta") {
            const delta = event.delta;
            const idx = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[idx];
            if (!block || !delta) {
              continue;
            }

            if (delta.type === "text_delta" && block.type === "text") {
              block.text = (block.text ?? "") + (delta.text ?? "");
              stream.push({
                type: "text_delta",
                contentIndex: idx,
                delta: delta.text ?? "",
                partial: output,
              });
            } else if (delta.type === "thinking_delta" && block.type === "thinking") {
              block.thinking = (block.thinking ?? "") + (delta.thinking ?? "");
              stream.push({
                type: "thinking_delta",
                contentIndex: idx,
                delta: delta.thinking ?? "",
                partial: output,
              });
            } else if (delta.type === "input_json_delta" && block.type === "toolCall") {
              block.partialJson = (block.partialJson ?? "") + (delta.partial_json ?? "");
              block.arguments = parseStreamingJson(block.partialJson);
              stream.push({
                type: "toolcall_delta",
                contentIndex: idx,
                delta: delta.partial_json ?? "",
                partial: output,
              });
            } else if (delta.type === "signature_delta" && block.type === "thinking") {
              block.thinkingSignature = (block.thinkingSignature || "") + (delta.signature ?? "");
            }
          } else if (event.type === "content_block_stop") {
            const idx = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[idx];
            if (!block) {
              continue;
            }
            delete block.index;

            if (block.type === "text") {
              stream.push({
                type: "text_end",
                contentIndex: idx,
                content: block.text ?? "",
                partial: output,
              });
            } else if (block.type === "thinking") {
              stream.push({
                type: "thinking_end",
                contentIndex: idx,
                content: block.thinking ?? "",
                partial: output,
              });
            } else if (block.type === "toolCall") {
              block.arguments = parseStreamingJson(block.partialJson);
              delete block.partialJson;
              stream.push({
                type: "toolcall_end",
                contentIndex: idx,
                toolCall: block as never,
                partial: output,
              });
            }
          } else if (event.type === "message_delta") {
            if (event.delta?.stop_reason) {
              output.stopReason = mapStopReason(event.delta.stop_reason);
            }
            const u = event.usage;
            if (u?.input_tokens != null) {
              output.usage.input = u.input_tokens;
            }
            if (u?.output_tokens != null) {
              output.usage.output = u.output_tokens;
            }
            if (u?.cache_read_input_tokens != null) {
              output.usage.cacheRead = u.cache_read_input_tokens;
            }
            if (u?.cache_creation_input_tokens != null) {
              output.usage.cacheWrite = u.cache_creation_input_tokens;
            }
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            calculateCost(model, output.usage);
          }
        }

        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
        stream.end();
      } catch (error) {
        for (const block of blocks) {
          delete block.index;
        }
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();

    return stream;
  };
}

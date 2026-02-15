import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  Message,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

// ── Anthropic SDK inline types ──────────────────────────────────────────────
// Inline the Anthropic SDK types we need to avoid importing @anthropic-ai/sdk
// directly (it's not a direct dependency — only available transitively via
// @anthropic-ai/vertex-sdk and @mariozechner/pi-ai).

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: ImageMediaType; data: string };
};
type AnthropicThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature: string;
};
type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content: Array<AnthropicTextBlock | AnthropicImageBlock>;
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

type AnthropicMessageParam = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

type AnthropicToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

type AnthropicMessageCreateParams = {
  model: string;
  messages: AnthropicMessageParam[];
  max_tokens: number;
  system?: string;
  tools?: AnthropicToolDef[];
  tool_choice?: { type: string };
  temperature?: number;
  thinking?: { type: string; budget_tokens: number };
};

// ── Message conversion ──────────────────────────────────────────────────────

function convertMessagesToAnthropic(messages: Message[]): AnthropicMessageParam[] {
  const result: AnthropicMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const blocks: AnthropicContentBlock[] = [];
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
      const blocks: AnthropicContentBlock[] = [];
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
          blocks.push({
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: part.arguments,
          });
        }
      }
      if (blocks.length > 0) {
        result.push({ role: "assistant", content: blocks });
      }
    } else if (msg.role === "toolResult") {
      const toolResultBlock: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        is_error: msg.isError,
        content: msg.content.map((part) => {
          if (part.type === "image") {
            return {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: (part.mimeType || "image/png") as ImageMediaType,
                data: part.data,
              },
            };
          }
          return { type: "text" as const, text: part.text };
        }),
      };

      // Merge consecutive tool results into the same user message
      const lastMsg = result[result.length - 1];
      if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
        const lastContent = lastMsg.content;
        if (
          Array.isArray(lastContent) &&
          lastContent.every((b) => (b as { type: string }).type === "tool_result")
        ) {
          lastContent.push(toolResultBlock);
          continue;
        }
      }
      result.push({ role: "user", content: [toolResultBlock] });
    }
  }

  return result;
}

function convertToolsToAnthropic(tools: Context["tools"]): AnthropicToolDef[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: (tool.parameters ?? { type: "object", properties: {} }) as Record<
      string,
      unknown
    >,
  }));
}

// ── Streaming ───────────────────────────────────────────────────────────────

function makeEmptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function extractCacheUsage(usageObj: Record<string, unknown>): {
  cacheRead: number;
  cacheWrite: number;
} {
  const cacheRead =
    typeof usageObj.cache_read_input_tokens === "number" ? usageObj.cache_read_input_tokens : 0;
  const cacheWrite =
    typeof usageObj.cache_creation_input_tokens === "number"
      ? usageObj.cache_creation_input_tokens
      : 0;
  return { cacheRead, cacheWrite };
}

function makeErrorMessage(
  errorText: string,
  modelInfo: { api: string; provider: string; id: string },
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: "error" as StopReason,
    errorMessage: errorText,
    api: modelInfo.api,
    provider: modelInfo.provider,
    model: modelInfo.id,
    usage: makeEmptyUsage(),
    timestamp: Date.now(),
  };
}

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
    const eventStream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const client = new AnthropicVertex({ projectId, region });

        const messages = convertMessagesToAnthropic(context.messages ?? []);
        const tools = convertToolsToAnthropic(context.tools);

        const params: AnthropicMessageCreateParams = {
          model: model.id,
          messages,
          max_tokens: options?.maxTokens ?? model.maxTokens ?? 8192,
          ...(context.systemPrompt ? { system: context.systemPrompt } : {}),
          ...(tools ? { tools, tool_choice: { type: "auto" } } : {}),
          ...(typeof options?.temperature === "number" ? { temperature: options.temperature } : {}),
        };

        // Enable thinking/reasoning if supported
        const reasoning = options?.reasoning;
        if (reasoning) {
          const budgets = options?.thinkingBudgets;
          const budgetTokens =
            (budgets && reasoning in budgets
              ? budgets[reasoning as keyof typeof budgets]
              : undefined) ?? 10000;
          params.thinking = {
            type: "enabled",
            budget_tokens: budgetTokens,
          };
        }

        options?.onPayload?.(params);

        const content: (TextContent | ThinkingContent | ToolCall)[] = [];
        const usage = makeEmptyUsage();
        let stopReason: StopReason = "stop";

        const partial: AssistantMessage = {
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason,
          timestamp: Date.now(),
        };

        eventStream.push({ type: "start", partial });

        // Track content block state for streaming
        const blockState: Map<
          number,
          { type: "text" | "thinking" | "tool_use"; partialJson: string }
        > = new Map();

        // Use the Anthropic SDK's streaming API. The stream() method returns
        // a MessageStream that emits typed events for each content block.
        const response = client.messages.stream(
          params as Parameters<typeof client.messages.stream>[0],
          {
            signal: options?.signal,
          },
        );

        response.on("contentBlock", (block) => {
          const idx = content.length;

          if (block.type === "text") {
            blockState.set(idx, { type: "text", partialJson: "" });
            content.push({ type: "text", text: "" });
            eventStream.push({ type: "text_start", contentIndex: idx, partial });
          } else if (block.type === "thinking") {
            blockState.set(idx, { type: "thinking", partialJson: "" });
            content.push({ type: "thinking", thinking: "" });
            eventStream.push({
              type: "thinking_start",
              contentIndex: idx,
              partial,
            });
          } else if (block.type === "tool_use") {
            blockState.set(idx, { type: "tool_use", partialJson: "" });
            content.push({
              type: "toolCall",
              id: block.id,
              name: block.name,
              arguments: {},
            });
            eventStream.push({
              type: "toolcall_start",
              contentIndex: idx,
              partial,
            });
          }
        });

        response.on("text", (text: string, snapshot: string) => {
          const idx = content.length - 1;
          const block = content[idx];
          if (block?.type === "text") {
            block.text = snapshot;
            eventStream.push({
              type: "text_delta",
              contentIndex: idx,
              delta: text,
              partial,
            });
          }
        });

        response.on("thinking", (delta: string, snapshot: string) => {
          const idx = content.length - 1;
          const block = content[idx];
          if (block?.type === "thinking") {
            block.thinking = snapshot;
            eventStream.push({
              type: "thinking_delta",
              contentIndex: idx,
              delta,
              partial,
            });
          }
        });

        response.on("inputJson", (json: string, _snapshot: unknown) => {
          const idx = content.length - 1;
          const state = blockState.get(idx);
          if (state?.type === "tool_use") {
            state.partialJson += json;
            eventStream.push({
              type: "toolcall_delta",
              contentIndex: idx,
              delta: json,
              partial,
            });
          }
        });

        // Wait for the stream to complete
        const finalMessage = await response.finalMessage();

        // Emit end events for all content blocks
        for (let i = 0; i < finalMessage.content.length; i++) {
          const block = finalMessage.content[i];

          if (block.type === "text" && i < content.length) {
            const textBlock = content[i] as TextContent;
            textBlock.text = block.text;
            eventStream.push({
              type: "text_end",
              contentIndex: i,
              content: block.text,
              partial,
            });
          } else if (block.type === "thinking" && i < content.length) {
            const thinkBlock = content[i] as ThinkingContent;
            thinkBlock.thinking = block.thinking;
            if ("signature" in block && typeof block.signature === "string") {
              thinkBlock.thinkingSignature = block.signature;
            }
            eventStream.push({
              type: "thinking_end",
              contentIndex: i,
              content: block.thinking,
              partial,
            });
          } else if (block.type === "tool_use" && i < content.length) {
            const toolBlock = content[i] as ToolCall;
            toolBlock.arguments = block.input as Record<string, unknown>;
            eventStream.push({
              type: "toolcall_end",
              contentIndex: i,
              toolCall: toolBlock,
              partial,
            });
          }
        }

        // Update final usage
        if (finalMessage.usage) {
          usage.input = finalMessage.usage.input_tokens;
          usage.output = finalMessage.usage.output_tokens;
          const cache = extractCacheUsage(finalMessage.usage as unknown as Record<string, unknown>);
          usage.cacheRead = cache.cacheRead;
          usage.cacheWrite = cache.cacheWrite;
          usage.totalTokens = usage.input + usage.output;
        }

        stopReason = mapStopReason(finalMessage.stop_reason);
        partial.stopReason = stopReason;

        const doneReason: Extract<StopReason, "stop" | "length" | "toolUse"> =
          stopReason === "toolUse" ? "toolUse" : stopReason === "length" ? "length" : "stop";

        eventStream.push({
          type: "done",
          reason: doneReason,
          message: partial,
        });
      } catch (err) {
        const isAbort =
          err instanceof Error &&
          (err.name === "AbortError" ||
            err.name === "TimeoutError" ||
            (options?.signal?.aborted ?? false));

        const errorMessage = err instanceof Error ? err.message : String(err);
        const reason: Extract<StopReason, "aborted" | "error"> = isAbort ? "aborted" : "error";

        eventStream.push({
          type: "error",
          reason,
          error: makeErrorMessage(errorMessage, {
            api: model.api,
            provider: model.provider,
            id: model.id,
          }),
        });
      } finally {
        eventStream.end();
      }
    };

    queueMicrotask(() => void run());
    return eventStream;
  };
}

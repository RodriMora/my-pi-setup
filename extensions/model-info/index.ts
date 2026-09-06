import { uuidv7 } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  emptyModelInfoState,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";

const CHARS_PER_ESTIMATED_TOKEN = 4;
const LIVE_UPDATE_INTERVAL_MS = 200;
const FIRST_MESSAGE_CHAR_LIMIT = 4_000;
const SUMMARY_CHAR_LIMIT = 120;

const SUMMARY_SYSTEM_PROMPT =
  "You are given the first user prompt of a coding session and the " +
  "assistant's final response to it. " +
  "Produce a very short summary of what this session is about and what was " +
  "accomplished. " +
  `Reply with a single concise phrase, at most ${SUMMARY_CHAR_LIMIT} characters, ` +
  "no quotes, no markdown, no preamble.";

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;

  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      text += candidate.text;
    }
  }
  return text.trim() || null;
}

function getFirstUserMessage(ctx: ExtensionContext): string | null {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "user") {
      return extractText(entry.message.content);
    }
  }
  return null;
}

function getLastAssistantText(ctx: ExtensionContext): string | null {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]!;
    if (entry.type === "message" && entry.message.role === "assistant") {
      const text = extractText(entry.message.content);
      if (text) return text;
    }
  }
  return null;
}

function isGptModel(model: Model<Api> | undefined): boolean {
  return model !== undefined && /gpt-5\./.test(model.id);
}

function cleanSummary(text: string): string | null {
  const cleaned = text
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“”'‘’`\s]+/, "")
    .replace(/["“”'‘’`\s]+$/, "");
  if (!cleaned) return null;
  return cleaned.length > SUMMARY_CHAR_LIMIT
    ? `${cleaned.slice(0, SUMMARY_CHAR_LIMIT - 1)}…`
    : cleaned;
}

function getSessionCost(ctx: ExtensionContext) {
  let cost = 0;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      cost += entry.message.usage.cost.total;
    }
  }

  return cost;
}

function estimateContentTokens(characters: number) {
  return Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);
}

export default function modelInfo(pi: ExtensionAPI) {
  let state = emptyModelInfoState();
  let contentStreamStart: number | null = null;
  let lastContentDeltaAt: number | null = null;
  let contentCharacters = 0;
  let firstContentDeltaCharacters = 0;
  let contentDeltaCount = 0;
  let sawToolCall = false;
  let runContentTokens = 0;
  let runContentStreamMs = 0;
  let lastLiveUpdate = 0;
  let currentContext: ExtensionContext | undefined;
  let firstMessageText: string | null = null;
  let summaryRequested = false;
  let summaryAbort: AbortController | null = null;

  const publish = () => pi.events.emit(MODEL_INFO_CHANNEL, { ...state });

  /**
   * Pick which model produces the session summary, based on the active model:
   * - any gpt-5.x model        -> the active model with low reasoning
   * - babel-litellm/Babel-LLM  -> the active model itself
   * - local-dgx/*              -> the active model itself
   */
  function resolveSummaryModel(
    ctx: ExtensionContext,
  ): { model: Model<Api>; reasoningEffort?: "low" } | undefined {
    const main = ctx.model;
    if (!main) return undefined;

    if (isGptModel(main)) {
      // Keep summaries on the active model's provider and credentials.
      if (ctx.modelRegistry.hasConfiguredAuth(main)) {
        return { model: main, reasoningEffort: "low" };
      }
      return undefined;
    }

    // babel-litellm / local-dgx (and any other non-gpt active model): use itself.
    return ctx.modelRegistry.hasConfiguredAuth(main)
      ? { model: main }
      : undefined;
  }

  async function generateSummary(ctx: ExtensionContext) {
    const controller = new AbortController();
    summaryAbort = controller;
    state = { ...state, summarizing: true };
    publish();

    try {
      const target = resolveSummaryModel(ctx);
      if (!target) {
        state = { ...state, summarizing: false };
        return;
      }

      const lastAssistantText = getLastAssistantText(ctx);

      const response = await ctx.modelRegistry.complete(
        target.model,
        {
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          messages: [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `FIRST PROMPT:\n${firstMessageText!.slice(0, FIRST_MESSAGE_CHAR_LIMIT)}`,
                },
                ...(lastAssistantText
                  ? [
                      {
                        type: "text" as const,
                        text: `FINAL RESPONSE:\n${lastAssistantText.slice(0, FIRST_MESSAGE_CHAR_LIMIT)}`,
                      },
                    ]
                  : []),
              ],
              timestamp: Date.now(),
            },
          ],
        },
        {
          maxTokens: 512,
          ...(target.reasoningEffort
            ? { reasoningEffort: target.reasoningEffort }
            : {}),
          cacheRetention: "none",
          sessionId: uuidv7(),
          signal: controller.signal,
        },
      );

      const text = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join(" ");

      state = {
        ...state,
        summarizing: false,
        summary: cleanSummary(text),
      };
    } catch {
      // Failures (including aborts) are non-fatal: the footer just shows no summary.
      if (!controller.signal.aborted) {
        state = { ...state, summarizing: false, summary: null };
      }
    } finally {
      if (summaryAbort === controller) summaryAbort = null;
      if (!controller.signal.aborted) publish();
    }
  }

  function requestSummary(ctx: ExtensionContext) {
    if (summaryRequested) return;
    summaryRequested = true;
    // Fire-and-forget: never block the main turn on summary generation.
    void generateSummary(ctx);
  }

  function refresh(ctx: ExtensionContext) {
    currentContext = ctx;
    const model = ctx.model;
    const usage = ctx.getContextUsage();

    state = {
      ...state,
      provider: model?.provider ?? "",
      modelId: model?.id ?? "no-model",
      modelName: model?.name ?? model?.id ?? "No model",
      thinking: model?.reasoning ? pi.getThinkingLevel() : "off",
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
      contextPercent: usage?.percent ?? null,
      cost: getSessionCost(ctx),
    };
    publish();
  }

  function resetMessageTracking() {
    contentStreamStart = null;
    lastContentDeltaAt = null;
    contentCharacters = 0;
    firstContentDeltaCharacters = 0;
    contentDeltaCount = 0;
    sawToolCall = false;
    lastLiveUpdate = 0;
  }

  const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, () => {
    if (currentContext) refresh(currentContext);
  });

  pi.on("session_start", (_event, ctx) => {
    resetMessageTracking();
    runContentTokens = 0;
    runContentStreamMs = 0;
    summaryAbort?.abort();
    summaryAbort = null;
    summaryRequested = false;
    firstMessageText = getFirstUserMessage(ctx);
    state = {
      ...state,
      tokensPerSecond: null,
      generating: false,
      summary: null,
      summarizing: false,
    };
    refresh(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    state = {
      ...state,
      provider: event.model.provider,
      modelId: event.model.id,
      modelName: event.model.name,
      thinking: event.model.reasoning ? pi.getThinkingLevel() : "off",
      contextWindow: event.model.contextWindow,
    };
    refresh(ctx);
  });

  pi.on("thinking_level_select", (event) => {
    state = { ...state, thinking: event.level };
    publish();
  });

  pi.on("agent_start", (_event, ctx) => {
    runContentTokens = 0;
    runContentStreamMs = 0;
    resetMessageTracking();
    state = { ...state, tokensPerSecond: null, generating: true };
    refresh(ctx);
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") resetMessageTracking();
    if (event.message.role === "user" && firstMessageText === null) {
      firstMessageText = extractText(event.message.content);
    }
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type === "toolcall_delta") {
      sawToolCall = true;
      return;
    }
    if (
      streamEvent.type !== "text_delta" &&
      streamEvent.type !== "thinking_delta"
    )
      return;
    if (!streamEvent.delta) return;

    const now = Date.now();
    if (contentStreamStart === null) {
      contentStreamStart = now;
      firstContentDeltaCharacters = streamEvent.delta.length;
    }
    lastContentDeltaAt = now;
    contentCharacters += streamEvent.delta.length;
    contentDeltaCount += 1;

    const elapsedMs = now - contentStreamStart;
    const streamedCharacters = contentCharacters - firstContentDeltaCharacters;
    if (
      contentDeltaCount < 2 ||
      elapsedMs <= 0 ||
      streamedCharacters <= 0 ||
      now - lastLiveUpdate < LIVE_UPDATE_INTERVAL_MS
    ) {
      return;
    }
    lastLiveUpdate = now;

    state = {
      ...state,
      tokensPerSecond:
        estimateContentTokens(streamedCharacters) / (elapsedMs / 1000),
    };
    publish();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    sawToolCall ||= event.message.content.some(
      (block) => block.type === "toolCall",
    );

    if (contentStreamStart !== null && contentCharacters > 0) {
      const streamEnd = lastContentDeltaAt ?? contentStreamStart;
      const streamMs = streamEnd - contentStreamStart;
      const estimatedFirstDeltaTokens = estimateContentTokens(
        firstContentDeltaCharacters,
      );
      // Measure tokens received after the first content event over the interval
      // from the first event to the last. This avoids counting an initial chunk
      // as if it were generated instantaneously at t=0.
      const streamedTokens =
        !sawToolCall && event.message.usage.output > 0
          ? Math.max(0, event.message.usage.output - estimatedFirstDeltaTokens)
          : Math.max(
              0,
              estimateContentTokens(contentCharacters) -
                estimatedFirstDeltaTokens,
            );

      // A single event or a sub-50ms burst has no useful observable cadence.
      if (contentDeltaCount >= 2 && streamMs >= 50 && streamedTokens > 0) {
        runContentTokens += streamedTokens;
        runContentStreamMs += streamMs;
        state = {
          ...state,
          tokensPerSecond: runContentTokens / (runContentStreamMs / 1000),
        };
      }
    }

    resetMessageTracking();
    refresh(ctx);
  });

  pi.on("turn_end", (_event, ctx) => refresh(ctx));

  pi.on("agent_settled", (_event, ctx) => {
    state = { ...state, generating: false };
    refresh(ctx);
    // The first prompt's turn (including tool calls) has fully settled:
    // kick off the session summary in the background, using the first prompt
    // and the final response, so we never add latency to the first reply.
    if (firstMessageText !== null) requestSummary(ctx);
  });

  pi.on("session_shutdown", () => {
    stopRefreshListener();
    summaryAbort?.abort();
    summaryAbort = null;
    currentContext = undefined;
  });
}

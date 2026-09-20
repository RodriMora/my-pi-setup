/**
 * ask_user - Lets the model ask a single multiple-choice question.
 *
 * - 2 to 5 model-provided options, plus an always-present "Write my own answer" option
 * - Serialized inline UI: arrow keys or number keys to pick, Enter to confirm
 * - "Write my own answer" opens an inline editor (Esc returns to the options)
 * - Esc on the options dismisses the question (the model is told you declined)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";
import { createQuestionQueue } from "./src/question-queue.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;

const OptionSchema = Type.Object({
  label: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
  }),
  description: Type.Optional(
    Type.String({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
    }),
  ),
});

const AskUserParams = Type.Object({
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;

interface AskUserDetails {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom: boolean;
  cancelled: boolean;
  /** One-based option number; absent for custom answers and older records. */
  index?: number;
}

type SelectionResult =
  | { answer: string; wasCustom: false; index: number }
  | { answer: string; wasCustom: true }
  | null;

interface DisplayOption {
  label: string;
  description?: string;
  isOther?: boolean;
}

export default function askUser(pi: ExtensionAPI) {
  const questions = createQuestionQueue();
  pi.on("session_shutdown", () => questions.close());

  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reply = (
        text: string,
        answer: string | null = null,
        wasCustom = false,
        index?: number,
      ) => ({
        content: [{ type: "text" as const, text }],
        details: {
          question: params.question,
          options: params.options.map((o) => o.label),
          answer,
          wasCustom,
          cancelled: answer === null,
          ...(index === undefined ? {} : { index }),
        } satisfies AskUserDetails,
      });

      if (
        params.options.length < MIN_OPTIONS ||
        params.options.length > MAX_OPTIONS
      ) {
        throw new Error(
          `ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${params.options.length}). Retry with a valid number of options.`,
        );
      }

      if (ctx.mode !== "tui") {
        return reply(buildAskUserResultMessage({ kind: "no-ui" }));
      }

      if (signal?.aborted) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      const allOptions: DisplayOption[] = [
        ...params.options,
        { label: "Write my own answer…", isOther: true },
      ];

      const showQuestion = async (uiSignal: AbortSignal) => {
        let cleanup = () => {};
        try {
          return await ctx.ui.custom<SelectionResult>((tui, theme, _kb, done) => {
            let optionIndex = 0;
            let editMode = false;
            let focused = false;
            let settled = false;

            function finish(result: SelectionResult) {
              if (settled) return;
              cleanup();
              done(result);
            }

            function cancel() {
              finish(null);
            }

            const editorTheme: EditorTheme = {
              borderColor: (s) => theme.fg("accent", s),
              selectList: {
                selectedPrefix: (t) => theme.fg("accent", t),
                selectedText: (t) => theme.fg("accent", t),
                description: (t) => theme.fg("muted", t),
                scrollInfo: (t) => theme.fg("dim", t),
                noMatch: (t) => theme.fg("warning", t),
              },
            };
            const editor = new Editor(tui, editorTheme);

            editor.onSubmit = (value) => {
              if (settled) return;
              const trimmed = value.trim();
              if (trimmed) {
                finish({ answer: trimmed, wasCustom: true });
              } else {
                editMode = false;
                editor.setText("");
                refresh();
              }
            };

            function refresh() {
              if (settled) return;
              editor.focused = focused && editMode;
              tui.requestRender();
            }

            function selectOption(index: number) {
              const selected = allOptions[index];
              if (selected.isOther) {
                optionIndex = index;
                editMode = true;
                refresh();
              } else {
                finish({
                  answer: selected.label,
                  wasCustom: false,
                  index: index + 1,
                });
              }
            }

            function handleInput(data: string) {
              if (settled) return;
              if (editMode) {
                if (matchesKey(data, Key.escape)) {
                  editMode = false;
                  editor.setText("");
                  refresh();
                  return;
                }
                editor.handleInput(data);
                refresh();
                return;
              }

              if (matchesKey(data, Key.up)) {
                optionIndex =
                  (optionIndex - 1 + allOptions.length) % allOptions.length;
                refresh();
                return;
              }
              if (matchesKey(data, Key.down)) {
                optionIndex = (optionIndex + 1) % allOptions.length;
                refresh();
                return;
              }

              // Number keys jump straight to an option
              if (
                data.length === 1 &&
                data >= "1" &&
                data <= String(allOptions.length)
              ) {
                selectOption(Number(data) - 1);
                return;
              }

              if (matchesKey(data, Key.enter)) {
                selectOption(optionIndex);
                return;
              }

              if (matchesKey(data, Key.escape)) {
                finish(null);
              }
            }

            function render(width: number): string[] {
              width = Math.max(0, Math.floor(width));
              if (width === 0) return [""];
              // This small component is cheaper to render afresh than to maintain
              // caches across width, focus, editor state, and theme changes.
              const lines: string[] = [];
              const add = (s: string) => lines.push(truncateToWidth(s, width));
              const addWrapped = (prefix: string, text: string) => {
                const indent = Math.min(visibleWidth(prefix), width - 1);
                const lead = truncateToWidth(prefix, indent, "");
                const wrapped = wrapTextWithAnsi(text, width - indent);
                wrapped.forEach((line, index) => {
                  add(`${index === 0 ? lead : " ".repeat(indent)}${line}`);
                });
              };

              const title = " Question ";
              add(
                theme.fg(
                  "accent",
                  `─${title}${"─".repeat(Math.max(0, width - title.length - 1))}`,
                ),
              );
              addWrapped(" ", theme.fg("text", theme.bold(params.question)));
              lines.push("");

              for (let i = 0; i < allOptions.length; i++) {
                const opt = allOptions[i];
                const selected = i === optionIndex;
                const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
                const marker = opt.isOther ? "✎" : `${i + 1}.`;
                const label = `${marker} ${opt.label}`;

                if (selected || (opt.isOther && editMode)) {
                  addWrapped(prefix, theme.fg("accent", label));
                } else {
                  addWrapped(prefix, theme.fg(opt.isOther ? "muted" : "text", label));
                }

                if (opt.description) {
                  addWrapped("      ", theme.fg("muted", opt.description));
                }
              }

              if (editMode) {
                lines.push("");
                add(theme.fg("muted", " Your answer:"));
                // The Editor needs room for its border and cursor. On tiny
                // terminals keep input usable without passing invalid geometry.
                if (width >= 4) {
                  for (const line of editor.render(width - 2)) add(` ${line}`);
                } else {
                  add("…");
                }
              }

              lines.push("");
              if (editMode) {
                add(theme.fg("dim", " Enter submit • Esc back to options"));
              } else {
                add(
                  theme.fg(
                    "dim",
                    ` ↑↓ or 1-${allOptions.length} select • Enter confirm • Esc dismiss`,
                  ),
                );
              }
              add(theme.fg("accent", "─".repeat(width)));

              return lines;
            }

            cleanup = () => {
              settled = true;
              focused = false;
              editor.focused = false;
              uiSignal.removeEventListener("abort", cancel);
            };
            // Register only after initialization, so a factory failure cannot
            // strand an abort listener. A pre-install abort closes via done too.
            uiSignal.addEventListener("abort", cancel, { once: true });
            if (uiSignal.aborted) queueMicrotask(cancel);

            return {
              get focused() {
                return focused;
              },
              set focused(value: boolean) {
                focused = value && !settled;
                editor.focused = focused && editMode;
              },
              render,
              invalidate: () => editor.invalidate(),
              handleInput,
              dispose: cleanup,
            };
          });
        } finally {
          cleanup();
        }
      };

      const result = await questions.run(showQuestion, signal);
      if (result === undefined) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      if (!result) {
        return reply(buildAskUserResultMessage({ kind: "dismissed" }));
      }

      if (result.wasCustom) {
        return reply(
          buildAskUserResultMessage({
            kind: "custom",
            answer: result.answer,
          }),
          result.answer,
          true,
        );
      }

      return reply(
        buildAskUserResultMessage({
          kind: "selected",
          answer: result.answer,
          index: result.index,
        }),
        result.answer,
        false,
        result.index,
      );
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg(
        "muted",
        typeof args.question === "string" ? args.question : "",
      );
      const opts = Array.isArray(args.options)
        ? (args.options as DisplayOption[])
        : [];
      if (opts.length > 0) {
        const numbered = opts.map((o, i) => `${i + 1}. ${o.label}`);
        text += `\n${theme.fg("dim", `  ${numbered.join("  ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }

      if (details.cancelled || details.answer === null) {
        return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
      }

      if (details.wasCustom) {
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "(wrote) ") +
            theme.fg("accent", details.answer),
          0,
          0,
        );
      }

      const stored = details.index;
      const first = details.options.indexOf(details.answer);
      const validStoredIndex =
        typeof stored === "number" && Number.isInteger(stored) &&
        stored > 0 && stored <= details.options.length &&
        details.options[stored - 1] === details.answer;
      // Older ambiguous records never stored which duplicate was chosen.
      const idx = validStoredIndex ? stored
        : first >= 0 && details.options.lastIndexOf(details.answer) === first
          ? first + 1
          : undefined;
      const display = idx === undefined
        ? details.answer
        : `${idx}. ${details.answer}`;
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("accent", display),
        0,
        0,
      );
    },
  });
}

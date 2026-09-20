import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import fileSearchTools, { type FdToolDetails, type RgToolDetails } from "./index.ts";
import { resolveBinary } from "./src/binaries.ts";
import { discardCapturedOutput, executeSearchProcess } from "./src/process.ts";
import type { CapturedOutput } from "./src/output.ts";

// Keep real argument construction, Effects, and untruncated output formatting,
// but never load SDK settings/models, probe/download binaries, or access disk.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  DEFAULT_MAX_BYTES: 50 * 1024,
  DEFAULT_MAX_LINES: 2000,
  formatSize: vi.fn(() => { throw new Error("Unexpected size formatting"); }),
  truncateHead: vi.fn(() => { throw new Error("Unexpected SDK truncation"); }),
}));
vi.mock("@earendil-works/pi-ai", async () => {
  const { Type } = await import("typebox");
  return {
    StringEnum: (values: string[], options: Record<string, unknown>) =>
      Type.Union(values.map((value) => Type.Literal(value)), options),
  };
});
vi.mock("@effect/platform-node", async () => {
  const { Layer } = await import("effect");
  return { NodeServices: { layer: Layer.empty } };
});
vi.mock("@earendil-works/pi-tui", () => ({
  // Inspect the component returned by the registered renderer without ANSI or
  // terminal wrapping obscuring the renderer's own line bounds and colors.
  Text: class {
    constructor(private text: string) {}
    render() { return this.text.split("\n"); }
    invalidate() {}
  },
}));
vi.mock("./src/binaries.ts", () => ({
  repositoryBinDir: () => "/virtual/bin",
  currentTarget: () => ({ os: "linux", arch: "x64" }),
  liveBinaryEnv: {},
  TOOL_SPECS: { fd: { tool: "fd" }, rg: { tool: "rg" } },
  resolveBinary: vi.fn(),
}));
vi.mock("./src/process.ts", () => ({
  executeSearchProcess: vi.fn(),
  discardCapturedOutput: vi.fn(),
}));

type ToolName = "fd" | "rg";
type Details = FdToolDetails | RgToolDetails;
type RegisteredTool = ToolDefinition<TSchema, Details | undefined>;
type Result = AgentToolResult<Details | undefined>;
const image = { type: "image", data: "ignored-image-payload", mimeType: "image/png" } as const;
const textBlock = (text: string) => ({ type: "text" as const, text });
const emptyMessage = (tool: ToolName) => tool === "fd" ? "No files found" : "No matches found";
const countMessage = (tool: ToolName, count: number) => tool === "fd"
  ? `${count} ${count === 1 ? "entry" : "entries"}`
  : `${count} output ${count === 1 ? "line" : "lines"}`;
function details(tool: ToolName, count: number, truncated = false): Details {
  return {
    binarySource: "bundled",
    ...(tool === "fd" ? { matchCount: count } : { outputLines: count }),
    truncated,
    ...(truncated ? { fullOutputPath: "/virtual/spill/output.txt" } : {}),
  };
}
function captured(preview = "", overrides: Partial<CapturedOutput> = {}): CapturedOutput & { fullOutputPath: string | undefined } {
  return {
    preview,
    lineCount: preview.replace(/\n+$/, "").split("\n").filter(Boolean).length,
    totalBytes: Buffer.byteLength(preview),
    truncated: false,
    fullOutputPath: undefined,
    ...overrides,
  };
}
function processResult(code: number, stderr = "", output = captured()) {
  vi.mocked(executeSearchProcess).mockReturnValue(Effect.succeed({ code, stderr, output }));
  return output;
}

let tools: Map<string, RegisteredTool>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveBinary).mockImplementation((spec) => Effect.succeed({
    tool: spec.tool, command: `/virtual/bin/${spec.tool}`, source: "bundled",
  }));
  vi.mocked(discardCapturedOutput).mockReturnValue(Effect.void);
  processResult(0);
  tools = new Map();
  fileSearchTools({
    on: vi.fn(),
    registerTool: (tool: RegisteredTool) => { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI);
});
afterEach(() => vi.unstubAllEnvs());

function registered(tool: ToolName) {
  const definition = tools.get(tool);
  expect(definition, `${tool} must be registered`).toBeDefined();
  return definition!;
}
function render(
  tool: ToolName,
  result: Result,
  { isError = false, expanded = false, isPartial = false } = {},
) {
  const fg = vi.fn((_color: string, text: string) => text);
  const theme = { fg, bold: (text: string) => text } as unknown as Theme;
  const context: Parameters<NonNullable<RegisteredTool["renderResult"]>>[3] = {
    args: { pattern: "needle" }, toolCallId: "search-call", invalidate: vi.fn(),
    lastComponent: undefined, state: {}, cwd: "/virtual/project",
    executionStarted: true, argsComplete: true, showImages: false,
    expanded, isPartial, isError,
  };
  // isError intentionally exists ONLY in argument four, per the SDK contract.
  const component = registered(tool).renderResult!(
    result, { expanded, isPartial }, theme, context,
  );
  return {
    text: component.render(1000).join("\n"),
    fg,
    colored: (color: string) => fg.mock.calls
      .filter(([candidate]) => candidate === color).map(([, text]) => text).join("\n"),
    neutral: () => fg.mock.calls
      .filter(([color]) => ["dim", "muted", "text"].includes(color))
      .map(([, text]) => text).join("\n"),
  };
}
function execute(tool: ToolName, signal?: AbortSignal, params = { pattern: "needle" }) {
  return registered(tool).execute("search-call", params, signal, undefined,
    { cwd: "/virtual/project" } as ExtensionContext);
}

it("registers exactly fd and rg without executing a search", () => {
  expect([...tools.keys()]).toEqual(["fd", "rg"]);
  expect(executeSearchProcess).not.toHaveBeenCalled();
});

describe.each(["fd", "rg"] as const)("%s registered renderResult", (tool) => {
  for (const detailState of ["missing", "zero", "success"] as const) {
    it.each([false, true])(`fourth-argument errors override ${detailState} details (partial=%s)`, (isPartial) => {
      const diagnostic = `${tool}: permission denied: /private/project`;
      const rendered = render(tool, {
        content: [textBlock(diagnostic)],
        details: detailState === "missing" ? undefined : details(tool, detailState === "zero" ? 0 : 7, true),
      }, { isError: true, isPartial });
      expect(rendered.text).toBe(diagnostic);
      expect(rendered.colored("error")).toBe(diagnostic);
      expect(rendered.colored("success")).toBe("");
      expect(rendered.text).not.toContain("Searching");
    });
  }

  it.each([
    { label: "empty content", content: [] },
    { label: "images only", content: [image] },
    { label: "empty text", content: [textBlock(""), image] },
  ])("uses an error fallback for $label", ({ content }) => {
    const rendered = render(tool, { content, details: details(tool, 0) }, { isError: true });
    expect(rendered.text).toBe(`${tool} search failed.`);
    expect(rendered.colored("error")).toBe(`${tool} search failed.`);
  });

  it("joins all no-details success text blocks in neutral color and ignores images", () => {
    const rendered = render(tool, {
      content: [image, textBlock("Search completed on the remote host."), image, textBlock("See remote log.")],
      details: undefined,
    });
    expect(rendered.text).toBe("Search completed on the remote host.\nSee remote log.");
    expect(rendered.neutral()).toBe(rendered.text);
    expect(rendered.colored("error")).toBe("");
    expect(rendered.colored("success")).toBe("");
  });

  it.each([
    { label: "empty content", content: [] },
    { label: "images only", content: [image] },
    { label: "empty text", content: [textBlock(""), image] },
  ])("uses an honest no-details success fallback for $label", ({ content }) => {
    const rendered = render(tool, { content, details: undefined });
    expect(rendered.text).toBe("Search completed without result details.");
    expect(rendered.neutral()).toBe(rendered.text);
  });

  describe.each([false, true])("untyped preview (isError=%s)", (isError) => {
    it.each([false, true])("bounds joined text blocks and appends omitted-line count (expanded=%s)", (expanded) => {
      const lines = Array.from({ length: 25 }, (_, i) => `diagnostic-${String(i + 1).padStart(2, "0")}`);
      const rendered = render(tool, {
        content: [image, textBlock(lines.slice(0, 2).join("\n")), image,
          textBlock(lines.slice(2).join("\n")), image],
        details: undefined,
      }, { isError, expanded });
      const limit = expanded ? 20 : 3;
      expect(rendered.text.split("\n").slice(0, limit)).toEqual(lines.slice(0, limit));
      expect(rendered.text.split("\n")).toHaveLength(limit + 1);
      expect(rendered.text.split("\n").at(-1)).toMatch(new RegExp(`${25 - limit} more lines`));
      for (const line of lines.slice(limit)) expect(rendered.text).not.toContain(line);
      expect(rendered.text).not.toContain(image.data);
      const colored = isError ? rendered.colored("error") : rendered.neutral();
      for (const line of lines.slice(0, limit)) expect(colored).toContain(line);
    });
  });

  it.each([false, true])("preserves the real zero-count empty state (expanded=%s)", (expanded) => {
    const rendered = render(tool, {
      content: [textBlock("not a diagnostic")], details: details(tool, 0),
    }, { expanded });
    expect(rendered.text).toBe(emptyMessage(tool));
    expect(rendered.colored("dim")).toBe(emptyMessage(tool));
  });

  describe.each([1, 2])("typed success count=%s", (count) => {
    it.each([false, true])("preserves count grammar and optional preview (expanded=%s)", (expanded) => {
      const rendered = render(tool, {
        content: [textBlock("src/one.ts\nsrc/two.ts")], details: details(tool, count),
      }, { expanded });
      expect(rendered.colored("success")).toBe(countMessage(tool, count));
      expect(rendered.text).toBe(countMessage(tool, count) + (expanded ? "\nsrc/one.ts\nsrc/two.ts" : ""));
      expect(rendered.colored("error")).toBe("");
    });
  });

  it.each([false, true])("preserves truncation, bounded expanded preview, and spill path (expanded=%s)", (expanded) => {
    const lines = Array.from({ length: 25 }, (_, i) => `result-${i + 1}`);
    const rendered = render(tool, {
      content: [textBlock(lines.join("\n"))], details: details(tool, 4000, true),
    }, { expanded });
    expect(rendered.colored("success")).toBe(countMessage(tool, 4000));
    expect(rendered.colored("warning")).toContain("(truncated)");
    if (expanded) {
      expect(rendered.text.split("\n").slice(1, 21)).toEqual(lines.slice(0, 20));
      expect(rendered.text).toContain("5 more lines");
      expect(rendered.text).toContain("Full output: /virtual/spill/output.txt");
      expect(rendered.text).not.toContain("result-21");
    } else {
      expect(rendered.text).toBe(`${countMessage(tool, 4000)} (truncated)`);
    }
  });

  it.each(["missing", "zero", "success"] as const)("keeps successful partial %s results as Searching", (state) => {
    const rendered = render(tool, {
      content: [textBlock("in-flight output")],
      details: state === "missing" ? undefined : details(tool, state === "zero" ? 0 : 2),
    }, { isPartial: true });
    expect(rendered.text).toBe("Searching...");
    expect(rendered.colored("warning")).toBe("Searching...");
  });
});

describe.each(["fd", "rg"] as const)("%s registered execute", (tool) => {
  it("classifies the native no-match exit as a genuine zero-count result", async () => {
    processResult(tool === "rg" ? 1 : 0);
    expect(await execute(tool)).toEqual({
      content: [textBlock(emptyMessage(tool))], details: details(tool, 0),
    });
    expect(discardCapturedOutput).not.toHaveBeenCalled();
  });

  it("throws real stderr on nonzero exit and discards captured output", async () => {
    const output = processResult(2, "  invalid pattern: unclosed bracket\n", captured("partial", {
      truncated: true, fullOutputPath: "/virtual/spill/output.txt",
    }));
    await expect(execute(tool)).rejects.toThrow(`${tool} failed: invalid pattern: unclosed bracket`);
    expect(discardCapturedOutput).toHaveBeenCalledExactlyOnceWith(output);
  });

  it("includes the exit code when stderr is blank", async () => {
    processResult(7, " \n\t");
    await expect(execute(tool)).rejects.toThrow(`${tool} failed: exit code 7`);
  });

  it("throws cancellation when its execution signal is aborted", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(executeSearchProcess).mockReturnValue(
      Effect.sync(() => started()).pipe(Effect.flatMap(() => Effect.never)),
    );
    const pending = execute(tool, controller.signal);
    const rejection = expect(pending).rejects.toThrow(`${tool} search was cancelled.`);
    try {
      await didStart;
    } finally {
      controller.abort();
    }
    await rejection;
  });

  it("returns successful captured output/details using the resolved binary and context cwd", async () => {
    processResult(0, "", captured("src/one.ts\nsrc/two.ts\n"));
    const result = await execute(tool);
    expect(result).toEqual({
      content: [textBlock("src/one.ts\nsrc/two.ts")], details: details(tool, 2),
    });
    expect(executeSearchProcess).toHaveBeenCalledExactlyOnceWith({
      command: `/virtual/bin/${tool}`, args: expect.any(Array),
      cwd: "/virtual/project", tempPrefix: `pi-${tool}-`,
    });
    expect(discardCapturedOutput).not.toHaveBeenCalled();
  });
});

it.each([undefined, "/virtual/hostile-rg.conf"])(
  "rg execute puts --no-config first regardless of RIPGREP_CONFIG_PATH=%s",
  async (configPath) => {
    vi.stubEnv("RIPGREP_CONFIG_PATH", configPath);
    await execute("rg", undefined, { pattern: "--quiet" });
    const [options] = vi.mocked(executeSearchProcess).mock.calls[0]!;
    expect(options.args[0]).toBe("--no-config");
    expect(options.args.filter((arg) => arg === "--no-config")).toHaveLength(1);
    expect(options.args.slice(-2)).toEqual(["--", "--quiet"]);
  },
);

it("rg exit 1 with output is an error, not the no-match special case", async () => {
  processResult(1, "incomplete search", captured("some output"));
  await expect(execute("rg")).rejects.toThrow("rg failed: incomplete search");
});

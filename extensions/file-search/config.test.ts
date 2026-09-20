import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fileSearch from "./index.ts";

// Use real search processes, but never probe/download fallback binaries. Tests
// lacking system rg are explicitly skipped rather than installing anything.
vi.mock("./src/binaries.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./src/binaries.ts")>();
  const { Effect } = await import("effect");
  return {
    ...original,
    liveBinaryEnv: {
      probe: (command: string) => Effect.succeed(command === "rg"),
      install: () => Effect.die(new Error("Unexpected binary installation")),
    },
  };
});

let hasRg = false;
try {
  execFileSync("rg", ["--no-config", "--version"], { stdio: "ignore", timeout: 5000 });
  hasRg = true;
} catch { /* Report unsupported environments as skipped. */ }

describe.skipIf(!hasRg)("registered rg with real ripgrep and isolated user config", () => {
  let root: string;
  let config: string;
  let tool: ToolDefinition<any, any>;
  let ctx: ExtensionContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-file-search-config-test-"));
    const home = join(root, "home");
    const project = join(root, "project");
    await mkdir(home);
    await mkdir(project);
    await mkdir(join(project, ".git"));
    await writeFile(join(project, ".gitignore"), "ignored.txt\n");
    await writeFile(join(project, "visible.txt"), "needle: original content\n");
    await writeFile(join(project, "ignored.txt"), "needle: ignored content\n");
    config = join(home, "ripgrep-config");
    await writeFile(config, "");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    vi.stubEnv("RIPGREP_CONFIG_PATH", config);
    const tools: ToolDefinition<any, any>[] = [];
    fileSearch({
      on() {},
      registerTool(definition: ToolDefinition<any, any>) { tools.push(definition); },
    } as unknown as ExtensionAPI);
    tool = tools.find((entry) => entry.name === "rg")!;
    ctx = { cwd: project, hasUI: false } as ExtensionContext;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["quiet", "--quiet"],
    ["file listing", "--files"],
    ["replacement", "--replace=REPLACED"],
    ["ignore bypass", "--no-ignore"],
    ["exclusion glob", "--glob=!*.txt"],
    ["invalid option", "--invalid-pi-test-option"],
  ])("ignores %s injected by RIPGREP_CONFIG_PATH", async (_label, setting) => {
    await writeFile(config, `${setting}\n`);
    const result = await tool.execute("search", { pattern: "needle", path: "." }, undefined, undefined, ctx);
    expect(result.content).toEqual([{ type: "text", text: "./visible.txt:1:needle: original content" }]);
    expect(result.details).toEqual({ binarySource: "system", outputLines: 1, truncated: false, fullOutputPath: undefined });
  });

  it("classifies genuine no-match exit 1 as an empty success", async () => {
    const result = await tool.execute("search", { pattern: "absent", path: "." }, undefined, undefined, ctx);
    expect(result.content).toEqual([{ type: "text", text: "No matches found" }]);
    expect(result.details.outputLines).toBe(0);
  });

  it("retains real invalid-regex diagnostics rather than no matches", async () => {
    await expect(tool.execute("search", { pattern: "[", path: "." }, undefined, undefined, ctx)).rejects.toThrow(/regex parse error/);
  });

  it("retains real missing-path diagnostics rather than no matches", async () => {
    await expect(tool.execute("search", { pattern: "needle", path: "missing" }, undefined, undefined, ctx)).rejects.toThrow(/rg failed:.*missing/s);
  });

  it("fixed strings still match literal regex syntax", async () => {
    await writeFile(join(ctx.cwd, "literal.txt"), "[needle]\n");
    const result = await tool.execute("search", { pattern: "[needle]", path: ".", fixed_strings: true }, undefined, undefined, ctx);
    expect(result.content).toEqual([{ type: "text", text: "./literal.txt:1:[needle]" }]);
  });
});

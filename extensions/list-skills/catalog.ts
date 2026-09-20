import fs from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Settings } from "../shared/settings-file.ts";
import { enabledBySettings, isFilter, skillEntries, type SkillTarget } from "./settings.ts";

export interface SkillItem extends SkillTarget {
  name: string;
  description: string;
  enabled: boolean;
  initialEnabled: boolean;
  loaded: boolean;
  managed: boolean;
  reason?: string;
}
interface IgnoreScope { dir: string; matcher: Ignore }
const posix = (path: string) => path.split(sep).join("/");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Filesystem-only discovery with cycle protection; never resolve/install packages. */
function scan(root: string, mode: "pi" | "agents" | "explicit", warnings: string[]): string[] {
  const files: string[] = [];
  const visited = new Set<string>();
  const stack: Array<{ dir: string; scopes: IgnoreScope[] }> = [{ dir: root, scopes: [] }];
  while (stack.length) {
    const { dir, scopes: inherited } = stack.pop()!;
    try {
      const real = fs.realpathSync(dir);
      if (visited.has(real)) continue;
      visited.add(real);
      const matcher = ignore();
      for (const filename of [".gitignore", ".ignore", ".fdignore"]) {
        try { matcher.add(fs.readFileSync(join(dir, filename), "utf8")); }
        catch (error) { if (!missing(error)) warnings.push(`${dir}: ${errorText(error)}`); }
      }
      const scopes = [...inherited, { dir, matcher }];
      const ignored = (path: string, directory = false) => {
        let excluded = false;
        for (const scope of scopes) {
          const result = scope.matcher.test(posix(relative(scope.dir, path)) + (directory ? "/" : ""));
          if (result.ignored) excluded = true;
          else if (result.unignored) excluded = false;
        }
        return excluded;
      };
      const skillFile = join(dir, "SKILL.md");
      try {
        if (fs.statSync(skillFile).isFile() && !ignored(skillFile)) {
          files.push(skillFile);
          continue; // A skill directory's support files are not more skills.
        }
      } catch (error) { if (!missing(error)) warnings.push(`${skillFile}: ${errorText(error)}`); }
      const children: typeof stack = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const path = join(dir, entry.name);
        let stat;
        try { stat = fs.statSync(path); }
        catch (error) { if (!missing(error)) warnings.push(`${path}: ${errorText(error)}`); continue; }
        if (ignored(path, stat.isDirectory())) continue;
        if (stat.isDirectory()) children.push({ dir: path, scopes });
        else if (stat.isFile() && entry.name.endsWith(".md") && (mode === "agents" ? dir !== root : dir === root)) files.push(path);
      }
      stack.push(...children.reverse());
    } catch (error) { if (!missing(error)) warnings.push(`${dir}: ${errorText(error)}`); }
  }
  return files;
}

function parseSkill(path: string): Pick<SkillItem, "name" | "description"> | undefined {
  try {
    // Public YAML parser; Pi 0.85.1's non-empty-string description requirement.
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) return;
    return {
      name: typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : basename(dirname(path)),
      description: frontmatter.description,
    };
  } catch { return; }
}
function canonical(path: string) {
  try { return fs.realpathSync(path); } catch { return path; }
}

export function loadSkillCatalog(options: {
  agentDir: string;
  homeDir: string;
  settings: Settings;
  commands: ReturnType<ExtensionAPI["getCommands"]>;
}) {
  const { agentDir, homeDir, settings, commands } = options;
  const entries = skillEntries(settings);
  const warnings: string[] = [];
  const byRealPath = new Map<string, SkillItem>();
  const add = (path: string, baseDir: string, auto: boolean) => {
    const key = canonical(path);
    if (byRealPath.has(key)) return;
    const parsed = parseSkill(path);
    if (!parsed) return;
    const target = { path, baseDir, auto };
    const enabled = enabledBySettings(target, entries);
    byRealPath.set(key, { ...parsed, ...target, enabled, initialEnabled: enabled, loaded: false, managed: true });
  };
  // Explicit user paths outrank auto discovery, as in Pi. Keep lexical paths for overrides.
  for (const entry of entries.filter(entry => !isFilter(entry))) {
    const expanded = entry === "~" ? homeDir : entry.startsWith("~/") ? join(homeDir, entry.slice(2)) : entry;
    const path = resolve(agentDir, expanded);
    try {
      const stat = fs.statSync(path);
      if (stat.isFile()) add(path, agentDir, false);
      else if (stat.isDirectory()) for (const file of scan(path, "explicit", warnings)) add(file, agentDir, false);
    } catch (error) { if (!missing(error)) warnings.push(`${path}: ${errorText(error)}`); }
  }
  for (const [root, baseDir, mode] of [
    [join(agentDir, "skills"), agentDir, "pi"],
    [join(homeDir, ".agents", "skills"), join(homeDir, ".agents"), "agents"],
  ] as const) {
    for (const path of scan(root, mode, warnings)) add(path, baseDir, true);
  }

  // Loaded provenance is authoritative; never claim global overrides control
  // project/package/CLI/extension resources. Show those read-only instead.
  for (const command of commands.filter(command => command.source === "skill")) {
    const info = command.sourceInfo;
    if (!info || !isAbsolute(info.path)) continue;
    const key = canonical(info.path);
    const known = byRealPath.get(key);
    const managed = info.scope === "user" && info.origin === "top-level" &&
      (info.source === "auto" || info.source === "local");
    const target = { path: info.path, baseDir: info.baseDir ?? agentDir, auto: info.source === "auto" };
    const enabled = managed ? enabledBySettings(target, entries) : true;
    byRealPath.set(key, {
      ...target, name: command.name.replace(/^skill:/, ""), description: command.description ?? known?.description ?? "",
      enabled, initialEnabled: enabled, loaded: true, managed,
      reason: managed ? undefined : "Read-only here: use pi config or the originating project/package/CLI configuration.",
    });
  }
  return {
    skills: [...byRealPath.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    warnings,
  };
}

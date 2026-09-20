import fs from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Settings } from "../shared/settings-file.ts";
import { enabledBySettings, isFilter, packageSettingsPath, readSettingsFile, skillEntries, type SkillControl, type SkillTarget } from "./settings.ts";

export interface SkillItem extends SkillTarget {
  name: string;
  description: string;
  enabled: boolean;
  initialEnabled: boolean;
  loaded: boolean;
  /** False for CLI/extension-provided resources whose on/off state cannot be persisted here. */
  managed: boolean;
  control?: SkillControl;
  reason?: string;
}
interface IgnoreScope { dir: string; matcher: Ignore }
const posix = (path: string) => path.split(sep).join("/");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const READ_ONLY_REASON = "Read-only: provided by the CLI or an extension for this session; toggle it at its source.";

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

function expandHome(path: string, homeDir: string): string {
  return path === "~" ? homeDir : path.startsWith("~/") ? join(homeDir, path.slice(2)) : path;
}

/** Best-effort installed path for a configured package source; undefined when it cannot be found on disk. */
function resolvePackageRoot(source: string, agentDir: string, homeDir: string, cwd: string | undefined): string | undefined {
  const candidates: string[] = [];
  if (source.startsWith("git:")) {
    const withoutScheme = source.slice(4);
    const slash = withoutScheme.indexOf("/");
    if (slash > 0) candidates.push(join(agentDir, "git", withoutScheme.slice(0, slash), withoutScheme.slice(slash + 1)));
  } else if (source.startsWith("npm:")) {
    let name = source.slice(4);
    const slash = name.lastIndexOf("/");
    const at = name.lastIndexOf("@");
    if (at > slash + 1) name = name.slice(0, at); // Strip a version spec like npm:pkg@^1.
    candidates.push(join(agentDir, "npm", "node_modules", name));
  } else if (!isFilter(source)) {
    const expanded = expandHome(source, homeDir);
    candidates.push(resolve(agentDir, expanded));
    if (cwd) candidates.push(resolve(cwd, expanded));
  }
  return candidates.find(candidate => {
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  });
}

/** Package skills live under the manifest's `pi.skills` paths, or a default `skills/` directory. */
function packageSkillFiles(root: string, homeDir: string, warnings: string[]): string[] {
  let manifestSkills: unknown;
  try {
    const manifest = JSON.parse(fs.readFileSync(join(root, "package.json"), "utf8"));
    manifestSkills = typeof manifest === "object" && manifest !== null
      ? (manifest as Record<string, Record<string, unknown>>).pi?.skills : undefined;
  } catch (error) { if (!missing(error)) warnings.push(`${root}: ${errorText(error)}`); }
  if (Array.isArray(manifestSkills) && manifestSkills.every(entry => typeof entry === "string")) {
    const files: string[] = [];
    for (const entry of manifestSkills as string[]) {
      const path = resolve(root, expandHome(entry, homeDir));
      try {
        const stat = fs.statSync(path);
        if (stat.isFile()) files.push(path);
        else if (stat.isDirectory()) files.push(...scan(path, "explicit", warnings));
      } catch (error) { if (!missing(error)) warnings.push(`${path}: ${errorText(error)}`); }
    }
    return files;
  }
  return scan(join(root, "skills"), "pi", warnings);
}

export function loadSkillCatalog(options: {
  agentDir: string;
  homeDir: string;
  cwd?: string;
  settings: Settings;
  projectSettings?: Settings;
  commands: ReturnType<ExtensionAPI["getCommands"]>;
}) {
  const { agentDir, homeDir, cwd, settings, commands } = options;
  const projectSettings = options.projectSettings ?? {};
  const entries = skillEntries(settings);
  let projectEntries: string[] = [];
  try { projectEntries = skillEntries(projectSettings); }
  catch { /* A malformed project file still blocks saving later; listing stays best-effort. */ }
  const warnings: string[] = [];
  const byRealPath = new Map<string, SkillItem>();

  // Project package entries win over global ones, as in Pi's dedupe; filter sources map to files.
  const packageRoots = new Map<string, string>();
  const packageEntryFilter = (source: string): { control?: SkillControl; entries: string[] } => {
    const path = packageSettingsPath(agentDir, cwd, source);
    try {
      const configured = readSettingsFile(path).packages;
      if (Array.isArray(configured)) {
        const entry = configured.find(pkg =>
          pkg === source || (typeof pkg === "object" && pkg !== null && (pkg as Record<string, unknown>).source === source));
        if (entry !== undefined) {
          const filter = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).skills : undefined;
          return { entries: Array.isArray(filter) ? filter.filter((value): value is string => typeof value === "string") : [] };
        }
      }
    } catch { /* Malformed settings file: the save path reports it; listing stays read-only. */ }
    return { entries: [] };
  };

  const add = (path: string, baseDir: string, auto: boolean, control: SkillControl | undefined, filterEntries: string[]) => {
    const key = canonical(path);
    if (byRealPath.has(key)) return;
    const parsed = parseSkill(path);
    if (!parsed) return;
    const target = { path, baseDir, auto };
    const enabled = control ? enabledBySettings(target, filterEntries) : true;
    byRealPath.set(key, {
      ...parsed, ...target, enabled, initialEnabled: enabled, loaded: false,
      managed: control !== undefined, control,
      reason: control ? undefined : READ_ONLY_REASON,
    });
  };
  // Explicit user paths outrank auto discovery, as in Pi. Keep lexical paths for overrides.
  for (const entry of entries.filter(entry => !isFilter(entry))) {
    const path = resolve(agentDir, expandHome(entry, homeDir));
    try {
      const stat = fs.statSync(path);
      if (stat.isFile()) add(path, agentDir, false, { kind: "global" }, entries);
      else if (stat.isDirectory()) for (const file of scan(path, "explicit", warnings)) add(file, agentDir, false, { kind: "global" }, entries);
    } catch (error) { if (!missing(error)) warnings.push(`${path}: ${errorText(error)}`); }
  }
  for (const [root, baseDir, mode] of [
    [join(agentDir, "skills"), agentDir, "pi"],
    [join(homeDir, ".agents", "skills"), join(homeDir, ".agents"), "agents"],
  ] as const) {
    for (const path of scan(root, mode, warnings)) add(path, baseDir, true, { kind: "global" }, entries);
  }
  // Project skills: toggled through the project's own settings.json overrides.
  if (cwd) {
    for (const [root, baseDir, mode] of [
      [join(cwd, ".pi", "skills"), join(cwd, ".pi"), "pi"],
      [join(cwd, ".agents", "skills"), join(cwd, ".agents"), "agents"],
    ] as const) {
      for (const path of scan(root, mode, warnings)) add(path, baseDir, true, { kind: "project" }, projectEntries);
    }
  }
  // Package skills: discovered from installed packages and toggled through the package's filter.
  const configuredSources = new Set<string>();
  for (const settingsSource of [projectSettings, settings]) {
    const packages = settingsSource.packages;
    if (Array.isArray(packages)) {
      for (const pkg of packages) {
        const source = typeof pkg === "string" ? pkg
          : typeof pkg === "object" && pkg !== null ? (pkg as Record<string, unknown>).source : undefined;
        if (typeof source === "string") configuredSources.add(source);
      }
    }
  }
  for (const source of configuredSources) {
    const root = packageRoots.get(source) ?? resolvePackageRoot(source, agentDir, homeDir, cwd);
    if (!root) continue;
    packageRoots.set(source, root);
    const { entries: filterEntries } = packageEntryFilter(source);
    for (const path of packageSkillFiles(root, homeDir, warnings)) add(path, root, false, { kind: "package", source }, filterEntries);
  }

  // Loaded provenance is authoritative; never claim global overrides control
  // resources they cannot reach. CLI/extension-provided rows stay read-only.
  for (const command of commands.filter(command => command.source === "skill")) {
    const info = command.sourceInfo;
    if (!info || !isAbsolute(info.path)) continue;
    const key = canonical(info.path);
    const known = byRealPath.get(key);
    const topLevelLocal = info.origin === "top-level" && (info.source === "auto" || info.source === "local");
    const control: SkillControl | undefined =
      info.origin === "package" && packageRoots.has(info.source) ? { kind: "package", source: info.source }
        : topLevelLocal && info.scope === "user" ? { kind: "global" }
        : topLevelLocal && info.scope === "project" ? { kind: "project" }
        : undefined;
    const filterEntries = control?.kind === "package" ? packageEntryFilter(control.source).entries
      : control?.kind === "project" ? projectEntries
      : control?.kind === "global" ? entries : [];
    const target = { path: info.path, baseDir: info.baseDir ?? agentDir, auto: info.source === "auto" };
    const enabled = control ? enabledBySettings(target, filterEntries) : true;
    byRealPath.set(key, {
      ...target, name: command.name.replace(/^skill:/, ""), description: command.description ?? known?.description ?? "",
      enabled, initialEnabled: enabled, loaded: true, managed: control !== undefined, control,
      reason: control ? undefined : READ_ONLY_REASON,
    });
  }
  return {
    skills: [...byRealPath.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    warnings,
  };
}

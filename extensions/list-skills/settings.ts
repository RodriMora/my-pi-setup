import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { minimatch } from "minimatch";
import { readSettingsFile, updateSettingsFile, type Settings } from "../shared/settings-file.ts";

export { readSettingsFile };

export interface SkillTarget { path: string; baseDir: string; auto: boolean }
/** Where a skill's on/off state persists: global filters, project settings, or the owning package's filter. */
export type SkillControl = { kind: "global" } | { kind: "project" } | { kind: "package"; source: string };
export interface SkillChange extends SkillTarget { enabled: boolean; control?: SkillControl }
const posix = (path: string) => path.split(sep).join("/");

export function skillEntries(settings: Settings): string[] {
  if (settings.skills === undefined) return [];
  if (!Array.isArray(settings.skills) || !settings.skills.every(value => typeof value === "string")) {
    throw new Error("Refusing to update settings: skills must be an array of strings.");
  }
  return [...settings.skills];
}

export function isFilter(entry: string): boolean {
  return /^[!+-]/.test(entry) || entry.includes("*") || entry.includes("?");
}

function targets(skill: SkillTarget, glob: boolean): string[] {
  const paths = [skill.path];
  if (basename(skill.path) === "SKILL.md") paths.push(dirname(skill.path));
  return paths.flatMap(path => {
    const base = [posix(path), posix(relative(skill.baseDir, path))];
    return glob ? [...base, basename(path)] : base;
  });
}

/** Pi's exact overrides are lexical, not realpaths, home expansion, or globs. */
export function matchesExact(skill: SkillTarget, pattern: string): boolean {
  const normalized = posix(pattern.replace(/^\.([/\\])/, ""));
  return targets(skill, false).includes(normalized);
}

export function enabledBySettings(skill: SkillTarget, entries: string[]): boolean {
  const patterns = entries.filter(isFilter);
  const matches = (pattern: string) => targets(skill, true).some(path => minimatch(path, posix(pattern)));
  const includes = patterns.filter(pattern => !/^[!+-]/.test(pattern));
  let enabled = skill.auto || includes.length === 0 || includes.some(matches);
  if (patterns.some(pattern => pattern.startsWith("!") && matches(pattern.slice(1)))) enabled = false;
  if (patterns.some(pattern => pattern.startsWith("+") && matchesExact(skill, pattern.slice(1)))) enabled = true;
  if (patterns.some(pattern => pattern.startsWith("-") && matchesExact(skill, pattern.slice(1)))) enabled = false;
  return enabled;
}

/** Merge updated entries back; an emptied-out filter drops the key entirely. */
function finalizeSkillEntries(current: Settings, entries: string[] | undefined): Settings | undefined {
  if (entries === undefined) return undefined;
  const next = { ...current };
  if (entries.length) next.skills = entries;
  else delete next.skills;
  return next;
}

/** Apply ONLY user-toggled paths to the latest skill entries; returns undefined when nothing changes. */
function applyOverrideChanges(before: string[], changes: readonly SkillChange[]): string[] | undefined {
  let entries = [...before];
  for (const change of changes) {
    if (!isAbsolute(change.path)) throw new Error("Skill override paths must be absolute.");
    if (change.enabled) {
      // A relative -target can apply to multiple roots with different bases.
      // Do not silently re-enable unrelated files while removing that rule.
      const ambiguous = entries.find(entry => entry.startsWith("-") &&
        matchesExact(change, entry.slice(1)) && !isAbsolute(entry.slice(1)));
      if (ambiguous) {
        throw new Error(`Cannot safely override shared exclusion ${JSON.stringify(ambiguous)}. Refine it to absolute paths in settings.json first.`);
      }
      entries = entries.filter(entry => !(entry.startsWith("-") && matchesExact(change, entry.slice(1))));
      if (!enabledBySettings(change, entries)) entries.push(`+${change.path}`);
    } else if (!enabledBySettings(change, entries)) {
      continue;
    } else {
      // A final exact exclusion wins over all includes; preserve discovery,
      // globs, and includes that might also apply to other resources.
      entries.push(`-${change.path}`);
    }
  }
  if (before.length === entries.length && before.every((entry, index) => entry === entries[index])) return undefined;
  return entries;
}

/** Apply toggles to one package's skills filter; returns the entry, or undefined when unchanged. */
function applyPackageChange(entry: unknown, source: string, changes: readonly SkillChange[]): unknown | undefined {
  const wasString = typeof entry === "string";
  const object: Record<string, unknown> = wasString ? { source: entry } : { ...(entry as Record<string, unknown>) };
  if (object.source !== source) throw new Error(`Configured package ${JSON.stringify(source)} was not found.`);
  const existing = object.skills;
  if (existing !== undefined && (!Array.isArray(existing) || !existing.every(value => typeof value === "string"))) {
    throw new Error(`Package ${JSON.stringify(source)} has an invalid skills filter; edit settings.json manually.`);
  }
  let entries: string[] = existing === undefined ? [] : [...existing as string[]];
  for (const change of changes) {
    if (change.enabled) {
      // Package filters are scoped to one package root, so relative exclusions are unambiguous.
      entries = entries.filter(entry => {
        if (!entry.startsWith("-") && !entry.startsWith("+")) return true;
        return !matchesExact(change, entry.slice(1));
      });
      if (!enabledBySettings(change, entries)) entries.push(`+${change.path}`);
    } else if (enabledBySettings(change, entries)) {
      entries.push(`-${change.path}`);
    }
  }
  // A fully emptied filter behaves like no filter; collapse back to the plain string source.
  const next: unknown = entries.length === 0 ? (wasString ? entry : source) : { ...object, skills: entries };
  if (JSON.stringify(next) === JSON.stringify(entry)) return undefined;
  return next;
}

function hasPackageEntry(settings: Settings, source: string): boolean {
  const packages = settings.packages;
  return Array.isArray(packages) && packages.some(pkg =>
    pkg === source || (typeof pkg === "object" && pkg !== null && (pkg as Record<string, unknown>).source === source));
}

/** Project package entries win over global ones for the same source, as in Pi's dedupe. */
export function packageSettingsPath(agentDir: string, cwd: string | undefined, source: string): string {
  if (cwd && hasPackageEntry(readSettingsFile(join(cwd, ".pi", "settings.json")), source)) {
    return join(cwd, ".pi", "settings.json");
  }
  return join(agentDir, "settings.json");
}

export async function saveSkillChanges(
  agentDir: string,
  changes: readonly SkillChange[],
  signal?: AbortSignal,
  cwd?: string,
): Promise<void> {
  const global: SkillChange[] = [];
  const project: SkillChange[] = [];
  const byPackagePath = new Map<string, Map<string, SkillChange[]>>();
  for (const change of changes) {
    const control = change.control ?? { kind: "global" as const };
    if (control.kind === "package") {
      const path = packageSettingsPath(agentDir, cwd, control.source);
      const packages = byPackagePath.get(path) ?? new Map<string, SkillChange[]>();
      const list = packages.get(control.source) ?? [];
      list.push(change);
      packages.set(control.source, list);
      byPackagePath.set(path, packages);
    } else if (control.kind === "project") {
      if (!cwd) throw new Error("Cannot save project skill toggles without a project directory.");
      project.push(change);
    } else {
      global.push(change);
    }
  }
  // Always run the global update: it validates the skills shape even when no changes are staged.
  {
    await updateSettingsFile(join(agentDir, "settings.json"), current => {
      const entries = applyOverrideChanges(skillEntries(current), global);
      return finalizeSkillEntries(current, entries);
    }, signal);
  }
  if (project.length) {
    await updateSettingsFile(join(cwd!, ".pi", "settings.json"), current => {
      const entries = applyOverrideChanges(skillEntries(current), project);
      return finalizeSkillEntries(current, entries);
    }, signal);
  }
  for (const [path, packages] of byPackagePath) {
    await updateSettingsFile(path, current => {
      if (!Array.isArray(current.packages)) throw new Error(`Refusing to update ${path}: packages must be an array.`);
      let nextPackages = [...current.packages];
      let changed = false;
      for (const [source, packageChanges] of packages) {
        const index = nextPackages.findIndex(pkg =>
          pkg === source || (typeof pkg === "object" && pkg !== null && (pkg as Record<string, unknown>).source === source));
        if (index === -1) throw new Error(`Configured package ${JSON.stringify(source)} was not found in ${path}.`);
        const nextEntry = applyPackageChange(nextPackages[index], source, packageChanges);
        if (nextEntry !== undefined) {
          nextPackages[index] = nextEntry;
          changed = true;
        }
      }
      return changed ? { ...current, packages: nextPackages } : undefined;
    }, signal);
  }
}

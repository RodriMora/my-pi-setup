import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { minimatch } from "minimatch";
import { updateSettings, type Settings } from "../shared/settings-file.ts";

export interface SkillTarget { path: string; baseDir: string; auto: boolean }
export interface SkillChange extends SkillTarget { enabled: boolean }
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
  return paths.flatMap(path => [posix(path), posix(relative(skill.baseDir, path)), ...(glob ? [basename(path)] : [])]);
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

/** Apply ONLY user-toggled paths to the latest settings, under the shared lock. */
export function saveSkillChanges(agentDir: string, changes: readonly SkillChange[], signal?: AbortSignal) {
  return updateSettings(agentDir, current => {
    const before = skillEntries(current);
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
    return { ...current, skills: entries };
  }, signal);
}

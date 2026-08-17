import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

type SkillItem = { name: string; description: string; path: string; duplicatePaths?: string[]; enabled: boolean };

const SETTINGS_PATH = join(homedir(), ".pi/agent/settings.json");
const SKILL_ROOTS = [
  join(homedir(), ".pi/agent/skills"),
  join(homedir(), ".agents/skills"),
];

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

function parseSkill(path: string): Omit<SkillItem, "enabled"> | null {
  try {
    const text = readFileSync(path, "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return null;
    const fm = m[1];
    const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
    return name ? { name, description, path } : null;
  } catch { return null; }
}

function walkSkills(dir: string, out: Map<string, Omit<SkillItem, "enabled">>) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      const skillPath = join(p, "SKILL.md");
      if (existsSync(skillPath)) {
        const skill = parseSkill(skillPath);
        if (skill) out.set(skill.path, skill);
      }
      walkSkills(p, out);
    } else if (st.isFile() && p.endsWith(".md") && dir.endsWith("/skills")) {
      const skill = parseSkill(p);
      if (skill) out.set(skill.path, skill);
    }
  }
}

function settingsSkillPaths(settings: any): string[] {
  return Array.isArray(settings.skills) ? settings.skills.filter((x: any) => typeof x === "string") : [];
}

function normalizedPath(value: string): string {
  return value.replace(/^[-+!]/, "").replace(/^~/, homedir());
}

function loadSkills(pi: ExtensionAPI): SkillItem[] {
  const settings = readJson(SETTINGS_PATH);
  const disabled = new Set(settingsSkillPaths(settings).filter((p) => p.startsWith("-") || p.startsWith("!")).map(normalizedPath));
  const byPath = new Map<string, Omit<SkillItem, "enabled">>();

  for (const root of SKILL_ROOTS) walkSkills(root, byPath);
  for (const p of settingsSkillPaths(settings).map(normalizedPath)) {
    if (existsSync(p)) {
      const st = statSync(p);
      if (st.isDirectory()) walkSkills(p, byPath);
      else {
        const skill = parseSkill(p);
        if (skill) byPath.set(skill.path, skill);
      }
    }
  }
  for (const cmd of pi.getCommands().filter((c: any) => c.source === "skill")) {
    const p = cmd.sourceInfo?.path;
    if (typeof p === "string" && !byPath.has(p)) byPath.set(p, { name: cmd.name.replace(/^skill:/, ""), description: cmd.description ?? "", path: p });
  }

  // Match Pi's same-name collision behavior: keep the first discovered skill name.
  const byName = new Map<string, Omit<SkillItem, "enabled">>();
  for (const skill of byPath.values()) {
    const existing = byName.get(skill.name);
    if (!existing) byName.set(skill.name, { ...skill, duplicatePaths: [skill.path] });
    else existing.duplicatePaths = [...(existing.duplicatePaths ?? [existing.path]), skill.path];
  }

  return [...byName.values()]
    .map((s) => ({ ...s, enabled: !(s.duplicatePaths ?? [s.path]).some((p) => disabled.has(p)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function saveDisabled(skills: SkillItem[]) {
  const settings = readJson(SETTINGS_PATH);
  const managed = new Set(skills.flatMap((s) => s.duplicatePaths ?? [s.path]));
  const existing = settingsSkillPaths(settings).filter((p) => !managed.has(normalizedPath(p)));
  settings.skills = [
    ...existing,
    ...skills.filter((s) => !s.enabled).flatMap((s) => (s.duplicatePaths ?? [s.path]).map((p) => `-${p}`)),
  ];
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

class SkillChecklist {
  private selected = 0;
  constructor(private skills: SkillItem[], private done: (save: boolean) => void, private requestRender: () => void, private theme: any) {}
  invalidate() {}
  render(width: number): string[] {
    const lines = [
      this.theme.fg("accent", this.theme.bold("Skills")),
      this.theme.fg("dim", "↑↓ navigate • space/enter toggle • esc save + reload • ctrl+c cancel"),
      "",
    ];
    if (this.skills.length === 0) return [...lines, this.theme.fg("muted", "No skills found")];
    const max = 18;
    const start = Math.max(0, Math.min(this.selected - Math.floor(max / 2), this.skills.length - max));
    for (let i = start; i < Math.min(this.skills.length, start + max); i++) {
      const s = this.skills[i];
      const cursor = i === this.selected ? ">" : " ";
      const box = s.enabled ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
      const desc = s.description ? this.theme.fg("muted", ` — ${s.description}`) : "";
      lines.push(truncateToWidth(`${cursor} ${box} ${s.name}${desc}`, width, "…"));
    }
    lines.push(this.theme.fg("dim", `${this.selected + 1}/${this.skills.length}`));
    return lines;
  }
  handleInput(data: string) {
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(this.skills.length - 1, this.selected + 1);
    else if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) this.skills[this.selected].enabled = !this.skills[this.selected].enabled;
    else if (matchesKey(data, Key.escape)) return this.done(true);
    else if (matchesKey(data, Key.ctrl("c"))) return this.done(false);
    this.requestRender();
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("listskills", {
    description: "List skills and enable/disable them with checkboxes",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const skills = loadSkills(pi);
      const save = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => new SkillChecklist(skills, done, () => tui.requestRender(), theme), { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%" } });
      if (!save) return ctx.ui.notify("Skill changes cancelled", "info");
      saveDisabled(skills);
      ctx.ui.notify("Saved skill selection; reloading Pi resources…", "info");
      await ctx.reload();
      return;
    },
  });
}

import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { SkillItem } from "./catalog.ts";

const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export class SkillChecklist {
  private selected = 0;
  private finished = false;
  private skills: SkillItem[];
  private done: (save: boolean) => void;
  private requestRender: () => void;
  private theme: Theme;
  private rows: () => number;

  constructor(skills: SkillItem[], done: (save: boolean) => void, requestRender: () => void, theme: Theme, rows: () => number) {
    this.skills = skills;
    this.done = done;
    this.requestRender = requestRender;
    this.theme = theme;
    this.rows = rows;
  }
  invalidate() {}
  dispose() { this.finished = true; }
  cancel() { this.finish(false); }
  private finish(save: boolean) {
    if (this.finished) return;
    this.finished = true;
    this.done(save);
  }
  render(width: number): string[] {
    if (width <= 0) return [""];
    const height = Math.max(1, Math.floor(this.rows() * 0.8));
    const { skills, theme } = this;
    const selected = skills[this.selected];
    const row = (skill: SkillItem, index: number) => {
      const box = !skill.managed ? theme.fg("muted", "[-]")
        : skill.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
      return `${index === this.selected ? ">" : " "} ${box} ${clean(skill.name)}` +
        (skill.description ? theme.fg("muted", ` — ${clean(skill.description)}`) : "");
    };
    const help = theme.fg("dim", "↑↓ navigate • space/enter toggle • esc save + reload • ctrl+c cancel");
    let lines: string[];
    if (!selected) {
      lines = [theme.fg("accent", theme.bold("Skills ([x]/[ ] toggle; [-] read-only)")), theme.fg("muted", "No skills found"), help];
    } else if (height < 7) {
      lines = [row(selected, this.selected), theme.fg("dim", clean(selected.path)), help];
    } else {
      lines = [theme.fg("accent", theme.bold("Skills ([x] on; [ ] off; [-] read-only)")), help, ""];
      const count = height - 6;
      const start = Math.max(0, Math.min(this.selected - Math.floor(count / 2), skills.length - count));
      for (let i = start; i < Math.min(skills.length, start + count); i++) lines.push(row(skills[i], i));
      lines.push(theme.fg("dim", clean(selected.path)));
      lines.push(theme.fg("muted", clean(selected.reason ?? (selected.control?.kind === "package"
        ? "Toggled through the owning package's filter in settings.json"
        : selected.control?.kind === "project"
        ? "Toggled through the project's .pi/settings.json"
        : selected.loaded ? "Currently loaded in this session" : "Not currently loaded (may be filtered, shadowed, or discovery disabled)"))));
      lines.push(theme.fg("dim", `${this.selected + 1}/${skills.length}`));
    }
    return lines.slice(0, height).map(line => truncateToWidth(line, width, "…"));
  }
  handleInput(data: string) {
    if (this.finished) return;
    if (matchesKey(data, Key.escape)) return this.finish(true);
    if (matchesKey(data, Key.ctrl("c"))) return this.finish(false);
    if (this.skills.length === 0) return;
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(this.skills.length - 1, this.selected + 1);
    else if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
      const selected = this.skills[this.selected];
      if (selected.managed) selected.enabled = !selected.enabled;
    }
    this.requestRender();
  }
}

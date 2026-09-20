import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SkillChecklist } from "./checklist.ts";
import type { SkillItem } from "./catalog.ts";
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
function item(index: number): SkillItem {
  return { name: `skill-${index}`, description: "Long description 界界 ".repeat(5), path: `/skills/${index}/SKILL.md`,
    baseDir: "/skills", auto: true, enabled: true, initialEnabled: true, loaded: true, managed: true };
}

test("empty navigation/toggle is safe, while save and cancel remain available", () => {
  const results: boolean[] = [];
  const empty = new SkillChecklist([], value => results.push(value), () => {}, theme, () => 40);
  for (const key of ["\x1b[A", "\x1b[B", " ", "\r"]) empty.handleInput(key);
  assert.match(empty.render(80).join("\n"), /No skills found/);
  empty.handleInput("\x1b");
  empty.handleInput("\x03");
  assert.deepEqual(results, [true], "save completes once");
  new SkillChecklist([], value => results.push(value), () => {}, theme, () => 40).handleInput("\x03");
  assert.deepEqual(results, [true, false]);
});

test("all rows, headings, footer and empty state fit narrow widths", () => {
  for (const skills of [[], [item(1)]]) {
    const picker = new SkillChecklist(skills, () => {}, () => {}, theme, () => 40);
    for (const width of [0, 1, 2, 20, 40, 120]) {
      assert.ok(picker.render(width).every(line => visibleWidth(line) <= width));
    }
  }
});

test("height follows terminal resize and keeps the selected item visible", () => {
  let rows = 40;
  const picker = new SkillChecklist(Array.from({ length: 60 }, (_, i) => item(i)), () => {}, () => {}, theme, () => rows);
  for (let i = 0; i < 50; i++) picker.handleInput("\x1b[B");
  for (rows of [40, 20, 8, 3, 1, 40]) {
    const lines = picker.render(120);
    assert.ok(lines.length <= Math.max(1, Math.floor(rows * 0.8)));
    assert.ok(lines.some(line => line.includes("> [x] skill-50")));
  }
});

test("read-only resources cannot be toggled and disposed components ignore input", () => {
  const skill = { ...item(1), managed: false, reason: "Read-only from package" };
  let renders = 0;
  const picker = new SkillChecklist([skill], () => assert.fail("disposed callback"), () => renders++, theme, () => 40);
  picker.handleInput(" ");
  assert.equal(skill.enabled, true);
  assert.match(picker.render(120).join("\n"), /Read-only from package/);
  picker.dispose();
  const previous = renders;
  for (const key of [" ", "\x1b", "\x03"]) picker.handleInput(key);
  assert.equal(renders, previous);
});

test("terminal controls from names, descriptions and paths are not rendered", () => {
  const skill = { ...item(1), name: "evil\x1b[2J\rname", path: "/path/with\nnewline", description: "\x1b]52;c;payload\x07text" };
  const text = new SkillChecklist([skill], () => {}, () => {}, theme, () => 40).render(120).join("\n");
  assert.ok(!text.includes("\x1b"));
  assert.ok(!text.includes("\r"));
  assert.match(text, /with newline/);
});

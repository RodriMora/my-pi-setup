import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSkillCatalog } from "./catalog.ts";

type Commands = ReturnType<ExtensionAPI["getCommands"]>;
function fixture(t: TestContext) {
  const homeDir = fs.mkdtempSync(join(tmpdir(), "pi-skill-catalog-"));
  const agentDir = join(homeDir, "agent");
  fs.mkdirSync(agentDir);
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const skill = (path: string, name: string, description = "description: Valid description") => {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, `---\nname: ${name}\n${description}\n---\nBody\n`);
    return path;
  };
  return { homeDir, agentDir, skill, load: (entries: string[] = [], commands: Commands = []) =>
    loadSkillCatalog({ homeDir, agentDir, settings: { skills: entries }, commands }) };
}
function command(path: string, name: string, scope: "user" | "project" = "user", origin: "top-level" | "package" = "top-level", source = "auto"): Commands[number] {
  return { name: `skill:${name}`, description: "Loaded description", source: "skill", sourceInfo: {
    path, scope, origin, source, baseDir: dirname(dirname(path)),
  } };
}

test("positive external file and directory paths discover skills with real multiline YAML", t => {
  const f = fixture(t);
  const external = f.skill(join(f.homeDir, "external", "SKILL.md"), "external", "description: |\n  First line\n  Second line");
  const grouped = f.skill(join(f.homeDir, "group", "nested", "SKILL.md"), "grouped");
  const { skills } = f.load([external, join(f.homeDir, "group")]);
  assert.equal(skills.length, 2);
  assert.match(skills.find(s => s.path === external)!.description, /First line\nSecond line/);
  assert.ok(skills.every(s => s.enabled && s.managed && !s.auto));
  assert.equal(skills.find(s => s.path === grouped)!.name, "grouped");
});

test("relative discovery resolves against agentDir; ~/ paths resolve against supplied home", t => {
  const f = fixture(t);
  const a = f.skill(join(f.agentDir, "external", "SKILL.md"), "relative");
  const b = f.skill(join(f.homeDir, "outside", "SKILL.md"), "home");
  assert.deepEqual(f.load(["external", "~/outside"]).skills.map(s => s.path).sort(), [a, b].sort());
});

test("Pi0.85.1 discovery modes: .pi root md, .agents nested md, and SKILL stops descent", t => {
  const f = fixture(t);
  f.skill(join(f.agentDir, "skills", "top.md"), "pi-root");
  f.skill(join(f.agentDir, "skills", "group", "ignored.md"), "pi-nested-ignored");
  f.skill(join(f.homeDir, ".agents", "skills", "ignored.md"), "agents-root-ignored");
  f.skill(join(f.homeDir, ".agents", "skills", "group", "nested.md"), "agents-nested");
  f.skill(join(f.agentDir, "skills", "parent", "SKILL.md"), "parent");
  f.skill(join(f.agentDir, "skills", "parent", "support", "SKILL.md"), "support-ignored");
  assert.deepEqual(f.load().skills.map(s => s.name), ["agents-nested", "parent", "pi-root"]);
});

test("ignore files, hidden directories, node_modules and malformed non-skills are skipped", t => {
  const f = fixture(t);
  const root = join(f.agentDir, "skills");
  for (const name of ["good", "ignored", ".hidden", "node_modules"]) f.skill(join(root, name, "SKILL.md"), name);
  fs.writeFileSync(join(root, ".gitignore"), "ignored/\n");
  fs.writeFileSync(join(root, "not-a-skill.md"), "# Documentation\n");
  f.skill(join(root, "bad.md"), "bad", "description: [wrong, type]");
  f.skill(join(root, "broken.md"), "broken", "description: [unterminated");
  assert.deepEqual(f.load().skills.map(s => s.name), ["good"]);
});

test("nested ignore negations apply without reviving an ignored parent directory", t => {
  const f = fixture(t);
  const root = join(f.homeDir, ".agents", "skills");
  f.skill(join(root, "group", "keep.md"), "keep");
  f.skill(join(root, "group", "drop.md"), "drop");
  f.skill(join(root, "ignored", "hidden.md"), "hidden");
  fs.writeFileSync(join(root, ".ignore"), "*.md\nignored/\n");
  fs.writeFileSync(join(root, "group", ".ignore"), "!keep.md\n");
  fs.writeFileSync(join(root, "ignored", ".ignore"), "!hidden.md\n");
  assert.deepEqual(f.load().skills.map(s => s.name), ["keep"]);
});

test("symlink directory cycles terminate and retain lexical paths", { skip: process.platform === "win32", timeout: 2000 }, t => {
  const f = fixture(t);
  const real = f.skill(join(f.homeDir, "actual", "one", "SKILL.md"), "one");
  const alias = join(f.agentDir, "skills");
  fs.symlinkSync(dirname(dirname(real)), alias);
  fs.symlinkSync(dirname(dirname(real)), join(f.homeDir, "actual", "cycle"));
  const { skills } = f.load();
  assert.equal(skills.length, 1);
  assert.equal(skills[0].path, join(alias, "one", "SKILL.md"));
});

test("same-name files remain separate; one disabled copy does not hide the loaded winner", t => {
  const f = fixture(t);
  const a = f.skill(join(f.agentDir, "skills", "a", "SKILL.md"), "duplicate");
  const b = f.skill(join(f.agentDir, "skills", "b", "SKILL.md"), "duplicate");
  const { skills } = f.load([`-${b}`], [command(a, "duplicate")]);
  assert.equal(skills.length, 2);
  assert.equal(skills.find(s => s.path === a)!.loaded, true);
  assert.equal(skills.find(s => s.path === a)!.enabled, true);
  assert.equal(skills.find(s => s.path === b)!.enabled, false);
});

for (const [scope, origin, source] of [
  ["project", "top-level", "auto"], ["user", "package", "npm:example"], ["user", "top-level", "cli"],
] as const) {
  test(`${scope}/${origin}/${source} loaded resources are read-only even if a global path aliases them`, t => {
    const f = fixture(t);
    const file = f.skill(join(f.agentDir, "skills", "one", "SKILL.md"), "one");
    const [item] = f.load([`-${file}`], [command(file, "one", scope, origin, source)]).skills;
    assert.equal(item.managed, false);
    assert.equal(item.loaded, true);
    assert.equal(item.enabled, true);
    assert.match(item.reason!, /Read-only/);
  });
}

test("loaded user provenance selects the actual lexical alias and filter base", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const file = f.skill(join(f.homeDir, "real", "SKILL.md"), "alias");
  const alias = join(f.agentDir, "alias.md");
  fs.symlinkSync(file, alias);
  const cmd = command(alias, "alias", "user", "top-level", "local");
  cmd.sourceInfo!.baseDir = f.agentDir;
  const [item] = f.load([file, alias, "-alias.md"], [cmd]).skills;
  assert.equal(item.path, alias);
  assert.equal(item.initialEnabled, false);
  assert.equal(item.managed, true);
});

test("ordinary settings globs do not narrow auto roots; + alone does not discover files", t => {
  const f = fixture(t);
  f.skill(join(f.agentDir, "skills", "auto", "SKILL.md"), "auto");
  const external = f.skill(join(f.homeDir, "external", "SKILL.md"), "external");
  const { skills } = f.load(["nomatch*", `+${external}`]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].enabled, true);
});

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

function packageFixture(t: TestContext) {
  const f = fixture(t);
  const cwd = join(f.homeDir, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const pkgRoot = join(f.agentDir, "npm", "node_modules", "example");
  fs.mkdirSync(pkgRoot, { recursive: true });
  return {
    ...f, cwd, pkgRoot,
    load: (entries: string[] = [], commands: Commands = [], packages: unknown[] = [], projectSettings: Record<string, unknown> = {}) => {
      // Package filters are resolved from the on-disk settings, exactly as the save path does.
      fs.writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ skills: entries, packages }));
      return loadSkillCatalog({ homeDir: f.homeDir, agentDir: f.agentDir, cwd,
        settings: { skills: entries, packages }, projectSettings, commands });
    },
  };
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

for (const [scope, origin, source, expectManaged] of [
  ["project", "top-level", "auto", true], ["user", "package", "npm:example", false], ["user", "top-level", "cli", false],
] as const) {
  test(`${scope}/${origin}/${source} loaded resources are ${expectManaged ? "toggled through their own scope" : "read-only"} even if a global path aliases them`, t => {
    const f = fixture(t);
    const file = f.skill(join(f.agentDir, "skills", "one", "SKILL.md"), "one");
    const [item] = f.load([`-${file}`], [command(file, "one", scope, origin, source)]).skills;
    if (expectManaged) {
      // Project rows ignore global filters and key off the project's own settings.
      assert.equal(item.managed, true);
      assert.equal(item.enabled, true);
      assert.equal(item.loaded, true);
      assert.equal(item.control?.kind, "project");
    } else {
      assert.equal(item.managed, false);
      assert.equal(item.loaded, true);
      assert.equal(item.enabled, true);
      assert.match(item.reason!, /Read-only/);
    }
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

test("package skills are discovered from installed roots and toggled through the package filter", t => {
  const f = packageFixture(t);
  const on = f.skill(join(f.pkgRoot, "skills", "on", "SKILL.md"), "pkg-on");
  const off = f.skill(join(f.pkgRoot, "skills", "off", "SKILL.md"), "pkg-off");
  const [first, second] = f.load([], [], [{ source: "npm:example", skills: [`-${off}`] }]).skills;
  assert.deepEqual([first.path, second.path], [on, off].sort());
  const onItem = f.load([], [], [{ source: "npm:example", skills: [`-${off}`] }]).skills.find(s => s.path === on)!;
  const offItem = f.load([], [], [{ source: "npm:example", skills: [`-${off}`] }]).skills.find(s => s.path === off)!;
  assert.equal(onItem.enabled, true);
  assert.equal(offItem.enabled, false);
  assert.ok([onItem, offItem].every(s => s.managed && s.control?.kind === "package" && !s.loaded));
});

test("package skills follow manifest pi.skills entries and stay readable while disabled", t => {
  const f = packageFixture(t);
  fs.writeFileSync(join(f.pkgRoot, "package.json"), JSON.stringify({ pi: { skills: ["./custom-skills"] } }));
  const kept = f.skill(join(f.pkgRoot, "custom-skills", "kept", "SKILL.md"), "kept");
  const dropped = f.skill(join(f.pkgRoot, "skills", "ignored", "SKILL.md"), "ignored");
  const { skills } = f.load([], [], ["npm:example"]);
  assert.deepEqual(skills.map(s => s.path), [kept]);
  assert.equal(skills[0].managed, true);
  assert.equal(dropped, join(f.pkgRoot, "skills", "ignored", "SKILL.md"));
});

test("loaded package skills resolve to their package control and honor its filter", t => {
  const f = packageFixture(t);
  const loaded = f.skill(join(f.pkgRoot, "skills", "loaded", "SKILL.md"), "pkg-loaded");
  const [item] = f.load([], [command(loaded, "pkg-loaded", "user", "package", "npm:example")],
    [{ source: "npm:example", skills: [`-${loaded}`] }]).skills;
  assert.equal(item.path, loaded);
  assert.equal(item.loaded, true);
  assert.equal(item.enabled, false);
  assert.equal(item.managed, true);
  assert.equal(item.control?.kind, "package");
});

test("loaded package skills without a configured package entry remain read-only", t => {
  const f = packageFixture(t);
  const loaded = f.skill(join(f.pkgRoot, "skills", "loose", "SKILL.md"), "pkg-loose");
  const [item] = f.load([], [command(loaded, "pkg-loose", "user", "package", "npm:unconfigured")]).skills;
  assert.equal(item.managed, false);
  assert.match(item.reason!, /Read-only/);
});

test("project skills are scanned and toggled through project settings, not global filters", t => {
  const f = packageFixture(t);
  const pi = f.skill(join(f.cwd, ".pi", "skills", "group", "SKILL.md"), "proj-pi");
  const agents = f.skill(join(f.cwd, ".agents", "skills", "nested", "deep.md"), "proj-agents");
  const { skills } = f.load([`-${pi}`], [], [], { skills: [`-${agents}`] });
  const piItem = skills.find(s => s.path === pi)!;
  const agentsItem = skills.find(s => s.path === agents)!;
  assert.equal(piItem.enabled, true, "global filters do not reach project skills");
  assert.equal(agentsItem.enabled, false, "project settings filters apply");
  assert.ok([piItem, agentsItem].every(s => s.managed && s.control?.kind === "project"));
});

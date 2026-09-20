import assert from "node:assert/strict";
import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import lockfile from "proper-lockfile";
import {
	enabledBySettings,
	isFilter,
	matchesExact,
	saveSkillChanges,
	skillEntries,
	type SkillTarget,
} from "./settings.ts";

function fixture(t: TestContext) {
	const dir = fs.mkdtempSync(join(tmpdir(), "list-skills-settings-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "settings.json");
	const target = (name = "example", baseDir = join(dir, "skills"), auto = true): SkillTarget => ({
		path: join(baseDir, name, "SKILL.md"), baseDir, auto,
	});
	return {
		dir, path, target,
		write: (settings: unknown) => fs.writeFileSync(path, JSON.stringify(settings)),
		read: (): Record<string, unknown> => JSON.parse(fs.readFileSync(path, "utf8")),
	};
}

test("skillEntries defaults to empty and returns a copy without interpreting discovery entries", () => {
	assert.deepEqual(skillEntries({}), []);
	const entries = ["~/external", "../shared", "/external/SKILL.md", "!**/private/**", "+example"];
	const result = skillEntries({ skills: entries });
	assert.deepEqual(result, entries);
	result.push("-other");
	assert.equal(entries.length, 5);
});

test("isFilter distinguishes discovery paths from filters and exact overrides", () => {
	for (const entry of ["~/external", "../shared", "/external/SKILL.md", "skills/example"]) {
		assert.equal(isFilter(entry), false, entry);
	}
	for (const entry of ["!private", "+/external/SKILL.md", "-example", "**/SKILL.md", "skill?"]) {
		assert.equal(isFilter(entry), true, entry);
	}
});

test("preserves positive external discovery entries verbatim through no-op, disable, and enable", async (t) => {
	const { dir, path, target, write, read } = fixture(t);
	const skill = target("example", join(dir, "external"), false);
	const discovery = ["~/external/", "../shared", "./external", dirname(skill.path), skill.path];
	const original = {
		skills: [...discovery, "!**/private/**", "-unrelated", "+unrelated"],
		packages: ["npm:some-package", { source: "../package", skills: ["!**/draft/**"] }],
		theme: "keep", custom: { nested: [1, true] },
	};
	write(original);
	const bytes = fs.readFileSync(path, "utf8");
	await saveSkillChanges(dir, []);
	await saveSkillChanges(dir, [{ ...skill, enabled: true }]);
	assert.equal(fs.readFileSync(path, "utf8"), bytes);
	await saveSkillChanges(dir, [{ ...skill, enabled: false }]);
	assert.deepEqual(read(), { ...original, skills: [...original.skills, `-${skill.path}`] });
	await saveSkillChanges(dir, [{ ...skill, enabled: true }]);
	assert.deepEqual(read(), original);
});

test("retains broad exclusions and existing positives, adding +absolute to re-enable", async (t) => {
	const { dir, target, write, read } = fixture(t);
	const skill = target();
	const before = ["../external", "!**", "+unrelated", "-unrelated"];
	write({ skills: before });
	assert.equal(enabledBySettings(skill, before), false);
	await saveSkillChanges(dir, [{ ...skill, enabled: true }]);
	const enabled = [...before, `+${skill.path}`];
	assert.deepEqual(read().skills, enabled);
	assert.equal(enabledBySettings(skill, enabled), true);
	await saveSkillChanges(dir, [{ ...skill, enabled: false }]);
	const disabled = [...enabled, `-${skill.path}`];
	assert.deepEqual(read().skills, disabled);
	assert.equal(enabledBySettings(skill, disabled), false);
	await saveSkillChanges(dir, [{ ...skill, enabled: true }]);
	assert.deepEqual(read().skills, enabled);
});

test("exact minus wins over plus regardless of entry order, after broad exclusions", (t) => {
	const skill = fixture(t).target();
	for (const entries of [
		[`-${skill.path}`, `+${skill.path}`, "!**"],
		["!**", `+${skill.path}`, `-${skill.path}`],
		[`+${dirname(skill.path)}`, `-${skill.path}`],
		[`-${dirname(skill.path)}`, `+${skill.path}`],
	]) assert.equal(enabledBySettings(skill, entries), false, JSON.stringify(entries));
	assert.equal(enabledBySettings(skill, [`+${skill.path}`, "!**"]), true);
});

test("glob includes restrict external resources but not automatic resources", (t) => {
	const skill = fixture(t).target();
	assert.equal(enabledBySettings(skill, ["other/**"]), true);
	assert.equal(enabledBySettings({ ...skill, auto: false }, ["other/**"]), false);
	assert.equal(enabledBySettings({ ...skill, auto: false }, ["**/SKILL.md"]), true);
	assert.equal(enabledBySettings({ ...skill, auto: false }, ["../external"]), true);
});

test("exact SKILL.md overrides match its immediate parent, not recursive ancestors or globs", (t) => {
	const skill = fixture(t).target("group/example");
	for (const pattern of [skill.path, dirname(skill.path), "group/example", "./group/example/SKILL.md"]) {
		assert.equal(matchesExact(skill, pattern), true, pattern);
	}
	for (const pattern of [skill.baseDir, dirname(dirname(skill.path)), "group", "example", "SKILL.md", "**/SKILL.md"]) {
		assert.equal(matchesExact(skill, pattern), false, pattern);
		assert.equal(enabledBySettings(skill, [`-${pattern}`]), true, pattern);
	}
	const otherFile = { ...skill, path: join(dirname(skill.path), "notes.md") };
	assert.equal(matchesExact(otherFile, dirname(otherFile.path)), false);
	assert.equal(matchesExact(otherFile, "group/example/notes.md"), true);
});

test("relative exact overrides use each resource base and never expand ~", (t) => {
	const { dir, target } = fixture(t);
	const first = target("example", join(dir, "root-one"));
	const second = target("example", join(dir, "root-two"));
	for (const skill of [first, second]) {
		assert.equal(matchesExact(skill, "./example/SKILL.md"), true);
		assert.equal(matchesExact(skill, "example"), true);
		assert.equal(matchesExact(skill, relative(dir, skill.path)), false);
	}
	assert.equal(matchesExact(second, first.path), false);
	// Pure matching only: never create or read anything in the real home directory.
	const homeTarget = target("example", join(homedir(), "synthetic-test-skills"));
	for (const pattern of ["~/synthetic-test-skills/example/SKILL.md", "~/synthetic-test-skills/example"]) {
		assert.equal(matchesExact(homeTarget, pattern), false);
		assert.equal(enabledBySettings(homeTarget, [`-${pattern}`]), true);
		assert.equal(enabledBySettings(homeTarget, ["!**", `+${pattern}`]), false);
	}
});

for (const exclusion of ["-example", "-example/SKILL.md", "-./example/SKILL.md"]) {
	test(`refuses enabling through shared relative exclusion ${exclusion} without removing it`, async (t) => {
		const { dir, path, target, write } = fixture(t);
		const first = target("example", join(dir, "root-one"));
		const second = target("example", join(dir, "root-two"));
		const entries = ["../external", exclusion, `+${first.path}`];
		write({ skills: entries, theme: "keep" });
		const bytes = fs.readFileSync(path, "utf8");
		assert.equal(enabledBySettings(first, entries), false);
		assert.equal(enabledBySettings(second, entries), false);
		await assert.rejects(saveSkillChanges(dir, [{ ...first, enabled: true }]), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes(exclusion));
			assert.match(error.message, /absolute paths.*settings\.json/);
			return true;
		});
		assert.equal(fs.readFileSync(path, "utf8"), bytes);
		assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
	});
}

test("removes only matching absolute file and immediate skill-directory exclusions", async (t) => {
	const { dir, target, write, read } = fixture(t);
	const skill = target("group/example");
	const other = target("group/other");
	const kept = ["../external", `+${skill.path}`, `+${dirname(skill.path)}`, "!**", `-${other.path}`, `-${skill.baseDir}`, "-unrelated"];
	write({ skills: [...kept, `-${skill.path}`, `-${dirname(skill.path)}`] });
	await saveSkillChanges(dir, [{ ...skill, enabled: true }]);
	assert.deepEqual(read().skills, kept);
	assert.equal(enabledBySettings(skill, kept), true);
	assert.equal(enabledBySettings(other, kept), false);
});

test("reads the latest settings after locking and applies only the toggled path", async (t) => {
	const { dir, path, target, write, read } = fixture(t);
	const toggled = target("toggled");
	const untouched = target("untouched");
	write({ skills: ["../old"], theme: "old" });
	const release = lockfile.lockSync(path, { realpath: false });
	let released = false;
	let pending: Promise<void> | undefined;
	try {
		// saveSkillChanges reaches its first lock attempt synchronously, then yields.
		pending = saveSkillChanges(dir, [{ ...toggled, enabled: false }]);
		const latest = {
			skills: ["../new", `-${untouched.path}`, `+${toggled.path}`, "!**/draft/**"],
			packages: [{ source: "npm:new", skills: ["keep"] }],
			theme: "concurrent", custom: { concurrent: true },
		};
		write(latest); // A cooperating writer commits while it owns the lock.
		release();
		released = true;
		await pending;
		assert.deepEqual(read(), { ...latest, skills: [...latest.skills, `-${toggled.path}`] });
		assert.equal(enabledBySettings(untouched, skillEntries(read())), false);
	} finally {
		if (!released) release();
		await pending;
	}
});

for (const skills of [null, {}, "example", 42, false, ["valid", null], ["valid", 1], [[]]]) {
	test(`rejects invalid skills shape ${JSON.stringify(skills)} without destruction`, async (t) => {
		const { dir, path, target, write } = fixture(t);
		write({ skills, packages: ["keep"], custom: { keep: true } });
		const bytes = fs.readFileSync(path, "utf8");
		assert.throws(() => skillEntries({ skills }), /skills must be an array of strings/);
		await assert.rejects(saveSkillChanges(dir, [{ ...target(), enabled: false }]), /skills must be an array of strings/);
		await assert.rejects(saveSkillChanges(dir, []), /skills must be an array of strings/);
		assert.equal(fs.readFileSync(path, "utf8"), bytes);
		assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
	});
}

for (const content of ["{broken", "", "null", "[]", "42", "true", '"text"']) {
	test(`rejects malformed/non-object settings ${JSON.stringify(content)} without destruction`, async (t) => {
		const { dir, path, target } = fixture(t);
		fs.writeFileSync(path, content);
		await assert.rejects(saveSkillChanges(dir, [{ ...target(), enabled: false }]));
		assert.equal(fs.readFileSync(path, "utf8"), content);
		assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
	});
}

test("a rejected later change does not partially persist earlier toggles", async (t) => {
	const { dir, path, target, write } = fixture(t);
	write({ skills: ["-example"], theme: "keep" });
	const bytes = fs.readFileSync(path, "utf8");
	await assert.rejects(saveSkillChanges(dir, [
		{ ...target("other"), enabled: false },
		{ ...target(), enabled: true },
	]), /Cannot safely override shared exclusion/);
	assert.equal(fs.readFileSync(path, "utf8"), bytes);
});

test("generated overrides use lexical symlink paths rather than realpaths", { skip: process.platform === "win32" }, async (t) => {
	const { dir, target, write, read } = fixture(t);
	const realDir = join(dir, "real");
	const linkDir = join(dir, "linked");
	fs.mkdirSync(join(realDir, "example"), { recursive: true });
	fs.writeFileSync(join(realDir, "example", "SKILL.md"), "test skill");
	fs.symlinkSync(realDir, linkDir);
	const skill = target("example", linkDir);
	const realPath = fs.realpathSync(skill.path);
	assert.notEqual(realPath, skill.path);
	assert.equal(matchesExact(skill, realPath), false);
	write({ skills: ["!**"] });
	await saveSkillChanges(dir, [{ ...skill, enabled: true }]);
	assert.deepEqual(read().skills, ["!**", `+${skill.path}`]);
	await saveSkillChanges(dir, [{ ...skill, enabled: false }]);
	assert.deepEqual(read().skills, ["!**", `+${skill.path}`, `-${skill.path}`]);
});

test("rejects relative generated override paths without changing settings", async (t) => {
	const { dir, path, target, write } = fixture(t);
	write({ skills: ["../external"] });
	const bytes = fs.readFileSync(path, "utf8");
	await assert.rejects(saveSkillChanges(dir, [{ ...target(), path: "example/SKILL.md", enabled: false }]), /must be absolute/);
	assert.equal(fs.readFileSync(path, "utf8"), bytes);
});

test("unchanged saves skip atomic replacement and preserve original formatting", async (t) => {
	const { dir, path, target } = fixture(t);
	const skill = target();
	const content = '{ "theme": "keep", "skills": ["../external", "!**"] }\n';
	fs.writeFileSync(path, content);
	const before = fs.statSync(path);
	const rename = t.mock.method(fs, "renameSync");
	await saveSkillChanges(dir, []);
	await saveSkillChanges(dir, [{ ...skill, enabled: false }]);
	assert.equal(rename.mock.callCount(), 0);
	assert.equal(fs.readFileSync(path, "utf8"), content);
	assert.equal(fs.statSync(path).ino, before.ino);
	assert.equal(fs.statSync(path).mtimeMs, before.mtimeMs);
});

test("empty changes and already-enabled auto skills do not create missing settings", async (t) => {
	const { dir, path, target } = fixture(t);
	await saveSkillChanges(dir, []);
	await saveSkillChanges(dir, [{ ...target(), enabled: true }]);
	assert.equal(fs.existsSync(path), false);
	await saveSkillChanges(dir, [{ ...target(), enabled: false }]);
	assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), { skills: [`-${target().path}`] });
});

test("aborting a lock wait prevents skill persistence and preserves the other writer's lock", async (t) => {
	const { dir, path, target, write } = fixture(t);
	write({ skills: ["../external"], theme: "keep" });
	const bytes = fs.readFileSync(path, "utf8");
	const release = lockfile.lockSync(path, { realpath: false });
	const abort = new AbortController();
	try {
		const pending = saveSkillChanges(dir, [{ ...target(), enabled: false }], abort.signal);
		abort.abort();
		await assert.rejects(pending, { name: "AbortError" });
		assert.equal(fs.readFileSync(path, "utf8"), bytes);
		assert.equal(lockfile.checkSync(path, { realpath: false }), true);
	} finally { release(); }
	assert.equal(fs.readFileSync(path, "utf8"), bytes);
	assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

test("atomic replacement failure preserves original skill settings and cleans temporary files", async (t) => {
	const { dir, path, target, write } = fixture(t);
	write({ skills: ["../external", "!**/private/**"], packages: ["keep"] });
	const bytes = fs.readFileSync(path, "utf8");
	const failure = Object.assign(new Error("Injected rename failure"), { code: "EIO" });
	const rename = t.mock.method(fs, "renameSync", () => { throw failure; });
	await assert.rejects(saveSkillChanges(dir, [{ ...target(), enabled: false }]), (error) => error === failure);
	assert.equal(rename.mock.callCount(), 1);
	assert.equal(fs.readFileSync(path, "utf8"), bytes);
	assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

function packageFixture(t: TestContext) {
	const base = fixture(t);
	const root = join(base.dir, "package-root");
	fs.mkdirSync(root, { recursive: true });
	return { ...base, root };
}

const packageSkill = (root: string, name: string): SkillTarget => ({
	path: join(root, "skills", name, "SKILL.md"), baseDir: root, auto: false,
});

const PACKAGE = "npm:example";

test("disabling a package skill converts its string entry into an object filter", async (t) => {
	const { dir, root, target, write, read } = packageFixture(t);
	const skill = packageSkill(root, "draft");
	write({ packages: ["first", PACKAGE, "last"] });
	await saveSkillChanges(dir, [{ ...skill, enabled: false, control: { kind: "package", source: PACKAGE } }]);
	assert.deepEqual(read().packages, ["first", { source: PACKAGE, skills: [`-${skill.path}`] }, "last"]);
});

test("re-enabling a package skill removes the exclusion and collapses back to a plain string", async (t) => {
	const { dir, root, write, read } = packageFixture(t);
	const skill = packageSkill(root, "draft");
	write({ packages: [{ source: PACKAGE, skills: [`-${skill.path}`], autoload: true }] });
	await saveSkillChanges(dir, [{ ...skill, enabled: true, control: { kind: "package", source: PACKAGE } }]);
	assert.deepEqual(read().packages, [PACKAGE]);
});

test("package toggles preserve other object fields and only touch matching exact entries", async (t) => {
	const { dir, root, write, read } = packageFixture(t);
	const skill = packageSkill(root, "draft");
	const other = packageSkill(root, "other");
	const entry = { source: PACKAGE, skills: [`-${other.path}`, "skills/draft/**", "!**/private/**"], autoload: false };
	write({ packages: [entry] });
	// skills/draft/** already includes it: disabling adds a final exact exclusion.
	await saveSkillChanges(dir, [{ ...skill, enabled: false, control: { kind: "package", source: PACKAGE } }]);
	assert.deepEqual(read().packages, [{ ...entry, skills: [...entry.skills, `-${skill.path}`] }]);
	// Re-enabling removes the exact exclusion but keeps the glob and the other skill's exclusion.
	await saveSkillChanges(dir, [{ ...skill, enabled: true, control: { kind: "package", source: PACKAGE } }]);
	assert.deepEqual(read().packages, [entry]);
});

test("package toggles force-include over a broad ! glob when enabling", async (t) => {
	const { dir, root, write, read } = packageFixture(t);
	const skill = packageSkill(root, "draft");
	write({ packages: [{ source: PACKAGE, skills: ["!**"] }] });
	await saveSkillChanges(dir, [{ ...skill, enabled: true, control: { kind: "package", source: PACKAGE } }]);
	assert.deepEqual(read().packages, [{ source: PACKAGE, skills: ["!**", `+${skill.path}`] }]);
});

test("project package entries win over global ones, matching Pi's dedupe", async (t) => {
	const { dir, root, write, read } = packageFixture(t);
	const skill = packageSkill(root, "draft");
	const projectSettings = join(dir, "project", ".pi", "settings.json");
	fs.mkdirSync(dirname(projectSettings), { recursive: true });
	write({ packages: [PACKAGE] });
	fs.writeFileSync(projectSettings, JSON.stringify({ packages: [{ source: PACKAGE, skills: [] }] }));
	const cwd = join(dir, "project");
	await saveSkillChanges(dir, [{ ...skill, enabled: false, control: { kind: "package", source: PACKAGE } }], undefined, cwd);
	assert.deepEqual(JSON.parse(fs.readFileSync(projectSettings, "utf8")).packages,
		[{ source: PACKAGE, skills: [`-${skill.path}`] }]);
	assert.deepEqual(read().packages, [PACKAGE]);
});

for (const packages of [undefined, ["other"], [{ source: PACKAGE, skills: ["draft", 1] }]]) {
	test(`rejects unusable package configuration ${JSON.stringify(packages)} without destruction`, async (t) => {
		const { dir, path, root, write } = packageFixture(t);
		const skill = packageSkill(root, "draft");
		write({ packages: packages === undefined ? undefined : packages, keep: true });
		const bytes = fs.readFileSync(path, "utf8");
		await assert.rejects(
			saveSkillChanges(dir, [{ ...skill, enabled: false, control: { kind: "package", source: PACKAGE } }]),
			/Refusing to update|invalid skills filter|was not found/);
		assert.equal(fs.readFileSync(path, "utf8"), bytes);
	});
}

test("unchanged package toggles skip the write entirely", async (t) => {
	const { dir, path, root, write } = packageFixture(t);
	const skill = packageSkill(root, "draft");
	const content = '{"packages":["npm:example"]}\n';
	fs.writeFileSync(path, content);
	const rename = t.mock.method(fs, "renameSync");
	await saveSkillChanges(dir, [{ ...skill, enabled: true, control: { kind: "package", source: PACKAGE } }]);
	assert.equal(rename.mock.callCount(), 0);
	assert.equal(fs.readFileSync(path, "utf8"), content);
});

test("project skill toggles write the project's own settings.json", async (t) => {
	const { dir, target, write } = fixture(t);
	const skill = target("example", join(dir, "project", ".pi", "skills"));
	const projectSettings = join(dir, "project", ".pi", "settings.json");
	fs.mkdirSync(dirname(projectSettings), { recursive: true });
	fs.writeFileSync(projectSettings, JSON.stringify({ theme: "keep" }));
	const cwd = join(dir, "project");
	await saveSkillChanges(dir, [{ ...skill, enabled: false, control: { kind: "project" } }], undefined, cwd);
	assert.deepEqual(JSON.parse(fs.readFileSync(projectSettings, "utf8")),
		{ theme: "keep", skills: [`-${skill.path}`] });
	await saveSkillChanges(dir, [{ ...skill, enabled: true, control: { kind: "project" } }], undefined, cwd);
	assert.deepEqual(JSON.parse(fs.readFileSync(projectSettings, "utf8")), { theme: "keep" });
});

test("project skill toggles without a cwd are rejected", async (t) => {
	const { dir, target } = fixture(t);
	await assert.rejects(
		saveSkillChanges(dir, [{ ...target(), enabled: false, control: { kind: "project" } }]),
		/without a project directory/);
});

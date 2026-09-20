import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import lockfile from "proper-lockfile";
import { updateDefaultSettings } from "./src/settings.ts";

function fixture(t: TestContext) {
	const dir = fs.mkdtempSync(join(tmpdir(), "remember-model-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "settings.json");
	return { dir, path, read: () => JSON.parse(fs.readFileSync(path, "utf8")) };
}

const model = { defaultProvider: "test-provider", defaultModel: "test-model" };

test("initializes missing settings, including a missing agent directory", async (t) => {
	const { dir } = fixture(t);
	const agentDir = join(dir, "new-agent-dir");
	await updateDefaultSettings(agentDir, model);
	const path = join(agentDir, "settings.json");
	assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), model);
	if (process.platform !== "win32") assert.equal(fs.statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(agentDir), ["settings.json"]);
});

test("merges defaults without changing unrelated settings or file permissions", async (t) => {
	const { dir, path, read } = fixture(t);
	const original = { theme: "dark", packages: ["local"], skills: ["-disabled"], custom: { flag: true } };
	fs.writeFileSync(path, JSON.stringify(original), { mode: 0o640 });
	await updateDefaultSettings(dir, model);
	await updateDefaultSettings(dir, { defaultThinkingLevel: "low" });
	assert.deepEqual(read(), { ...original, ...model, defaultThinkingLevel: "low" });
	if (process.platform !== "win32") assert.equal(fs.statSync(path).mode & 0o777, 0o640);
	assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

for (const content of ["{broken", "", " \n", "null", "[]", "42", "true", '"text"']) {
	test(`refuses malformed or non-object settings: ${JSON.stringify(content)}`, async (t) => {
		const { dir, path } = fixture(t);
		fs.writeFileSync(path, content);
		await assert.rejects(updateDefaultSettings(dir, model));
		assert.equal(fs.readFileSync(path, "utf8"), content);
		assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
	});
}

test("read failures are not treated as missing settings", async (t) => {
	const { dir, path } = fixture(t);
	fs.writeFileSync(path, '{"theme":"keep"}');
	const originalRead = fs.readFileSync;
	const mocked = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
		if (args[0] === path) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
		return originalRead(...args);
	});
	await assert.rejects(updateDefaultSettings(dir, model), { code: "EACCES" });
	mocked.mock.restore();
	assert.equal(fs.readFileSync(path, "utf8"), '{"theme":"keep"}');
	assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

test("settings.json being a directory is an error, not initialization", async (t) => {
	const { dir, path } = fixture(t);
	fs.mkdirSync(path);
	await assert.rejects(updateDefaultSettings(dir, model));
	assert.equal(fs.statSync(path).isDirectory(), true);
	assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

test("failed atomic replacement preserves the original and cleans up the temporary file", async (t) => {
	const { dir, path } = fixture(t);
	fs.writeFileSync(path, '{"theme":"keep"}');
	t.mock.method(fs, "renameSync", () => {
		throw Object.assign(new Error("Rename failed"), { code: "EIO" });
	});
	await assert.rejects(updateDefaultSettings(dir, model), { code: "EIO" });
	assert.equal(fs.readFileSync(path, "utf8"), '{"theme":"keep"}');
	assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

test("failed exclusive creation never removes a temporary file owned by another writer", async (t) => {
	const { dir, path } = fixture(t);
	fs.writeFileSync(path, '{"theme":"keep"}');
	const originalOpen = fs.openSync;
	let occupied: fs.PathLike | undefined;
	t.mock.method(fs, "openSync", (file: fs.PathLike) => {
		occupied = file;
		const fd = originalOpen(file, "wx", 0o600);
		fs.writeFileSync(fd, "another writer's file");
		fs.closeSync(fd);
		throw Object.assign(new Error("Already exists"), { code: "EEXIST" });
	});
	await assert.rejects(updateDefaultSettings(dir, model), { code: "EEXIST" });
	assert.ok(occupied);
	assert.equal(fs.readFileSync(occupied, "utf8"), "another writer's file");
	assert.equal(fs.readFileSync(path, "utf8"), '{"theme":"keep"}');
});

test("failed flush preserves the original and cleans up the temporary file", async (t) => {
	const { dir, path } = fixture(t);
	fs.writeFileSync(path, '{"theme":"keep"}');
	t.mock.method(fs, "fsyncSync", () => { throw new Error("Flush failed"); });
	await assert.rejects(updateDefaultSettings(dir, model), /Flush failed/);
	assert.equal(fs.readFileSync(path, "utf8"), '{"theme":"keep"}');
	assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

test("lock-release failure does not mask the original write error", async (t) => {
	const { dir, path } = fixture(t);
	fs.writeFileSync(path, '{"theme":"keep"}');
	const originalLock = lockfile.lockSync;
	t.mock.method(lockfile, "lockSync", (...args: Parameters<typeof lockfile.lockSync>) => {
		const release = originalLock(...args);
		return () => { release(); throw new Error("Release failed"); };
	});
	const writeError = new Error("Original write failure");
	t.mock.method(fs, "renameSync", () => { throw writeError; });
	await assert.rejects(updateDefaultSettings(dir, model), (error) => error === writeError);
	assert.equal(fs.readFileSync(path, "utf8"), '{"theme":"keep"}');
	assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

test("a post-commit release failure does not retry the transaction", async (t) => {
	const { dir, path, read } = fixture(t);
	fs.writeFileSync(path, '{"theme":"keep"}');
	const originalLock = lockfile.lockSync;
	const mocked = t.mock.method(lockfile, "lockSync", (...args: Parameters<typeof lockfile.lockSync>) => {
		const release = originalLock(...args);
		return () => { release(); throw Object.assign(new Error("Release failed"), { code: "ELOCKED" }); };
	});
	await assert.rejects(updateDefaultSettings(dir, model), /Release failed/);
	assert.equal(mocked.mock.callCount(), 1);
	assert.deepEqual(read(), { theme: "keep", ...model });
	assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

test("an unchanged default does not rewrite the file", async (t) => {
	const { dir, path } = fixture(t);
	const content = '{ "defaultThinkingLevel": "high", "theme": "keep" }';
	fs.writeFileSync(path, content);
	const before = fs.statSync(path);
	await updateDefaultSettings(dir, { defaultThinkingLevel: "high" });
	assert.equal(fs.readFileSync(path, "utf8"), content);
	assert.equal(fs.statSync(path).ino, before.ino);
});

test("preserves settings symlinks", { skip: process.platform === "win32" }, async (t) => {
	const { dir, path, read } = fixture(t);
	const target = join(dir, "managed.json");
	fs.writeFileSync(target, '{"theme":"keep"}');
	fs.symlinkSync(target, path);
	await updateDefaultSettings(dir, model);
	assert.equal(fs.lstatSync(path).isSymbolicLink(), true);
	assert.deepEqual(read(), { theme: "keep", ...model });
	assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), read());
});

test("refuses to replace a dangling settings symlink", { skip: process.platform === "win32" }, async (t) => {
	const { dir, path } = fixture(t);
	const target = join(dir, "missing.json");
	fs.symlinkSync(target, path);
	await assert.rejects(updateDefaultSettings(dir, model), { code: "ENOENT" });
	assert.equal(fs.lstatSync(path).isSymbolicLink(), true);
	assert.equal(fs.existsSync(target), false);
	assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

test("reads current settings after acquiring the lock, including initially absent files", async (t) => {
	const { dir, path, read } = fixture(t);
	const release = lockfile.lockSync(path, { realpath: false });
	let released = false;
	try {
		const pending = updateDefaultSettings(dir, model);
		await delay(40);
		assert.equal(fs.existsSync(path), false);
		fs.writeFileSync(path, '{"theme":"concurrent","defaultThinkingLevel":"low"}');
		release();
		released = true;
		await pending;
		assert.deepEqual(read(), { theme: "concurrent", defaultThinkingLevel: "low", ...model });
	} finally {
		if (!released) release();
	}
});

test("lock timeout does not change the file or steal the other writer's lock", async (t) => {
	const { dir, path } = fixture(t);
	fs.writeFileSync(path, '{"theme":"keep"}');
	const release = lockfile.lockSync(path, { realpath: false });
	try {
		await assert.rejects(updateDefaultSettings(dir, model), { code: "ELOCKED" });
		assert.equal(fs.readFileSync(path, "utf8"), '{"theme":"keep"}');
		assert.equal(lockfile.checkSync(path, { realpath: false }), true);
	} finally { release(); }
});

test("abort cancels a lock wait without modifying settings", async (t) => {
	const { dir, path } = fixture(t);
	fs.writeFileSync(path, '{"theme":"keep"}');
	const release = lockfile.lockSync(path, { realpath: false });
	const abort = new AbortController();
	try {
		const pending = updateDefaultSettings(dir, model, abort.signal);
		abort.abort();
		await assert.rejects(pending, { name: "AbortError" });
		assert.equal(fs.readFileSync(path, "utf8"), '{"theme":"keep"}');
	} finally { release(); }
});

test("a pre-aborted update does not even create the agent directory", async (t) => {
	const { dir } = fixture(t);
	const agentDir = join(dir, "absent");
	await assert.rejects(updateDefaultSettings(agentDir, model, AbortSignal.abort()));
	assert.equal(fs.existsSync(agentDir), false);
});

for (const existing of [false, true]) {
	test(`separate processes preserve both patches (${existing ? "existing" : "new"} settings)`, { timeout: 10_000 }, async (t) => {
		const { dir, path, read } = fixture(t);
		if (existing) fs.writeFileSync(path, '{"theme":"keep"}');
		const worker = join(dir, "worker.mjs");
		const helper = new URL("./src/settings.ts", import.meta.url).href;
		const piModule = import.meta.resolve("@earendil-works/pi-coding-agent");
		fs.writeFileSync(worker, `
import { updateDefaultSettings } from ${JSON.stringify(helper)};
const isPiWriter = process.argv[3] === "pi";
const SettingsManager = isPiWriter ? (await import(${JSON.stringify(piModule)})).SettingsManager : undefined;
process.once("message", async () => {
  try {
    if (isPiWriter) {
      const settings = SettingsManager.create(process.cwd(), process.argv[2], { projectTrusted: false });
      settings.setTheme("concurrent");
      await settings.flush();
      if (settings.drainErrors().length) throw new Error("Pi settings write failed");
    } else {
      await updateDefaultSettings(process.argv[2], JSON.parse(process.argv[3]));
    }
    process.disconnect();
  } catch (error) { console.error(error); process.exit(1); }
});
process.send("ready");
`);
		const updates = [JSON.stringify(model), JSON.stringify({ defaultThinkingLevel: "low" }), ...(existing ? ["pi"] : [])];
		const children = updates.map((patch) =>
			fork(worker, [dir, patch], {
				execArgv: ["--experimental-strip-types"],
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			}),
		);
		const exits = children.map((child) => once(child, "exit"));
		try {
			await Promise.all(children.map((child) => once(child, "message", { signal: t.signal })));
			for (const child of children) child.send("go");
			for (const [code, signal] of await Promise.all(exits)) {
				assert.equal(code, 0, `Worker failed (${signal})`);
			}
			assert.deepEqual(read(), { ...(existing ? { theme: "concurrent" } : {}), ...model, defaultThinkingLevel: "low" });
			assert.deepEqual(fs.readdirSync(dir).sort(), ["settings.json", "worker.mjs"]);
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
			await Promise.all(exits);
		}
	});
}

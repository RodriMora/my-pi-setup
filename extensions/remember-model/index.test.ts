import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import rememberModel from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

function fixture(t: TestContext) {
	const dir = fs.mkdtempSync(join(tmpdir(), "remember-model-events-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const handlers = new Map<string, Handler>();
	const notices: unknown[][] = [];
	const statuses: unknown[][] = [];
	let closed = false;
	const ctx = {
		get ui() {
			assert.equal(closed, false, "Stale UI accessed after shutdown");
			return {
				notify: (...args: unknown[]) => notices.push(args),
				setStatus: (...args: unknown[]) => statuses.push(args),
			};
		},
	} as unknown as ExtensionContext;
	rememberModel({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	} as unknown as ExtensionAPI);
	return {
		dir,
		path: join(dir, "settings.json"),
		notices,
		statuses,
		emit: (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx),
		closeUI: () => { closed = true; },
	};
}

const selected = { source: "set", model: { provider: "test-provider", id: "test-model" } };

test("persists selection to PI_CODING_AGENT_DIR and reports success only afterward", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(f.path, '{"theme":"keep"}');
	await f.emit("model_select", selected);
	assert.deepEqual(JSON.parse(fs.readFileSync(f.path, "utf8")), {
		theme: "keep", defaultProvider: "test-provider", defaultModel: "test-model",
	});
	assert.deepEqual(f.statuses, [["remember-model", "test-provider/test-model"]]);
	assert.deepEqual(f.notices, []);
});

test("restored models do not create or rewrite settings", async (t) => {
	const f = fixture(t);
	await f.emit("model_select", { ...selected, source: "restore" });
	assert.equal(fs.existsSync(f.path), false);
	assert.deepEqual(f.statuses, []);
	assert.deepEqual(f.notices, []);
});

test("model cycling and thinking-level changes preserve unrelated settings", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(f.path, '{"skills":["keep"]}');
	await f.emit("model_select", { ...selected, source: "cycle" });
	await f.emit("thinking_level_select", { level: "high" });
	assert.deepEqual(JSON.parse(fs.readFileSync(f.path, "utf8")), {
		skills: ["keep"], defaultProvider: "test-provider", defaultModel: "test-model", defaultThinkingLevel: "high",
	});
	assert.deepEqual(f.notices, []);
});

test("model and thinking persistence failures warn without claiming success or destroying settings", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(f.path, "{broken");
	await f.emit("model_select", selected);
	await f.emit("thinking_level_select", { level: "low" });
	assert.equal(fs.readFileSync(f.path, "utf8"), "{broken");
	assert.deepEqual(f.statuses, []);
	assert.equal(f.notices.length, 2);
	assert.match(String(f.notices[0]![0]), /failed to persist default model/);
	assert.match(String(f.notices[1]![0]), /failed to persist thinking level/);
	assert.equal(f.notices[0]![1], "warning");
	assert.equal(f.notices[1]![1], "warning");
});

test("a corrected settings file can be saved on the next event", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(f.path, "{broken");
	await f.emit("model_select", selected);
	fs.writeFileSync(f.path, '{"theme":"repaired"}');
	await f.emit("model_select", selected);
	assert.deepEqual(JSON.parse(fs.readFileSync(f.path, "utf8")), {
		theme: "repaired", defaultProvider: "test-provider", defaultModel: "test-model",
	});
	assert.equal(f.notices.length, 1);
	assert.equal(f.statuses.length, 1);
});

test("later selections cannot overtake a save waiting for another process", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(f.path, '{"theme":"keep"}');
	const release = lockfile.lockSync(f.path, { realpath: false });
	let released = false;
	try {
		const first = f.emit("model_select", selected);
		await delay(10);
		release();
		released = true;
		const second = f.emit("model_select", { ...selected, model: { provider: "new", id: "latest" } });
		await Promise.all([first, second]);
		assert.deepEqual(JSON.parse(fs.readFileSync(f.path, "utf8")), {
			theme: "keep", defaultProvider: "new", defaultModel: "latest",
		});
		assert.deepEqual(f.statuses.at(-1), ["remember-model", "new/latest"]);
	} finally { if (!released) release(); }
});

test("shutdown cancels pending saves without touching stale UI or settings", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(f.path, '{"theme":"keep"}');
	const release = lockfile.lockSync(f.path, { realpath: false });
	try {
		const pendingModel = f.emit("model_select", selected);
		const pendingThinking = f.emit("thinking_level_select", { level: "low" });
		await f.emit("session_shutdown");
		f.closeUI();
		await Promise.all([pendingModel, pendingThinking]);
		assert.equal(fs.readFileSync(f.path, "utf8"), '{"theme":"keep"}');
		assert.deepEqual(f.notices, []);
		assert.deepEqual(f.statuses, []);
	} finally { release(); }
});

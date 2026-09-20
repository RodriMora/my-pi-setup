import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("separate skill pickers and remember-model merge through the shared settings lock", { timeout: 10_000 }, async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), "pi-shared-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = join(dir, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ skills: ["../external"], theme: "keep", packages: ["keep"] }));
  const worker = join(dir, "worker.mjs");
  fs.writeFileSync(worker, `
import { updateDefaultSettings } from ${JSON.stringify(new URL("../remember-model/src/settings.ts", import.meta.url).href)};
import { saveSkillChanges } from ${JSON.stringify(new URL("./settings.ts", import.meta.url).href)};
import { join } from "node:path";
process.once("message", async () => {
  try {
    const [dir, kind] = process.argv.slice(2);
    if (kind === "model") await updateDefaultSettings(dir, { defaultModel: "test-model", defaultProvider: "test-provider" });
    else await saveSkillChanges(dir, [{ path: join(dir, kind, "SKILL.md"), baseDir: dir, auto: true, enabled: false }]);
    process.disconnect();
  } catch (error) { console.error(error); process.exit(1); }
});
process.send("ready");
`);
  const children = ["model", "one", "two"].map(kind => fork(worker, [dir, kind], {
    execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  }));
  const errors: string[] = [];
  children.forEach(child => child.stderr?.on("data", chunk => errors.push(String(chunk))));
  const exits = children.map(child => once(child, "exit"));
  try {
    await Promise.all(children.map(child => once(child, "message", { signal: t.signal })));
    children.forEach(child => child.send("go"));
    for (const [code] of await Promise.all(exits)) assert.equal(code, 0, errors.join(""));
    const saved = JSON.parse(fs.readFileSync(settings, "utf8"));
    assert.deepEqual(saved, {
      theme: "keep", packages: ["keep"], defaultProvider: "test-provider", defaultModel: "test-model",
      skills: saved.skills,
    });
    assert.deepEqual([...saved.skills].sort(), ["../external", `-${join(dir, "one", "SKILL.md")}`, `-${join(dir, "two", "SKILL.md")}`].sort());
  } finally {
    children.forEach(child => { if (child.exitCode === null) child.kill("SIGKILL"); });
    await Promise.all(exits);
  }
});

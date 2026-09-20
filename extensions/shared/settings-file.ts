import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";

export type Settings = Record<string, unknown>;
const LOCK_ATTEMPTS = 41;
const LOCK_RETRY_MS = 25;

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function readCurrent(settingsPath: string) {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(settingsPath);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  // Preserve dotfile-manager symlinks; dangling links are not missing settings.
  const target = stat?.isSymbolicLink() ? fs.realpathSync(settingsPath) : settingsPath;
  let mode = 0o600;
  let current: Settings = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Refusing to update ${settingsPath}: settings must be a JSON object.`);
    }
    current = parsed as Settings;
    mode = fs.statSync(target).mode & 0o777;
  } catch (error) {
    if (!hasCode(error, "ENOENT") || stat !== undefined) throw error;
  }
  return { current, target, mode };
}

/** Read a preview without creating files. Saving must re-read under the lock. */
export function readSettingsFile(settingsPath: string): Settings {
  return readCurrent(settingsPath).current;
}

export function readSettings(agentDir: string): Settings {
  return readSettingsFile(resolve(agentDir, "settings.json"));
}

/** Synchronous read/transform/write while holding Pi's settings.json.lock. */
function writeUpdate(settingsPath: string, update: (current: Settings) => Settings | undefined) {
  const { current, target, mode } = readCurrent(settingsPath);
  const next = update(current);
  if (next === undefined) return;

  const temporary = join(dirname(target), `.settings.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let temporaryCreated = false;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    temporaryCreated = true;
    fs.writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
    temporaryCreated = false;
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch { /* Never replace the original error with cleanup failure. */ }
    if (temporaryCreated) {
      try { fs.unlinkSync(temporary); } catch { /* Preserve the original error. */ }
    }
  }
}

/** Cooperating writers merge against current settings, not a stale UI snapshot.
 * `update` is synchronous and returns undefined when nothing needs changing. */
export async function updateSettings(
  agentDir: string,
  update: (current: Settings) => Settings | undefined,
  signal?: AbortSignal,
): Promise<void> {
  return updateSettingsFile(resolve(agentDir, "settings.json"), update, signal);
}

/** Synchronous read/transform/write of one settings file while holding its Pi-style lock. */
export async function updateSettingsFile(
  settingsPath: string,
  update: (current: Settings) => Settings | undefined,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  fs.mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    let release: () => void;
    try {
      release = lockfile.lockSync(settingsPath, { realpath: false });
    } catch (error) {
      if (!hasCode(error, "ELOCKED") || attempt === LOCK_ATTEMPTS - 1) throw error;
      // Only yield BEFORE acquisition: Pi's synchronous writer must not block
      // the event loop waiting for a lock whose release needs that same loop.
      await delay(LOCK_RETRY_MS, undefined, { signal });
      continue;
    }
    let writeFailed = false;
    try {
      writeUpdate(settingsPath, update);
      return;
    } catch (error) {
      writeFailed = true;
      throw error;
    } finally {
      try { release(); } catch (error) { if (!writeFailed) throw error; }
    }
  }
}

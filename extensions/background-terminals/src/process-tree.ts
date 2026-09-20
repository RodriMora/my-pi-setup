import { spawn, type ChildProcess } from "node:child_process";

function isMissingProcess(error: unknown) {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ESRCH";
}

/** The POSIX group belongs to this spawn, independently of its shell/stdio.
 * Once it disappears, never probe or signal that numeric PGID again: a later
 * process may reuse it. Windows taskkill remains a best-effort tree cleanup. */
export function createProcessTree(child: ChildProcess, hasExited: () => boolean) {
  let gone = child.pid === undefined;

  const isAlive = () => {
    if (gone) return false;
    if (process.platform === "win32") {
      gone = hasExited();
      return !gone;
    }
    try {
      process.kill(-child.pid!, 0);
      return true;
    } catch (error) {
      if (isMissingProcess(error)) gone = true;
      // Permission/unknown failures are not evidence that the group is gone.
      return !gone;
    }
  };

  const signal = (value: NodeJS.Signals) => {
    if (gone || !child.pid) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, value);
        return;
      } catch (error) {
        if (isMissingProcess(error)) {
          gone = true;
          return;
        }
      }
    } else {
      try {
        const killer = spawn("taskkill", [
          "/pid", String(child.pid), "/T", ...(value === "SIGKILL" ? ["/F"] : []),
        ], { stdio: "ignore", windowsHide: true });
        const fallback = () => {
          if (hasExited()) return;
          try { child.kill(value); } catch { /* Already gone. */ }
        };
        killer.once("error", fallback);
        killer.once("exit", (code) => { if (code !== 0) fallback(); });
        killer.unref();
        return;
      } catch {
        // Fall through if taskkill could not be launched.
      }
    }
    if (!hasExited()) {
      try { child.kill(value); } catch { /* Already gone. */ }
    }
  };

  return { isAlive, signal };
}

export type ProcessTree = ReturnType<typeof createProcessTree>;

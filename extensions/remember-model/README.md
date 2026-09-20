# remember-model

Persists model selections/cycling and thinking-level changes as defaults for new
sessions. Restoring a session's model does not rewrite the default model.

Settings are resolved through Pi's `getAgentDir()`, including
`PI_CODING_AGENT_DIR`; the extension never writes project-local settings.

## Safe persistence

The transaction implementation lives in `../shared/settings-file.ts`, shared with
`list-skills`; this extension's wrapper still patches only model/thinking defaults.

- Only a genuinely missing settings file is initialized. Invalid JSON, empty
  files, non-object JSON values, and read errors are reported without overwriting
  the existing file. A subsequent event can retry after the file is repaired.
- A `proper-lockfile` lock uses the same `settings.json.lock` convention as Pi.
  Each transaction reads the latest file **after** acquiring the lock and merges
  only the changed defaults. Lock contention is retried for about one second,
  without blocking the event loop between attempts.
- A unique, exclusively created temporary file in the destination directory is
  flushed and atomically renamed. Existing file permissions and valid settings
  symlinks are preserved; new settings files are private (`0600` on POSIX).
  Dangling symlinks are rejected.
- Updates from one extension instance are queued in selection order. Shutdown
  cancels queued saves/lock waits and prevents callbacks from touching stale UI.

These guarantees cover this extension's writes and cooperating writers using the
same settings path/lock. They do not repair writes made by other extensions or
Pi itself. Direct edits, alternate symlink aliases, and lock-lease expiry during
prolonged filesystem stalls are outside that guarantee. Atomic replacement is
not a promise of power-loss durability of the directory entry.

## Tests

From the package root:

```sh
npm --prefix extensions/remember-model test
npm --prefix extensions/remember-model run check
```

Tests use temporary agent directories, including separate-process updates and
coordination with the installed development version of Pi's settings writer.
They do not edit the user's real settings.

# background-terminals

Session-scoped shell processes with ignored stdin, bounded stdout/stderr capture,
a `/ps` viewer, and completion notifications. Tools: `bg_start`, `bg_status`,
`bg_list`, and `bg_kill`.

## Cleanup and settlement

On POSIX, each shell starts in its own process group. Cleanup probes that group
independently of the shell's exit and stdout/stderr closure. Redirecting a child's
output does not let it escape cleanup. SIGTERM gets a two-second grace, followed
by SIGKILL and a bounded final wait. Once a group is observed gone, its numeric
PGID is retired rather than used again during pruning or session disposal.

Every terminal closes one entry scope, whether it exits naturally, is killed,
or the session shuts down. That scope terminates the remaining group, drains
stdio within a deadline, closes owned capture pipes/listeners, and flushes spill
files before publishing the final snapshot. Final snapshots no longer accumulate
late output. Normal exits do not wait out the full drainage grace unnecessarily.

The original shell's observed natural exit status is retained even when its
surviving descendants require cleanup. Warnings explain incomplete cleanup or
output drainage. Shutdown also rejects late calls instead of creating a fresh
runtime in an old extension instance.

**Limits:** commands that create a different process group/session can escape
POSIX group termination. Their inherited capture pipes are still closed, so they
cannot keep this extension's I/O handles alive. Keep commands in the foreground
rather than daemonizing them. Windows uses best-effort `taskkill /T`; the new
process-cleanup regressions are exercised on POSIX, not Windows. This is not an
OS sandbox, cgroup, or Windows job object.

## Result delivery

An in-flight `bg_kill` reserves delivery for its IDs but does **not** discard their
settlements. Only a successfully collected/formatted report acknowledges them.
If the wait is cancelled, termination continues and undelivered results become
eligible for notification. Reference-counted reservations handle overlapping
collectors; a successful kill or settled `bg_status` consumes pending delivery.
The manager's collection flag is advisory, not an acknowledgement.

Kill reports include final stdout/stderr tails, spill warnings, and log pointers,
not just exit metadata. The combined report is bounded to 50KB/2000 lines, with
all terminal status lines before output. `bg_status` and `/ps` expose additional
retained output. A missing full-log spill is not presented as recoverable output
once the in-memory head has been discarded.

The running-process widget respects terminal width and reads current theme
styles on every render.

## Tests

From the package root:

```sh
npm --prefix extensions/background-terminals run check
npm --prefix extensions/background-terminals test
```

Tests include real redirected/escaped children, process-group retirement,
settlement/pipe cleanup, cancelled and overlapping tool collectors, output bounds,
shutdown races, and widget resizing/theme changes. Test processes use temporary
files and explicit cleanup; no model calls are required.

`docs/implementation-guide.md` is the historical implementation research. This
README and current source/tests supersede its old close-means-dead and
interest-means-consumed assumptions.

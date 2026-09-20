# list-skills

`/listskills` opens a terminal-only checklist. Arrows navigate, Space/Enter toggle,
Escape saves and reloads, and Ctrl+C cancels. Empty lists safely accept save/cancel.
All lines fit the available width; visible rows adapt to terminal height.

## What the checkboxes mean

- **[x] / [ ]:** this file is allowed/excluded by **global local-skill filters**.
- **[-]:** a loaded project, package, CLI, extension-provided, or otherwise
  non-global resource. It is read-only here; use `pi config` or its source's config.
- The selected row shows its absolute path and whether it is **currently loaded**.
  Allowed does not necessarily mean loaded: a same-name skill can shadow it, or
  discovery can be disabled. Files with duplicate names remain separate rows.

This distinction matters: Pi's global `settings.skills` overrides are not universal
session-wide switches. Writing a global exclusion for a package/project skill can
silently do nothing. The picker does not promise otherwise.

## Safe settings updates

The picker resolves the settings directory with `getAgentDir()`, including
`PI_CODING_AGENT_DIR`. Only user-toggled, writable rows produce changes. Saving
without changes preserves existing file bytes; positive external discovery entries
are never removed. Unrelated settings, filters, and other writers' changes survive.

Persistence shares the reviewed writer in `../shared/settings-file.ts` with
`remember-model`: strict JSON-object validation, read-after-lock merging using
Pi's lock convention, exclusive temporary files, flushed atomic replacement,
permission/symlink preservation, and cancellation while waiting for the lock.
Malformed/unreadable settings or an invalid `skills` array fail without fallback
writes. These protections coordinate cooperating writers using the same lock path;
they cannot protect against unrelated direct writes or alternate symlink aliases.

Top-level filters follow Pi's precedence: positive glob filters, `!` exclusions,
`+` exact includes, then `-` exact exclusions. Generated overrides use absolute
**lexical** paths, not canonicalized symlink targets. Re-enabling under a broad `!`
adds `+absolute-path` rather than deleting the broad rule. Plain discovery paths
and existing includes remain intact when disabling.

**Conservative limitation:** a matching relative `-path` can affect several roots.
The picker refuses to remove that shared rule to enable one row; refine it to
absolute exclusions in `settings.json` first. It reports the reason and saves
nothing, rather than accidentally enabling another file.

## Discovery and lifecycle

Discovery is filesystem-only: configured global file/directory paths, the current
agent directory's `skills/`, `~/.agents/skills`, plus loaded commands' provenance.
It does not install packages, execute skills, or enumerate disabled package/project
resources. Directory realpaths prevent symlink cycles; hidden/dependency folders
and ignore files are respected. Public YAML frontmatter parsing supports multiline
descriptions. Discovery modes follow installed Pi 0.85.1 (including nested Markdown
skills in `.agents/skills`); development dependencies remain Pi 0.84.1.

Only one picker opens per extension instance. Shutdown closes the UI, waits for its
cleanup, cancels pending lock waits, and prevents stale notifications/reloads.
Failures are reported without a success message or reload.

## Tests

From the repository root:

```sh
npm run check
node --test --experimental-strip-types extensions/list-skills/*.test.ts extensions/remember-model/*.test.ts
```

Tests use temporary settings/skills and cover preservation, filtering, concurrent
updates, failure safety, provenance, duplicates, cycle/ignore handling, rendering,
and command lifecycle. Real user settings are not modified.

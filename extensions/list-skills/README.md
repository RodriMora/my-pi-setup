# list-skills

`/listskills` opens a terminal-only checklist. Arrows navigate, Space/Enter toggle,
Escape saves and reloads, and Ctrl+C cancels. Empty lists safely accept save/cancel.
All lines fit the available width; visible rows adapt to terminal height.

## What the checkboxes mean

Every row is toggleable unless marked `[-]`; the save target depends on where the
skill comes from:

- **[x] / [ ] user skills:** allowed/excluded via **global local-skill filters**
  (`~/.pi/agent/settings.json` `skills` entries).
- **[x] / [ ] project skills** (`.pi/skills`, `.agents/skills` under the cwd):
  toggled through the **project's** `.pi/settings.json` `skills` overrides, never
  the global ones.
- **[x] / [ ] package skills:** toggled through the owning package's filter entry
  in `settings.packages` (plain string sources are converted to
  `{ source, skills: [...] }`; a fully emptied filter collapses back to a string).
- **[-]:** CLI-provided or extension-registered resources whose on/off state
  cannot be persisted to any settings file. Read-only here.

The selected row shows its absolute path and where its toggle is saved. Allowed
does not necessarily mean loaded: a same-name skill can shadow it, or discovery
can be disabled. Files with duplicate names remain separate rows.

## Safe settings updates

The picker resolves the settings directory with `getAgentDir()`, including
`PI_CODING_AGENT_DIR`. Only user-toggled rows produce changes. Saving without
changes preserves existing file bytes. Unrelated settings, filters, and other
writers' changes survive.

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
nothing, rather than accidentally enabling another file. Package filters are
scoped to one package root, so their relative exclusions are unambiguous and this
guard only applies to global and project filters.

## Discovery and lifecycle

Discovery is filesystem-only: configured global file/directory paths, the current
agent directory's `skills/`, `~/.agents/skills`, the project's `.pi/skills` and
`.agents/skills`, configured packages' installed roots (manifest `pi.skills`
entries or a default `skills/` directory), plus loaded commands' provenance.
It does not install packages, execute skills, or enumerate resources of packages
whose installed root cannot be found on disk — those appear read-only if loaded.
Directory realpaths prevent symlink cycles; hidden/dependency folders and ignore
files are respected. Public YAML frontmatter parsing supports multiline
descriptions. Discovery modes follow installed Pi 0.86.x (including nested
Markdown skills in `.agents/skills`).

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

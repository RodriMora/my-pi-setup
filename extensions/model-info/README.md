# model-info

Publishes model, thinking level, context usage, recorded spending, streaming
throughput and a short topic title to `dashboard:model-info`. The separate
`ui-customization` extension displays this state.

## Title generation and lifetime

Automatic titles run **only in TUI mode**, never print/JSON/RPC or headless
subagents. They use the active model/provider and configured credentials and
can incur provider charges. Startup alone never requests a title.

- The first meaningful assistant text/thinking/tool-call delta starts the
  request. A single tracked 1-second turn-start timer and `agent_settled` are
  fallback triggers. The timer is only a scheduling heuristic: it cannot prove
  that the main request already reached a concurrency-limited server.
- Compatible OpenAI-style APIs receive low reasoning only when the model's
  advertised capabilities support it; model-name prefixes are not consulted.
  Other APIs retain their own defaults.
- At most three empty/failed-response attempts, with 2s and 4s backoffs, share
  one **30-second deadline**, including provider time and delays. Each request
  retains the existing 2048-token output budget.
- Shutdown, topic changes, and turn cancellation abort active work. Timers and
  abort listeners are cleaned up. An uncooperative provider cannot leave the
  spinner running, publish an obsolete title, persist late results, or produce
  an unhandled late rejection. Aborting locally cannot guarantee that a remote
  server stops work or billing.
- Disposed instances permanently ignore late events; reload starts a fresh
  instance. Detached publication/setup failures are observed and non-fatal.

Successful titles are stored using Pi custom session entries (`model-info:title`)
with versioned metadata and a hash of the first textual user request's first
8000 characters. Empty/image-only user entries are skipped. The source prompt
is not duplicated in this metadata. Matching titles are restored on reload,
resume and branch navigation, avoiding repeated paid title requests. Assistant
context does not affect the cache key: titles identify the original user topic.
Unsuccessful attempts do not cache a title; a later runtime can retry them.
These entries are extension state, not messages sent to the model.

## Accounting

`cost` is **whole-session recorded spending**, not just the active branch:

- Assistant and nested tool-result usage.
- Compaction and branch-summary usage.
- This extension's returned title-request usage, including empty/error responses
  that consumed tokens. Each completed attempt has its own custom session entry.

Compacted/abandoned history remains included. Embedded retained-tail copies are
not counted again. Legacy entries without usage and invalid/negative/nonfinite
cost values contribute zero. This is reported usage, not a billing invoice.

The native Pi session total does not include our custom title entries; the
extra recorded title cost explains that difference. Persistence failures retain
returned title costs in memory for the current runtime, without double-counting
entries that committed before throwing. Costs cannot survive reload if they
could not be saved, or be recorded from discarded late responses after abort.

Tool-result, compaction and tree events refresh the dashboard promptly. TPS
continues to exclude the first chunk and post-stream latency, estimate streamed
text/thinking when tool arguments are involved, and weight messages by their
streaming durations.

## Tests

```sh
npm --prefix extensions/model-info run check
npm --prefix extensions/model-info test
```

Tests use fake completions, session entries and timers; filesystem logging is
mocked. No real model calls or user-settings changes. Installed Pi 0.85.1 is also
smoke-tested in an isolated PTY with a synthetic session, fake completion and
two actual reloads to verify cancellation, complete accounting and cache reuse.

The existing best-effort error log remains `/tmp/pi-summary.log`. No settings
are modified by this extension.

# ask-user

One multiple-choice question per call: 2–5 supplied options, plus an always-present
free-form answer. Number keys select directly; arrows/Enter select; Escape dismisses.
In the free-form editor, Escape returns to the options and an empty submission
returns without answering. Print, JSON, and RPC modes retain the plain-text fallback.

## Prompt ownership and cancellation

Concurrent calls are presented FIFO, one at a time, within this extension instance.
A queued cancellation returns `Cancelled` immediately and never opens a prompt.
Active cancellation calls the component's `done()` callback and waits for the
**actual `ctx.ui.custom()` promise** to settle before opening the next prompt.
Merely abandoning an interrupted waiter is not sufficient: the previous UI must
finish restoring the editor before the next question owns it.

The queue uses native promises rather than an interruptible Effect wrapper so that
UI cleanup acknowledgement, not caller interruption, controls release. Exceptions
release the queue as well. Per-call abort listeners are removed on completion,
cancellation, and failure.

Session shutdown closes the queue permanently, cancels pending and active questions,
and waits for active UI cleanup. Old calls cannot open prompts after shutdown; a
replacement session gets a new extension instance. This queue coordinates this
extension's calls only—not unrelated extensions that also replace the editor.

## Rendering and answer identity

- Rendering is rebuilt for the current width, focus, and theme; embedded editor
  invalidation is forwarded.
- Questions, labels, and descriptions wrap using terminal display widths, including
  Unicode and long tokens. At widths below four columns the editor uses a compact
  placeholder rather than invalid geometry; width zero renders an empty line.
- The wrapper implements focus forwarding while editing, preserving the cursor
  marker required for hardware-cursor/IME positioning. Actual IME composition is
  outside the automated test coverage.
- Results retain a **one-based `details.index`** for a supplied option. Duplicate
  labels therefore display the correct number. Older records infer a number only
  when the answer label is unique; ambiguous old records show the label alone.

## Tests

From the repository root:

```sh
npm --prefix extensions/ask-user run check
npm --prefix extensions/ask-user test
```

Queue tests cover FIFO, cancellation, delayed UI cleanup, failures, listener
release, and shutdown. Registered-tool/component tests cover presentation and
answer behavior without model calls or changes to real user settings.

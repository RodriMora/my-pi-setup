import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createQuestionQueue } from "./src/question-queue.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("FIFO ownership lasts until the actual UI promise settles", { timeout: 2000 }, async () => {
  const queue = createQuestionQueue();
  const first = deferred<number>();
  const order: number[] = [];
  const a = queue.run(() => { order.push(1); return first.promise; });
  const b = queue.run(async () => { order.push(2); return 2; });
  const c = queue.run(async () => { order.push(3); return 3; });
  await tick();
  assert.deepEqual(order, [1]);
  first.resolve(1);
  assert.deepEqual(await Promise.all([a, b, c]), [1, 2, 3]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("queued cancellation resolves promptly, removes listeners, and skips presentation", { timeout: 2000 }, async () => {
  const queue = createQuestionQueue();
  const gate = deferred<number>();
  const a = queue.run(() => gate.promise);
  const controller = new AbortController();
  const b = queue.run(async () => assert.fail("cancelled question was shown"), controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  assert.equal(await b, undefined);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const c = queue.run(async () => 3);
  gate.resolve(1);
  assert.deepEqual(await Promise.all([a, c]), [1, 3]);
});

test("active cancellation does not release ownership before host cleanup acknowledgement", { timeout: 2000 }, async () => {
  const queue = createQuestionQueue();
  const gate = deferred<number>();
  const controller = new AbortController();
  let uiSignal: AbortSignal | undefined;
  let nextOpened = false;
  const a = queue.run((signal) => { uiSignal = signal; return gate.promise; }, controller.signal);
  const b = queue.run(async () => { nextOpened = true; return 2; });
  controller.abort();
  await tick();
  assert.equal(uiSignal?.aborted, true);
  assert.equal(nextOpened, false);
  gate.resolve(1);
  assert.equal(await a, undefined, "an answer racing cancellation is not reported as a choice");
  assert.equal(await b, 2);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("cancellation between release and queued presentation never opens the cancelled question", { timeout: 2000 }, async () => {
  const queue = createQuestionQueue();
  const gate = deferred<void>();
  const controller = new AbortController();
  const a = queue.run(() => gate.promise);
  const b = queue.run(async () => assert.fail("late-cancelled question was shown"), controller.signal);
  gate.resolve();
  controller.abort();
  await a;
  assert.equal(await b, undefined);
});

test("both synchronous and asynchronous failures release the next question", { timeout: 2000 }, async () => {
  const queue = createQuestionQueue();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const a = assert.rejects(queue.run(() => { throw new Error("sync failure"); }, firstController.signal), /sync failure/);
  const b = assert.rejects(queue.run(async () => { throw new Error("async failure"); }, secondController.signal), /async failure/);
  const c = queue.run(async () => "ok");
  await Promise.all([a, b]);
  assert.equal(await c, "ok");
  assert.equal(getEventListeners(firstController.signal, "abort").length, 0);
  assert.equal(getEventListeners(secondController.signal, "abort").length, 0);
});

test("close cancels waiting questions immediately but awaits active cleanup; repeated close is safe", { timeout: 2000 }, async () => {
  const queue = createQuestionQueue();
  const gate = deferred<number>();
  let activeSignal: AbortSignal | undefined;
  const a = queue.run((signal) => { activeSignal = signal; return gate.promise; });
  const b = queue.run(async () => assert.fail("queued question was shown after shutdown"));
  let closed = false;
  const closing = queue.close().then(() => { closed = true; });
  const closingAgain = queue.close();
  assert.equal(await b, undefined);
  await tick();
  assert.equal(activeSignal?.aborted, true);
  assert.equal(closed, false);
  assert.equal(await queue.run(async () => assert.fail("late question was shown")), undefined);
  gate.resolve(1);
  assert.equal(await a, undefined);
  await Promise.all([closing, closingAgain]);
  assert.equal(closed, true);
  await queue.close();
});

test("pre-aborted work never subscribes or opens a UI", async () => {
  const queue = createQuestionQueue();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await queue.run(async () => assert.fail("pre-aborted work ran"), controller.signal), undefined);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("completed requests detach their signal and cannot cancel later work", { timeout: 2000 }, async () => {
  const queue = createQuestionQueue();
  const controller = new AbortController();
  assert.equal(await queue.run(async () => 1, controller.signal), 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const gate = deferred<number>();
  let nextSignal: AbortSignal | undefined;
  const next = queue.run(signal => { nextSignal = signal; return gate.promise; });
  controller.abort();
  assert.equal(nextSignal?.aborted, false);
  gate.resolve(2);
  assert.equal(await next, 2);
});

test("shutdown reentered during presentation still awaits and cancels the active request", async () => {
  const queue = createQuestionQueue();
  let closing: Promise<void> | undefined;
  const result = await queue.run(async signal => {
    closing = queue.close();
    assert.equal(signal.aborted, true);
    return "must not report an answer";
  });
  assert.equal(result, undefined);
  await closing;
  assert.equal(await queue.run(async () => assert.fail("closed queue reopened")), undefined);
});

test("an empty queue closes permanently and independent instances do not block each other", async () => {
  const a = createQuestionQueue();
  const b = createQuestionQueue();
  await a.close();
  assert.equal(await a.run(async () => assert.fail("closed queue ran work")), undefined);
  assert.equal(await b.run(async () => "independent"), "independent");
  await b.close();
});

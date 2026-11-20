// The page's poll, driven by a hand-wound clock. Nothing here is a reading of any campaign.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { startPoll, type PollHost } from "../src/app/poll.ts";

// A host whose time moves only when the test says so.
function fakeHost() {
  let now = 0;
  let shown = true;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Set<() => void>();
  const host: PollHost = {
    visible: () => shown,
    onVisibility: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
  };
  return {
    host,
    timers,
    listeners,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    show(v: boolean) {
      shown = v;
      for (const fn of [...listeners]) fn();
    },
  };
}

// A read the test finishes by hand.
function reads() {
  const open: (() => void)[] = [];
  let count = 0;
  return {
    read: () => {
      count += 1;
      return new Promise<void>((resolve) => open.push(resolve));
    },
    get count() {
      return count;
    },
    get under() {
      return open.length;
    },
    async finish() {
      open.shift()!();
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe("the page's poll", function () {
  it("poll.rhythm: reads at once, then five seconds after each read ends, never two at a time", async function () {
    const h = fakeHost();
    const r = reads();
    const poll = startPoll({ every: 5000, read: r.read, host: h.host });
    assert.equal(r.count, 1);
    h.advance(19_000); // the first read is slow (still within the give-up window): no second read starts on top of it
    assert.equal(r.count, 1);
    await r.finish();
    h.advance(4999);
    assert.equal(r.count, 1);
    h.advance(1);
    assert.equal(r.count, 2);
    assert.equal(r.under, 1);
    await r.finish();
    h.advance(5000);
    assert.equal(r.count, 3);
    poll.stop();
  });

  it("poll.hidden: nothing is read while the tab is hidden, and one read happens when it is shown again", async function () {
    const h = fakeHost();
    const r = reads();
    const poll = startPoll({ every: 5000, read: r.read, host: h.host });
    await r.finish();
    h.show(false);
    assert.equal(h.timers.size, 0);
    h.advance(600_000);
    assert.equal(r.count, 1);
    h.show(true);
    assert.equal(r.count, 2);
    // Hidden while a read is under way: that read ends, and no next one is set.
    h.show(false);
    await r.finish();
    assert.equal(h.timers.size, 0);
    h.advance(600_000);
    assert.equal(r.count, 2);
    h.show(true);
    assert.equal(r.count, 3);
    poll.stop();
  });

  it("poll.now: a read asked for during a read runs once, straight after it", async function () {
    const h = fakeHost();
    const r = reads();
    const poll = startPoll({ every: 5000, read: r.read, host: h.host });
    poll.now();
    poll.now();
    assert.equal(r.count, 1);
    await r.finish();
    assert.equal(r.count, 2); // once, not twice, and without waiting five seconds
    await r.finish();
    assert.equal(r.count, 2);
    // Asked for between reads: it runs at once and the five seconds start over.
    h.advance(3000);
    poll.now();
    assert.equal(r.count, 3);
    await r.finish();
    h.advance(4999);
    assert.equal(r.count, 3);
    h.advance(1);
    assert.equal(r.count, 4);
    poll.stop();
  });

  it("poll.fails: a read that throws does not end the poll", async function () {
    const h = fakeHost();
    let count = 0;
    const poll = startPoll({
      every: 5000,
      read: async () => {
        count += 1;
        if (count === 1) throw new Error("the node did not answer");
      },
      host: h.host,
    });
    await new Promise((r) => setImmediate(r));
    h.advance(5000);
    assert.equal(count, 2);
    poll.stop();
  });

  it("poll.throws: a read that throws synchronously is handled like a rejection, never thrown out of startPoll", async function () {
    const h = fakeHost();
    let count = 0;
    const poll = startPoll({
      every: 5000,
      read: () => {
        count += 1;
        if (count === 1) throw new Error("the node did not answer"); // synchronous throw, not a rejected promise
        return Promise.resolve();
      },
      host: h.host,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(count, 1);
    h.advance(5000);
    await new Promise((r) => setImmediate(r));
    assert.equal(count, 2);
    poll.stop();
  });

  it("poll.timeout: a read that never settles is given up after timeoutMs, its late result ignored, and the next read scheduled", async function () {
    const h = fakeHost();
    const r = reads();
    const poll = startPoll({ every: 5000, read: r.read, host: h.host, timeoutMs: 10_000 });
    assert.equal(r.count, 1);
    assert.equal(r.under, 1);
    h.advance(9_999);
    assert.equal(r.count, 1); // not given up yet
    h.advance(1); // the give-up timer fires: the read is abandoned and the next is scheduled
    h.advance(5_000);
    assert.equal(r.count, 2);
    // The first read's late result changes nothing.
    await r.finish();
    assert.equal(r.count, 2);
    poll.stop();
  });

  it("poll.live: a read is told whether its result is still wanted; one that was given up, or outlived the poll, is not", async function () {
    const h = fakeHost();
    const lives: (() => boolean)[] = [];
    const open: (() => void)[] = [];
    const poll = startPoll({
      every: 5000,
      host: h.host,
      timeoutMs: 10_000,
      read: (live) => {
        lives.push(live);
        return new Promise<void>((r) => open.push(r));
      },
    });
    assert.equal(lives[0](), true); // under way and wanted
    h.advance(10_000); // given up
    assert.equal(lives[0](), false);
    h.advance(5_000); // the next read starts
    assert.equal(lives.length, 2);
    assert.equal(lives[1](), true);
    assert.equal(lives[0](), false, "the first read landing late must not be shown over the second");
    poll.stop();
    assert.equal(lives[1](), false);
    for (const r of open) r();
  });

  it("poll.timeoutDefault: with no timeout given it is four times the interval, at least 15 seconds", async function () {
    const h = fakeHost();
    const r = reads();
    const poll = startPoll({ every: 1000, read: r.read, host: h.host }); // 4 * 1000 = 4000, floored to 15000
    h.advance(14_999);
    assert.equal(r.count, 1);
    h.advance(1); // given up at 15000
    h.advance(1_000);
    assert.equal(r.count, 2);
    poll.stop();
  });

  it("poll.stop: after stop nothing more is read, whatever happens", async function () {
    const h = fakeHost();
    const r = reads();
    const poll = startPoll({ every: 5000, read: r.read, host: h.host });
    poll.stop();
    await r.finish();
    h.advance(60_000);
    h.show(false);
    h.show(true);
    poll.now();
    assert.equal(r.count, 1);
    assert.equal(h.timers.size, 0);
    assert.equal(h.listeners.size, 0);
  });
});

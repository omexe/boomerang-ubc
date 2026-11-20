// The page's heartbeat: read everything again every few seconds, but never two reads at once,
// and not at all while the tab is hidden. Timers and the visibility signal are passed in, so the
// rules below are tested without a browser.

export type Poll = {
  /** Read again now (after a send, say), unless a read is already under way. */
  now(): void;
  stop(): void;
};

export type PollHost = {
  /** Is the page on screen? */
  visible(): boolean;
  /** Call `fn` whenever the page is shown or hidden; returns a function that stops the calls. */
  onVisibility(fn: () => void): () => void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
};

/**
 * Run `read` at once, then again `every` milliseconds after each read ends. A read that throws,
 * whether it rejects or throws synchronously, is the caller's to show; the poll goes on either
 * way and never throws out of here. A read that has not settled after `timeoutMs` is given up: its
 * late result is ignored and the next read is scheduled. While the page is hidden nothing is read;
 * when it is shown again, one read happens at once.
 *
 * `read` is handed `live`, which answers whether its result is still wanted. A read must ask it
 * before showing what it found: one that was given up, or that outlived the poll, would otherwise
 * put an older block on the screen over a newer one.
 */
export function startPoll(o: { every: number; read: (live: () => boolean) => Promise<void>; host: PollHost; timeoutMs?: number }): Poll {
  const { every, read, host } = o;
  const timeoutMs = o.timeoutMs ?? Math.max(4 * every, 15_000);
  let stopped = false;
  let running = false;
  let again = false; // someone asked for a read while one was under way
  let timer: unknown = null;
  let readTimer: unknown = null; // the give-up timer for the read under way

  const clear = (): void => {
    if (timer !== null) host.clearTimer(timer);
    timer = null;
  };
  const clearRead = (): void => {
    if (readTimer !== null) host.clearTimer(readTimer);
    readTimer = null;
  };
  const schedule = (): void => {
    clear();
    if (!stopped && host.visible()) timer = host.setTimer(run, every);
  };
  function run(): void {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    clear();
    if (!host.visible()) return; // shown again later: onVisibility starts it
    running = true;
    let settled = false;
    const finish = (): void => {
      if (settled) return; // already given up, or already finished: ignore a late result
      settled = true;
      clearRead();
      running = false;
      if (stopped) return;
      if (again) {
        again = false;
        run();
      } else schedule();
    };
    readTimer = host.setTimer(finish, timeoutMs); // a read that never settles is given up here
    // Call read now (so a read is counted at once), but turn a synchronous throw into a rejection so nothing is thrown out of startPoll.
    let pending: Promise<void>;
    try {
      pending = read(() => !settled && !stopped);
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(finish, finish);
  }

  const off = host.onVisibility(() => {
    if (stopped) return;
    if (host.visible()) run();
    else clear();
  });
  run();

  return {
    now: run,
    stop: () => {
      stopped = true;
      clear();
      clearRead();
      off();
    },
  };
}

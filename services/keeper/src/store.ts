// The keeper's small disk, and an in-memory twin for tests.
//
// Events are an append-only log, one JSON line each, so a restart rebuilds the ledger by
// replaying them. Notes are little named JSON files for state that is not an event (which
// addresses the demo desk has already funded). bigint has no place in JSON, so `encode` writes
// each one as {"$n":"<decimal>"} and `decode` turns it back; the ledger is all bigints.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BoomerangEvent } from "../../../packages/kit/src/index.ts";

export type Store = {
  load(): BoomerangEvent[]; // every stored event, in file order; a broken last line is dropped
  append(events: readonly BoomerangEvent[]): void; // one JSON line per event, flushed before returning
  readNote<T>(name: string): T | undefined; // <dir>/<name>.json
  writeNote(name: string, value: unknown): void; // write to a temp file in the same dir, then rename
};

const NOTE_NAME = /^[a-z0-9-]+$/;

function checkName(name: string): void {
  if (!NOTE_NAME.test(name)) throw new Error(`bad note name: ${name}`);
}

/** JSON with every bigint written as {"$n":"<decimal>"}. */
export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? { $n: v.toString() } : v));
}

/** The reverse of `encode`: {"$n":"<decimal>"} objects become bigints again. */
export function decode(text: string): unknown {
  return JSON.parse(text, (_key, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof o.$n === "string" && Object.keys(o).length === 1) return BigInt(o.$n);
    }
    return v;
  });
}

export function openStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  const events = join(dir, "events.jsonl");

  // A write cut off by a crash leaves a last line with no newline. Close that line now, so the
  // next event starts on a line of its own; the broken line is dropped by `load`, and the node
  // reader (follow.ts) delivers its event again because the cut-off delivery was never answered.
  try {
    const text = readFileSync(events, "utf8");
    if (text.length > 0 && !text.endsWith("\n")) appendFileSync(events, "\n");
  } catch {
    // no file yet
  }

  function load(): BoomerangEvent[] {
    let text: string;
    try {
      text = readFileSync(events, "utf8");
    } catch {
      return [];
    }
    const out: BoomerangEvent[] = [];
    for (const line of text.split("\n")) {
      if (line === "") continue;
      try {
        out.push(decode(line) as BoomerangEvent);
      } catch {
        // a line that does not parse (a write cut off mid-JSON) is dropped
      }
    }
    return out;
  }

  function append(list: readonly BoomerangEvent[]): void {
    if (list.length === 0) return;
    appendFileSync(events, list.map((e) => encode(e) + "\n").join(""));
  }

  function readNote<T>(name: string): T | undefined {
    checkName(name);
    let text: string;
    try {
      text = readFileSync(join(dir, name + ".json"), "utf8");
    } catch {
      return undefined;
    }
    return decode(text) as T;
  }

  function writeNote(name: string, value: unknown): void {
    checkName(name);
    const tmp = join(dir, `${name}.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmp, encode(value));
    renameSync(tmp, join(dir, name + ".json"));
  }

  return { load, append, readNote, writeNote };
}

/** The same behaviour as `openStore`, with nothing on disk. */
export function memoryStore(): Store {
  const lines: string[] = [];
  const notes = new Map<string, string>();

  return {
    load: () => lines.map((l) => decode(l) as BoomerangEvent),
    append: (list) => {
      for (const e of list) lines.push(encode(e));
    },
    readNote: <T,>(name: string): T | undefined => {
      checkName(name);
      const text = notes.get(name);
      return text === undefined ? undefined : (decode(text) as T);
    },
    writeNote: (name, value) => {
      checkName(name);
      notes.set(name, encode(value));
    },
  };
}

// Every word the "Check it here" section shows, worked out from the run's state. The component
// only lays this out; it reads nothing and runs nothing. The claim for each row is this site's
// sentence; the detail under it is the check function's own text (or the explorer row's wording).
import type { CheckId, CheckResult } from "../flows/checks.ts";

export type ChecksState =
  | { phase: "idle" }
  | { phase: "running"; progress: { id: CheckId; done: number; of: number } | null }
  | { phase: "done"; results: CheckResult[]; block?: bigint }
  /** The run could not start at all (the checks' own code did not load). */
  | { phase: "failed" };

export type ChecksView = {
  title: string;
  intro: string;
  button: string | null;
  running: string | null;
  rows: { id: CheckId; state: "ok" | "fail"; claim: string; detail: string }[];
  verdict: string | null;
  outside: string;
};

const TITLE = "Check it here";
const INTRO =
  "These checks run in this browser when you press the button. They ask the chain directly, which takes a few seconds, or longer if every block has to be read; nothing is sent and no wallet is needed.";
const OUTSIDE =
  "One check cannot run in a browser: that the contract was created by exactly this repository's code and nothing else. The commands below run it, with the other checks, from your own copy of the code.";

const CLAIMS: Record<CheckId, { ok: string; fail: string }> = {
  code: {
    ok: "The code at the contract's address is the code this repository builds.",
    fail: "The code at the contract's address could not be matched to the code this repository builds.",
  },
  "no-owner": {
    ok: "Nothing in that code lets anyone take control of it or remove it.",
    fail: "That code could not be shown to be free of an owner.",
  },
  custody: {
    ok: "The contract holds at least what it owes.",
    fail: "The contract could not be shown to hold what it owes.",
  },
  ledger: {
    ok: "A ledger rebuilt in this browser from the contract's own events matches the contract, campaign by campaign and backer by backer.",
    fail: "A ledger rebuilt in this browser could not be matched to the contract.",
  },
  explorer: {
    ok: "Arc's block explorer holds verified source code for the contract.",
    fail: "Arc's block explorer could not confirm verified source code for the contract.",
  },
};

export function checksView(state: ChecksState): ChecksView {
  const base = { title: TITLE, intro: INTRO, outside: OUTSIDE };

  if (state.phase === "idle") {
    return { ...base, button: "Run the checks", running: null, rows: [], verdict: null };
  }

  if (state.phase === "running") {
    const p = state.progress;
    const running =
      p !== null && p.id === "ledger"
        ? `Reading the contract's events: ${p.done} of ${p.of} requests.`
        : "Running the checks…";
    return { ...base, button: null, running, rows: [], verdict: null };
  }

  if (state.phase === "failed") {
    return { ...base, button: "Run the checks", running: null, rows: [], verdict: "The checks could not be started, so nothing was checked. Try again." };
  }

  const rows = state.results.map((r) => ({
    id: r.id,
    state: (r.ok ? "ok" : "fail") as "ok" | "fail",
    claim: r.ok ? CLAIMS[r.id].ok : CLAIMS[r.id].fail,
    detail: r.detail,
  }));
  const n = state.results.length;
  const failed = state.results.filter((r) => !r.ok).length;
  const verdict =
    failed === 0
      ? `All ${n} checks passed.`
      : `${failed} of ${n} checks did not pass. A check that could not be completed counts as not passed; run them again before reading anything into it.`;
  return { ...base, button: "Run them again", running: null, rows, verdict };
}

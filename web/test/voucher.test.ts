// Every amount, address and time in these tests is invented. None is a reading of any real campaign.
//
// The voucher of a settled campaign, for the backer who is looking at it: their own pledge's
// ending, in My money's words, once nothing is left for them to send.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { voucherMine } from "../src/views/campaign.ts";
import type { MineRow } from "../src/views/mine.ts";
import { pledgeSentLine } from "../src/views/shell.ts";

const row = (over: Partial<MineRow>): MineRow => ({ href: "#/campaign/4", title: "Campaign 4", kind: "returned", line: "1.50 came back, plus 0.13 bonus.", refundTo: null, send: null, ...over });

describe("voucherMine", function () {
  it("voucher.mine.returned: a pledge that came back is said to its backer, and marked as money that came back", function () {
    assert.deepEqual(voucherMine(row({})), { label: "Your pledge", line: "1.50 came back, plus 0.13 bonus.", cameBack: true });
  });

  it("voucher.mine.given: a pledge that went to a funded campaign is said too, and is not marked as come back", function () {
    assert.deepEqual(voucherMine(row({ kind: "given", line: "1.50 went to the campaign. It was funded." })), {
      label: "Your pledge",
      line: "1.50 went to the campaign. It was funded.",
      cameBack: false,
    });
  });

  it("voucher.mine.none: nobody's pledge, a pledge still counted, and a refund still owed (which has its own button) say nothing here", function () {
    assert.equal(voucherMine(null), null);
    assert.equal(voucherMine(row({ kind: "counted", line: "1.50 is counted." })), null);
    assert.equal(voucherMine(row({ kind: "owed", line: "1.63 is owed to you.", send: { button: "Send my refund", note: "", campaign: 4n } })), null);
    // A returned pledge is never shown beside a send button for it.
    assert.equal(voucherMine(row({ send: { button: "Send my refund", note: "", campaign: 4n } })), null);
  });
});

describe("pledge.sentLine", () => {
  it("pledge.sentLine.here: on the campaign's own page the line points at this page, not at 'the campaign page'", () => {
    assert.equal(pledgeSentLine(true), "Your pledge is in. It shows on this page and under My money.");
  });
  it("pledge.sentLine.elsewhere: off the campaign's page it names the campaign page", () => {
    assert.equal(pledgeSentLine(false), "Your pledge is in. It shows on the campaign page and under My money.");
  });
});

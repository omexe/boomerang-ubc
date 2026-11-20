// Every amount and account in these tests is invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Outcome, USD, refused, setup } from "./helpers.ts";

describe("create and fund", async function () {
  const w = await setup();
  const { boomerang, usdc, sponsor, recipient, alice } = w;

  it("createCampaign records the terms, the sponsor and an id from 1", async function () {
    const t = await w.terms();
    await boomerang.write.createCampaign([t], { account: sponsor.account });
    const id = await boomerang.read.campaignCount();
    assert.equal(id, 1n);
    const got = await boomerang.read.termsOf([id]);
    assert.equal(got.target, t.target);
    assert.equal(got.closesAt, t.closesAt);
    assert.equal(got.recipient.toLowerCase(), recipient.account.address.toLowerCase());
    const s = await boomerang.read.stateOf([id]);
    assert.equal(s.sponsor.toLowerCase(), sponsor.account.address.toLowerCase());
    assert.equal(s.outcome, Outcome.Open);
    assert.equal(await boomerang.read.eventCount(), 1n);
  });

  it("createCampaign refuses bad terms", async function () {
    const now = BigInt(await w.time.latest());
    const bad: [Record<string, unknown>, string][] = [
      [{ recipient: "0x0000000000000000000000000000000000000000" }, "recipient"],
      [{ opensAt: now - 1n }, "times"],
      [{ opensAt: now + 500n, earlyUntil: now + 500n }, "times"],
      [{ opensAt: now + 500n, earlyUntil: now + 900n, closesAt: now + 900n }, "times"],
      [{ target: 0n }, "target"],
      [{ target: 10n ** 15n + 1n }, "target"],
      [{ minPledge: 0n }, "minPledge"],
      [{ minPledge: 101n * USD }, "minPledge"],
      [{ matchAmount: 10n ** 15n + 1n }, "matchAmount"],
      [{ bonusPool: 10n ** 15n + 1n }, "bonusPool"],
      [{ rateBps: 10_001 }, "rateBps"],
    ];
    for (const [over, what] of bad) {
      const t = await w.terms(over);
      await refused(boomerang.write.createCampaign([t], { account: sponsor.account }), "BadTerms", what);
    }
  });

  it("each pot is funded once, in full, by its named funder, before opening", async function () {
    const t = await w.terms();
    await boomerang.write.createCampaign([t], { account: sponsor.account });
    const id = await boomerang.read.campaignCount();

    await w.fund(alice, 30n * USD);
    await refused(boomerang.write.fundMatch([id], { account: alice.account }), "NotSponsor");
    await refused(boomerang.write.fundBonus([id], { account: alice.account }), "NotFunder");

    await w.fund(sponsor, t.matchAmount + t.bonusPool);
    const before = await usdc.read.balanceOf([boomerang.address]);
    await boomerang.write.fundMatch([id], { account: sponsor.account });
    assert.equal((await usdc.read.balanceOf([boomerang.address])) - before, t.matchAmount);
    await refused(boomerang.write.fundMatch([id], { account: sponsor.account }), "AlreadyFunded");
    await boomerang.write.fundBonus([id], { account: sponsor.account });
    await refused(boomerang.write.fundBonus([id], { account: sponsor.account }), "AlreadyFunded");

    const s = await boomerang.read.stateOf([id]);
    assert.equal(s.matchIn, true);
    assert.equal(s.bonusIn, true);
    await w.assertCustody();
  });

  it("a recipient-funded bonus is taken from the recipient only", async function () {
    const t = await w.terms({ bonusFromRecipient: true });
    await boomerang.write.createCampaign([t], { account: sponsor.account });
    const id = await boomerang.read.campaignCount();
    await w.fund(sponsor, t.bonusPool);
    await refused(boomerang.write.fundBonus([id], { account: sponsor.account }), "NotFunder");
    await w.fund(recipient, t.bonusPool);
    await boomerang.write.fundBonus([id], { account: recipient.account });
    assert.equal((await boomerang.read.stateOf([id])).bonusIn, true);
  });

  it("a pot cannot be funded from the opening second, and a zero pot needs no funding", async function () {
    const t = await w.terms();
    await boomerang.write.createCampaign([t], { account: sponsor.account });
    const id = await boomerang.read.campaignCount();
    await w.fund(sponsor, t.matchAmount);
    await w.time.increaseTo(t.opensAt - 1n);
    await refused(boomerang.write.fundMatch([id], { account: sponsor.account }), "TooLate");

    const { id: bare } = await w.open({ matchAmount: 0n, bonusPool: 0n });
    await refused(boomerang.write.fundMatch([bare], { account: sponsor.account }), "NothingToFund");
    await refused(boomerang.write.fundBonus([bare], { account: sponsor.account }), "NothingToFund");
  });

  it("an unknown campaign is refused everywhere", async function () {
    await refused(boomerang.read.termsOf([999n]), "NoSuchCampaign");
    await refused(boomerang.write.finalize([0n], { account: alice.account }), "NoSuchCampaign");
    await refused(boomerang.write.pledge([999n, USD], { account: alice.account }), "NoSuchCampaign");
  });
});

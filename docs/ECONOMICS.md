# Economic design and risk assumptions

**Status:** the rules below are the ones the contract enforces, and every number in the worked example is checked by a test. The evidence in section 6 is earlier work: published lab results, and a simulation built for the NEAR Hackathon entry and not rerun here.
**Last reconciled:** 2026-11-19 (the part on why a sponsor would lock the bonus; the rest on 2026-11-15).
**Known gaps:** no real campaign has run, so nothing here is a measurement of how people behave; the simulation's backer inputs are all assumed; the two papers cited were read for the earlier entry, not again this week; no legal view is taken on whether a refund bonus is a wager or a security.

## 1. The problem

In an all-or-nothing crowdfund, the safe move is to wait and see whether others pledge. If everyone waits, a campaign people wanted fails. Failed campaigns mostly fail far from the line: in Mollick's sample of 48,526 Kickstarter projects, failed ones raised 10.3% of their goal on average (Mollick 2014, as recorded in the earlier research).

## 2. The rule

A sponsor locks two pots before the campaign opens:

- a **match**, paid to the recipient only if the target is met;
- a **bonus pool**, paid to early backers only if the target is missed.

If either pot is missing when the campaign opens, the campaign is void and no pledge is accepted.

| Outcome | Backers | Recipient | Sponsor |
|---|---|---|---|
| **Funded** (pledges reach the target; the last pledge is trimmed to the gap) | pledges go to the recipient | pledges + match | bonus pool returned; match spent |
| **Missed** (the deadline passes short of the target) | every pledge back in full; early backers split the bonus | nothing | match returned; unpaid bonus returned |
| **Void** (a pot was not funded in time) | no pledges exist | nothing | whatever was funded is returned |

There are no withdrawals: a pledge stays until the outcome. The sponsor's own account cannot pledge. The sponsor may **rescue** a short campaign only by paying the whole remaining gap with new money, which funds it; nothing promises a rescue.

### The bonus

A pledge made before the early deadline carries a weight: 1 throughout the early window (flat), or falling in a straight line from 1 at opening to 0 at the early deadline (linear). The sponsor picks the shape per campaign. Pledges after the early deadline carry no weight.

If the campaign is missed:

```
bonus paid = (early pledges / target) × min(bonus pool, rate × weighted early pledges)
a backer's share = bonus paid × (their weighted pledge / all weighted pledges), rounded down
```

Two caps and a ramp:

- **Rate cap.** No backer earns more than `rate` on their pledge.
- **Pool cap.** The total never exceeds the pool.
- **Ramp.** Both are scaled by how much of the target was pledged early. A campaign that barely started pays almost nothing; one that came close pays close to the caps. This is what keeps a pile of doomed campaigns from being farmed.

### Worked example (checked by `pay.test.ts`)

Target 100, bonus pool 10, rate 5%, flat weight. Alice pledges 30 and Bob 20 early; Carol pledges 10 late. Total 60: missed.

- Early pledges 50, all at weight 1, so weighted early pledges are 50.
- `min(pool 10, 5% × 50 = 2.5) = 2.5`; scaled by 50/100: **bonus paid 1.25**.
- Alice gets 30 + 0.75. Bob gets 20 + 0.50. Carol gets her 10 back.
- The sponsor gets the whole match back and 8.75 of the pool.

## 3. What each side can lose

- **A backer** cannot lose principal to the rules: funded, it goes where they chose; missed, it comes back. What they give up is the use of the money until the outcome, and any cost of moving it. The contract holds at least everything it owes at all times (`balance >= totalOwed`), which a random-walk test checks after each of 12,000 actions.
- **The sponsor** pays the match or part of the bonus, never both. Funded: the match. Missed: at most `pool × early pledges / target`, which is below the pool because a missed campaign's pledges are below the target.
- **The recipient** risks nothing, unless the sponsor chose to make the recipient fund the bonus pool, which the contract allows per campaign.

### Why a sponsor would lock the bonus

No sponsor has yet. This is the argument, not a result.

The sponsor Boomerang is built for is one who already gives matching money: a donor who matches gifts on a giving day, a department or student government that co-funds a club, a company that sponsors one. A match does its work only if the campaign reaches its target. The bonus pool is what that sponsor adds to make the target more likely:

- **It is small beside the match.** The design's default pool is 10% of the target.
- **It is paid only when the match is not.** Funded: the match is spent and the pool comes back. Missed: the match comes back and part of the pool is spent. Never both.
- **A miss costs in proportion to how close it came.** The ramp scales the bonus by how much of the target was pledged early, so a campaign nobody wanted costs the sponsor almost nothing.
- **What it bought in a lab.** With a 20% bonus on early pledges, funded campaigns rose from 43.5% to 67.0% (section 6). It has not been tried with real money.

In numbers (from the formula above; the same arithmetic as the tested example): target 1,000, match 250, pool 100, rate 20%, flat weight.

| The campaign ends with | The sponsor pays | Backers get |
|---|---|---|
| 1,000 or more: funded | the 250 match; the 100 pool comes back | nothing back; the recipient gets 1,250 |
| 600, all pledged early: missed | 60 of the pool; the match and 40 come back | 600 + 60 |
| 100, all pledged early: missed | 2 of the pool | 100 + 2 |

So a sponsor who was ready to give 250 risks at most just under 100 more, only when the 250 is not spent, and most of it only when the campaign came close.

Two other payers are possible. The recipient can fund the pool itself (the contract allows it per campaign), which is Tabarrok's original form: whoever gains from the project puts up the prize. And whoever runs campaigns for many causes could fund pools to bring backers in. Neither has been tried either.

## 4. Why early

The bonus goes only to pledges in the early window because that is where the waiting problem is. A late pledge already knows how the campaign is going. Under linear weight the earliest pledge earns the most; under flat weight every early pledge earns the same rate.

## 5. Ways to game it, and what remains

The full table, with the test for each row, is [ATTACKS.md](ATTACKS.md). The ones that are about economics rather than code:

- **Farming the bonus on campaigns expected to fail.** Bounded by the rate cap, the pool cap and the ramp. What remains: up to the bonus paid, when nobody completes the campaign.
- **Pumping the bonus late.** Nothing after the early deadline changes it.
- **The sponsor topping up to fake demand.** The sponsor's account cannot pledge, and a rescue is all of the gap or nothing.
- **Not defended, and said so:** the contract cannot see who owns a wallet. A recipient can back its own campaign from other wallets and complete it to collect the match; a sponsor's friends can pledge early and collect bonus on a miss. The loss is capped by the pots the sponsor chose to lock. The earlier simulation put a number on the first: a recipient who pledges 10% early and closes the gap whenever the campaign is short gains about 726 per campaign on a 2,000 target with a 1,000 match. A match buys less outside money than it appears to.

## 6. Evidence, all of it earlier work

- **Theory.** The refund bonus is Tabarrok's dominant assurance contract (Tabarrok 1998, *Public Choice* 96). Boomerang's version does not claim his result: with a bonus limited to early pledges and capped, pledging early is rewarded, not dominant.
- **Lab.** Cason, Tabarrok and Zubrickas (2021, *Games and Economic Behavior* 129) ran groups of 10 with a target of 300 and a two-minute window. Campaigns funded 43.5% of the time with no bonus (74 of 170), 60.5% with a 20% bonus on every pledge (133 of 220), and 67.0% with a 20% bonus only on pledges in the first minute (154 of 230). The two bonus treatments did not differ significantly (p = 0.120); the early-only one paid less bonus.
- **Simulation** (built 2026-11-09 for the NEAR entry; its code is not in this repository; 2,000 simulated campaigns per setting; target 2,000, match 1,000, rate 20%, pool 10% of target, early window 60% of 14 days). Every backer input is assumed, and the model's belief loop did not fully settle (about 2 points of noise), so read these as properties of a model:

| Rule | Campaigns funded [95% interval] | Mean bonus paid per campaign |
|---|---|---|
| Match only | 38.2% [36.0, 40.3] | 0 |
| Bonus on every pledge | 73.4% [71.4, 75.3] | 51.2 |
| Boomerang's rule, linear weight | 57.75% [55.6, 59.9] | 28.6 |
| Boomerang's rule, flat weight | 59.6% [57.4, 61.8] | 38.9 |

  When every simulated backer weighed waiting, the match alone funded no campaign and Boomerang's rule funded 36.85%. No tested outside coalition made money under Boomerang's rule in any of 48 settings. That is a sample of strategies, not a proof.

## 7. Risk assumptions

1. **USDC behaves as USDC.** The contract is fixed to one token at deployment. It checks that every incoming transfer arrives in full, and a payout the token refuses stays owed. It does not defend against a token that lies about balances. Circle can block an address: a blocked backer's payout stays owed until they redirect it to another address; a blocked contract would stop everything.
2. **No one can change or rescue the contract.** No owner, no upgrade, no pause, no sweep. A bug cannot be patched; the answer to one is a new deployment and the old one paying out under its own rules.
3. **Time is the block's timestamp.** Deadlines are exact to the second on chain. A validator's small freedom over timestamps matters only for a pledge within seconds of a deadline.
4. **Nobody has to be honest or online for payouts.** After the deadline anyone can finalize and pay anyone. The keeper makes it prompt, not possible.
5. **Rounding.** Shares round down. The dust (at most one base unit per early backer) stays in the contract, counted as owed and paid to no one.
6. **Cross-chain pledges** depend on Circle's CCTP attestation service being up. A burn that is never attested never arrives; that is CCTP's risk, not a rule of this contract. A pledge that arrives too late is forwarded to the backer's address on Arc.
7. **One person, many wallets.** Nothing here resists it (section 5).
8. **Testnet only.** Nothing in this repository has held real money.

## 8. Not claimed

- That backers will behave as the lab's or the simulation's did.
- That pledging early is anyone's best move in every case.
- That a sponsor will rescue.
- Any legal conclusion.

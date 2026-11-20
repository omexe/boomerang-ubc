# Boomerang on Arc

A crowdfund where backing early is safe.

A sponsor locks two pots before a campaign opens: a **match**, paid to the recipient only if the target is met, and a **bonus**, paid to early backers only if it is missed. Hit the target and the recipient gets the pledges plus the match. Miss it and every backer gets everything back, with the early backers splitting the bonus. Nobody can withdraw early, and nobody controls the contract. (A campaign's terms can have the recipient lock the bonus pot in place of the sponsor; whatever of it is not paid out then goes back to the recipient.)

It is built for a campus club or a community with a sponsor behind it: the sponsor's money does two jobs, and only one of them is ever paid.

**Status:** live on Arc Testnet (UBC 2026 hackathon week). The contracts were deployed on 2026-11-17 UTC (block 72640266), their sources are verified on Arc's explorer, and they pass all six live checks (`npm run verify`). The page is at https://boomerang-arc.vercel.app and the keeper runs on Azure, reading Arc's node itself. As of 2026-11-20 08:06 UTC, twelve campaigns have run on Arc, with thirteen one-signature pledges relayed by the keeper. The last seven were two-minute campaigns opened from the page's desk and settled by the keeper, and the last five pledges were signed by the page's practice wallet. The page's Proof tab shows the count as it is now.
**Last reconciled:** 2026-11-20.
**Known gaps:** the practice wallet has pledged five times on Arc (campaigns 7 to 11, 2026-11-19; the fourth and fifth from newly made ones); each new one takes 2.00 of the desk's test USDC, with no daily cap; the checks on Proof take four to five seconds on Arc (timed three times on 2026-11-19, in one browser) and longer as the chain grows; how common wallets show the signed pledge's typed data is not checked (the pledges on Arc were signed by scripts, and five by the page's practice wallet); the cross-chain router is deployed but has only run against a stand-in for Circle's contracts written from Circle's published source, and the page has no form for a pledge from another chain (`scripts/cross-chain-pledge.mjs` makes one from Base Sepolia or Sepolia with the page's own flow code; it has been run only as a dry look, never with `--send`); the page opens campaigns only through its desk, on fixed two-minute or ten-minute terms; no real campaign has run, and all money is test USDC.

## How it works

| Outcome | Backers | Recipient | Sponsor |
|---|---|---|---|
| **Funded**: pledges reach the target | pledges go to the recipient | pledges + match | bonus pool returned |
| **Missed**: the deadline passes short | every pledge back in full; early backers split the bonus | nothing | match returned; unpaid bonus returned |
| **Void**: a pot was not locked by opening | no pledge was accepted | nothing | whatever was locked is returned |

A worked example, checked by a test: target 100, bonus pool 10, rate 5%. Alice pledges 30 and Bob 20 in the early window, Carol 10 after it. The campaign misses at 60. Alice gets 30.75 back, Bob 20.50, Carol 10. The sponsor gets the whole match back and 8.75 of the pool.

Before anyone pledges, the contract answers the question a backer actually has: `quoteIfMissed(campaign, amount)` returns what that pledge would bring back if the campaign then missed.

The full rules, what each side can lose, the ways to game it and the risk assumptions are in **[docs/ECONOMICS.md](docs/ECONOMICS.md)**.

## What is built

| Part | Path | What it does |
|---|---|---|
| The contract | `contracts/contracts/Boomerang.sol` | Every campaign rule and all the money. No owner, no upgrade, no pause, no sweep. |
| The cross-chain router | `contracts/contracts/PledgeRouter.sol` | Turns a CCTP mint arriving on Arc into a pledge in one transaction; whatever the campaign does not take goes to the backer's address on Arc. |
| The one-signature pledge | `contracts/contracts/SignedPledge.sol` | A backer signs Circle's USDC transfer authorization once (no transaction, no gas); the keeper submits it, and the helper pledges it in the backer's name. The signature names one campaign, one amount and a three-minute window. If the keeper is down or refuses, the page offers the ordinary two-step pledge. |
| The keeper | `services/keeper/` | Reads Arc's node every five seconds, rebuilds a ledger from the events alone, and makes the calls that settle a campaign. It has no rights in the contract. |
| The kit | `packages/kit/` | The contract's arithmetic in TypeScript, event decoding and the event-built ledger, each tested equal to the contract. |
| The page | `web/` | Reads the contract from the browser. The pledge form is a cheque: "Pay to the order of" the campaign, "the sum of" what is typed, and beside the button what comes back if the target is missed, in the contract's own figure, before anyone pays. The landing page shows the two endings as a boomerang's flight, plays one campaign through, and lists every campaign on the contract with its outcome, Cleared or Returned. A campaign's own page has what is left to raise, the time left, the early-bonus clock and a chart of the climb. A campaign's page also lists its backers: the addresses from the keeper's ledger, every figure beside them from the contract. My money shows the connected account's pledges, looks up any address (and lets anyone send that backer's refund, which can only pay the backer), and shows a real backer as an example when nobody is connected. A visitor with no wallet can try a pledge with a practice wallet: a key the page makes and keeps in that browser, for test money only, funded by the site's desk. Proof sets the keeper's event-built ledger against the contract at one block, lists every campaign with how it ended, and runs five of the six live checks in the visitor's own browser at the press of a button. Plain files once built; no server of its own. The design as built: [web/DESIGN.md](web/DESIGN.md). |
| Scripts | `scripts/` | Deploy, demo campaigns, a keyless check of a live deployment, a cross-chain pledge from a test wallet, and the whole app on one machine. |

How the parts fit, and what still works when each one stops: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Arc

- The contract takes one token, fixed at deployment: USDC on Arc Testnet (chain 5042002), through its ERC-20 interface at `0x3600000000000000000000000000000000000000` (6 decimals).
- Deadlines are block timestamps.
- A backer on another chain pledges through Circle's CCTP V2: the burn names the router on Arc and carries the campaign and the backer's address as hook data.
- A backer on Arc can pledge with one signature: Circle's EIP-3009 `receiveWithAuthorization` on USDC (EIP-712 domain "USDC", version "2", which Arc Testnet's USDC answers), payable only to `SignedPledge`, with a nonce that binds the campaign and the amount. Not EIP-2612 `permit`, which cannot bind the campaign.

### Addresses

| Contract | Arc Testnet |
|---|---|
| Boomerang | [`0x03Aa341b3128fD5d742bCCE00133791a6bcE7F97`](https://explorer.testnet.arc.io/address/0x03Aa341b3128fD5d742bCCE00133791a6bcE7F97) |
| PledgeRouter | [`0xc9e2b828f63e104dfe6d67bdb7bfc2e76cc67b2a`](https://explorer.testnet.arc.io/address/0xc9e2b828f63e104dfe6d67bdb7bfc2e76cc67b2a) |
| SignedPledge | [`0x2eef524e9c7ea4d8fd1a7e771aca60e1010cb87a`](https://explorer.testnet.arc.io/address/0x2eef524e9c7ea4d8fd1a7e771aca60e1010cb87a) |
| USDC (Circle) | `0x3600000000000000000000000000000000000000` |
| CCTP MessageTransmitterV2 (Circle) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| CCTP TokenMessengerV2 (Circle) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |

## How settlement happens on time

The contract does nothing by itself at a deadline: someone has to call `finalize` and the payouts. The keeper is what makes that happen on time, and it needs nothing but a node.

**What it reads.** Every five seconds the keeper asks Arc's node for the newest block and for the contract's logs since the last block it heard ([`services/keeper/src/follow.ts`](services/keeper/src/follow.ts)). It reads in small steps when it is a long way behind, since a public node refuses a burst, and it re-reads from the contract's first block when an event number has been missing from its ledger for a minute.

**What it does with it.** It rebuilds each campaign's totals from the events alone, in sequence-number order, and on every read works out from that ledger which calls would move a campaign forward. Before it sends a call it asks the contract whether that call would change anything, so a wrong reading costs no gas.

**If it is off.** Those calls are open to anyone, so payouts are only later, never lost. The page offers them to any visitor.

**On Arc.** The seven campaigns that came due between 2026-11-18 20:53 UTC and 2026-11-20 08:06 UTC (campaigns 6 to 12) were finalized and paid by the keeper with nobody pressing anything. In the most recent one with a backer (campaign 11, 2026-11-19) the campaign was finalized one second after its deadline and the backer's refund and bonus landed 14 seconds after it. Campaign 12 (2026-11-20, no backer), the first after the keeper's latest deploy, was finalized five seconds after its deadline, and both pots were back with their funder within 14.

## Run it

Needs Node 26.

```bash
npm install
```

```bash
npm test
```

`npm test` runs the contract tests on Hardhat's in-memory chain (the rules with worked numbers, the attack table, a random walk that checks custody after every action, the router, the kit against the contract, the keeper against the contract, the scripts, the app's reading of the keeper's ledger), then the keeper's own tests and the app's.

One of those tests runs the keeper against a real node with nothing built by hand in between (`contracts/test/follow.test.ts`): it reads the node's own JSON-RPC, settles a funded, a void and a missed campaign, and fills a hole in its ledger from the node.

The whole app on one machine, with nothing deployed and no wallet extension (a local node, the contracts, three example campaigns, the keeper with its desk, and the page at `http://127.0.0.1:5173/`):

```bash
cd contracts && npx hardhat build
```

```bash
node scripts/dev-local.mjs
```

It touches no network. The page offers a "Local test wallet", which is one of the local node's own unlocked test accounts; that wallet exists only when the page is pointed at a local chain and stops the app if it is set for Arc Testnet.

Deploying, and checking a deployment without any key:

```bash
cd contracts && npx hardhat keystore set ARC_DEPLOYER_KEY
```

```bash
cd contracts && npx hardhat run ../scripts/deploy.ts --network arcTestnet
```

```bash
npm run verify
```

`npm run verify` builds the contracts (the compiled code the check compares against) and then runs `node scripts/check-live.mjs`. On a fresh copy that is all it takes: `git clone`, `npm ci`, `npm run verify`.

For the ledger row the script asks Arc's explorer which blocks hold the contract's logs, reads those logs from the node itself, and counts the read whole only when the events are numbered 1 to N with none missing and N is the contract's own `eventCount` at the same block. The explorer is trusted with nothing else: a short or wrong list cannot make the row pass, it only makes the script read more. `node scripts/check-live.mjs --full` asks no one and reads every block since the contract's first, at the pace Arc's public node accepts (about three log requests a second, measured 2026-11-18, and by the look of its refusals about sixty a minute), which takes longer as the chain grows. The page's "Run the checks" reads the same way.

`check-live.mjs` holds no key and sends nothing. It exits 0 when every check passes, 1 when one fails, and 2 when it could not check (it says what is missing). The token it holds the contract to, Circle's USDC on Arc Testnet, is written in the script and not read from the addresses file. It checks six things: the deployed code is this repository's and was built with Circle's USDC address; the transaction that created the contract carried this repository's creation code and that address and nothing else, so the contract began with no state of anyone's making; the ABI has no owner functions and the deployed code has no `DELEGATECALL`, `CALLCODE` or `SELFDESTRUCT`; the contract holds at least what it owes at one block; a ledger rebuilt from the events equals the contract's own state; and the one-signature helper runs this repository's code, bound to that token and this contract.

## What is defended, and what is not

**[docs/ATTACKS.md](docs/ATTACKS.md)** lists each attack considered, the rule that answers it, what remains, and the test that shows it. Three things it says plainly:

- The contract cannot see who owns a wallet. A recipient can back its own campaign to collect the match, and a sponsor's friends can pledge early to collect the bonus on a miss. The loss is capped by the pots the sponsor chose to lock.
- A bug cannot be patched. There is no upgrade path; the answer to a bug is a new deployment.
- Testnet only. Nothing here has held real money.

## Not claimed

- That backers will behave as they did in the lab studies or the earlier simulation cited in ECONOMICS.md.
- That pledging early is anyone's best move in every case.
- Any legal conclusion about refund bonuses.

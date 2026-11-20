# Boomerang's page: the design as built

One world: security paper. The page is a bank's stationery, and the pledge form is a cheque: "Pay to the order of" the campaign, "the sum of" what is typed, and beside the button both endings in the receipt's own sentences: what comes back if it falls short, as the contract's figure, and where the money goes if the target is met. Green ink does the reading. Vermilion means only one thing: it came back.

The approved comp is `design/mockups-b/src/c-cheque.html` in the build folder (the landing page; picked 2026-11-17). This file records what the code does, and it wins where the two differ. The look it replaced, a blue scoreboard, is gone.

## Colour

Light only. Tokens are at the top of `src/styles/world.css`.

| Token | Value | Use |
|---|---|---|
| `--paper` | `#edf2ea` | the page |
| `--sheet` | `#f6f9f3` | a document on the page: the cheque, the chart, the how-it-works board, a settled campaign's voucher |
| `--ink` | `#12392c` | text, figures, the main button, the Cleared stamp |
| `--ink-2` | `#2f5546` | secondary sentences |
| `--ink-soft` | `#557366` | captions and quiet notes (4.6:1 on the paper; nothing lighter is used for text) |
| `--guil` / `--rule` | `#b7ccb4` / `#cfdccb` | engraved lines, dashed tear lines / hairlines between rows |
| `--verm` | `#b8352a` | "it came back": the Returned stamp, the cheque's "If it falls short" figure, money owed or returned to a backer; and errors |

Vermilion is never decoration, hover or emphasis. A figure that is still moving gets no colour of its own.

## Type

Self-hosted variable faces (`@fontsource-variable/*` 5.3.0, OFL-1.1), imported in `src/main.tsx`.

- **Fraunces** (all axes, upright and italic): headings, the brand, campaign names, and the cheque's printed wording in italic. Display sizes use `"opsz" 120` to `144` and `"SOFT" 30`, weight 600, tracking -0.03em.
- **Geist**: every sentence and every figure. Figures are weight 600 with tabular numerals.
- **Geist Mono**: addresses and commands only.
- Sentence case everywhere. The only uppercase is a rubber stamp.

## Shape

- A sheet has a 10 to 12px corner and one soft shadow with an offset. Sheets are never nested.
- Lists and terms are not cards: they are ruled rows on the paper, a 1.5px ink rule on top and 1px hairlines between. A short value sits flush right beside its label; a value that is a sentence (over 60 characters) reads from the left under it.
- An outcome is a rotated rubber stamp (2 to 3px border in its own colour, uppercase, tracked, `mix-blend-mode: multiply`): Cleared in ink, Returned in vermilion, Never opened in soft ink.
- The guilloche (rosette and waves) is drawn by formula in `src/views/guilloche.ts`; nothing is an image.

## The landing page (`#/`)

`src/pages/Home.tsx`, scoped under `.landing` in `src/styles/landing.css`.

1. **Hero, a Z.** Headline top left; the flight top right; the cheque bottom left; the flight's caption bottom right. Under 900px: headline, lede, flight with its caption hanging under it, cheque, trust lines.
2. **The cheque** (`src/ui/Cheque.tsx`, `src/styles/cheque.css`) is the working pledge form, made out to the newest campaign taking pledges (a list when there are several). It starts at 2.00. When no campaign is taking pledges it is blank and offers a two-minute campaign from the site's desk, with a ten-minute one as a quiet second choice under the button.
3. **The flight** (`src/ui/Flight.tsx`, `src/ui/flight.ts`): one 3D boomerang (three.js, loaded after first paint in its own chunk) flies the two endings in turn, landing with the recipient or coming back to you. A line drawing stands in until it has drawn and if WebGL is missing. It pauses off screen and in a hidden tab.
4. **How it works** (`src/ui/HowBoard.tsx`): on wide screens one board is pinned while scrolling plays a campaign through: pots sealed, pledges in, Cleared, then a second campaign Returned. On a phone and with reduced motion it shows the finished returned campaign. Its figures are from real campaigns on Arc.
5. **Campaigns** (`src/ui/Ledger.tsx`, `src/views/ledger.ts`): every campaign on the contract, open ones first, each with its stamp; then the contract's running totals.
6. **The guarantee**: four facts about the contract and its address, linked to the explorer.
7. **Closing**: one button that starts a two-minute campaign where the site has a desk, and a quiet line under it for a ten-minute one. A desk campaign is named by the time the contract holds it open (under five minutes reads as two-minute).

## A campaign (`#/campaign/N`)

`src/pages/Campaign.tsx`. Wide: the name; then on the left a strip of three figures (To go, Time left, and Early bonus ends in while that window is open, otherwise Backers) over the chart on a sheet; on the right the cheque, which stays in view while scrolling. Then the rule in one italic sentence, and two columns of ruled rows: what has happened, and the terms.

Once a campaign stops taking pledges the cheque gives way to a voucher: the outcome stamp, what happened in figures, and the Settle button while it is waiting to be settled. Under a ruled line the voucher then lists, first, the connected backer's own refund when one is owed (in My money's words, with its button), and then whatever the contract still owes the recipient or the funders of the pots (by its own paid flags), each with a line button anyone may press: Pay the recipient, Return the match, Return the bonus. The keeper normally sends these within seconds, so they are seen mostly when it is down, and the note under them says which is the case. The stamp is the contract's recorded outcome; what has and has not been paid yet is said in the lines under it. Right under the stamp a backer who is connected reads their own ending first, in My money's sentence (`voucherMine` in `src/views/campaign.ts`): "1.50 came back, plus 0.13 bonus." in vermilion, or what went to a funded campaign in ink. Once that is said, the note about sending one's own refund is left out. A phone gets one column: name, cheque or voucher, figures, chart, rule, events, terms.

The chart (`src/ui/Chart.tsx`, `src/views/chart.ts`) keeps its geometry: opening to closing across, the early window tinted, a dashed target line, a dotted pace line while pledges can come in, and the climb in ink. A screen reader gets a sentence and a table. The words under its two ends come from `axisEnds`: a campaign whose two ends fall on one UTC day is marked by the time of day at each end ("Opens 01:25 UTC", "Closes 01:27 UTC"), since the same date twice says nothing; any other by the day, with the year when its ends are in different years.

Under the terms, **Backers** (`src/views/backers.ts`): a ruled table of account, pledged, Early or Late, and what comes back, ending in the contract's own count and sum. The addresses are the keeper's (the contract keeps no list); every figure is the contract's, read at the page's block, and each account links to its money. When the rows do not add up to the contract's total the note says so; when the sponsor closed a gap that is its own row; with the keeper down there is no list, only the contract's count and sum. On a phone the header is hidden and each backer is two lines.

`#/campaign/N/pledge` is the same page with the cursor in the amount field.

## My money and Proof

My money (`src/views/mine.ts`) opens with a field: **Look up any address**. `#/mine/0x…` shows that account under the tag "Another account", in the third person, and a refund owed there has a "Send this refund" button for whoever is connected; it can only pay that backer. With nobody connected the page shows "An example": a real backer, named by the keeper's ledger and read from the contract. Above the rows sit four figures: campaigns backed, backed early, paid back, went to cleared campaigns.

Proof has two more sections. **Every campaign, and how it ended**: a table of campaign, Cleared or Returned (or Open, Waiting to be settled, Never opened), pledged of target, and whether it is paid. **Check it here** (`src/views/checks.ts`, `src/flows/checks.ts`): a button that runs five of the command line's six checks in the visitor's browser (the code against a fingerprint of the build, no owner, custody, a ledger rebuilt from the contract's events, the explorer's verified flag), each a drawn tick or cross over the check's own sentence. For the ledger the explorer says which blocks hold the events, the node supplies them, and the contract's own count shows none is missing; the row's detail says which way it read. The checks' code is loaded only when the button is pressed. The sixth check, how the contract was created, needs the compiled code and stays with the commands.

Proof's "Check it yourself" block is four commands that work from nothing (clone, `npm ci`, `npm run verify`); the last builds the contracts and runs the keyless live check.

Working screens: a Fraunces heading, then ruled rows. On My money a pledge that is owed back or came back is set in vermilion. On Proof each verdict is a sentence with a drawn check or cross in front, ink when it holds and vermilion when it does not.

## The frame

`src/app/App.tsx` draws the bar (brand, four links, the wallet), the notices under it, and the foot. Where nobody is connected and the desk is up, a **practice wallet** is offered by name (`src/wallet/practice.ts`, `src/views/practice.ts`, `src/ui/Practice.tsx`): in the bar and as the cheque's own button when the browser has no wallet, and as a line button under "Connect a wallet" when it has one. It is a key the page makes and keeps in the browser's storage; it signs only a pledge authorization on the app's USDC and sends only its own account's transactions. The bar then reads "Practice wallet 0x…", with "Use my own wallet" beside it when the browser has one. Every sentence about it says it is for test money only. Nothing in the bar breaks inside itself: when a connected wallet leaves no room, the wallet drops to a row of its own. Under 900px the bar is two or three rows, so it stays at the top of the page and does not follow the scroll; under 600px the wallet's two parts may break. On a chart, the total's label goes under its point where it would land on TARGET or PACE NEEDED (`valueLabelY`, tests `chart.valueLabel.*`). "How it works" and "Campaigns" go to those parts of the landing page. The foot of every page carries the one disclaimer: which network this is, that the money is test money, and that the contract is unaudited. No other visible copy says "demo" or "testnet", except where a wallet instruction has to name the network the wallet shows, and the Proof page's list of what the app does not claim.

## Motion

- **Curve:** `cubic-bezier(0.16, 1, 0.3, 1)` (`--ease`); GSAP's `expo.out` on the landing page. No bounce.
- **Landing page** (`src/ui/motion.ts`, GSAP 3.12.5 with ScrollTrigger, Lenis 1.1.13): the headline rises line by line, then the lede, cheque and trust lines in reading order; the rosette traces itself in and turns once every four minutes; the how-it-works board is pinned and scrubbed; ledger rows and their stamps arrive once; smooth scrolling runs only while this page is open. Everything is reverted when the page is left.
- **Working pages:** a changed figure flips only the digits that changed (`src/ui/Plate.tsx`, `src/views/flip.ts`); the cheque's "If it falls short" figure rises 4px when the contract's answer changes it, never while typing; a new event slides in at the top of its list; the chart's newest step extends. Press is `scale(0.97)`. Hover effects only for a fine pointer. The one staged moment is a campaign's ending: the stamp comes down on the voucher (360ms, from 1.45 scale and a slight blur), then the backer's own line rises under it. A send's steps show one under another while it runs, the current one in ink and the earlier ones soft; when it is in, one line in ink replaces them.
- **Reduced motion:** no GSAP, no smooth scroll, one still frame of the flight, crossfades in place of movement.

## Words

Every sentence comes from a tested view function in `src/views/` or `src/data/`; fixed words are in `WORDS` (`src/views/shell.ts`). Outcomes are called Cleared, Returned and Never opened. The site speaks of a campaign in the third person. There are no em dashes in visible copy.

## Checks

- Tests: `test/styles.test.ts` (a class one stylesheet styles bare must not reach another page's element of that name: the board's figures once stood one character to a line), `test/voucher.test.ts` (the backer's own line on the voucher, and the line under the cheque once a pledge is in, which says "this page" on the campaign's own page), `test/holes.test.ts` (what the page offers and says with the keeper down, with no wallet, at the edges of the terms and past fifty campaigns), `test/board.test.ts` (figures, clocks, outcomes, chart geometry, flip), `test/ledger.test.ts` (the campaigns table), `test/guilloche.test.ts` (the engraved lines), `test/views.test.ts` (every page's words, the frame), `test/practice.test.ts` (what the practice wallet signs, sends and refuses, and its key's storage), `test/mine.test.ts` (the look-up, another account, the example, the figures), `test/backers.test.ts` (the backers table in every state), `test/checks.test.ts` (the browser checks and the campaigns table), `test/plumbing.test.ts`; against the real contracts in memory, `contracts/test/web-practice.test.ts`, `web-world.test.ts` and `fingerprint.test.ts`.
- Seen in a browser on the local loop at 1440 and 390 wide: the landing page top to bottom, a campaign taking pledges, a returned and a cleared campaign, My money, Proof, and a one-signature pledge from the landing page's cheque. With the keeper frozen (2026-11-18): a two-step pledge, Settle, Pay the recipient, Return the match, Return the bonus and Send my refund, each from the page. The practice wallet and the pages of 2026-11-18 (captures in `design/checks/task14/`): with no wallet in the browser, two presses from the landing page to a pledge; My money for that wallet, for an address typed in capitals, and the example; the backers table for a returned campaign, and its keeper-down sentence; Proof's campaigns table and four checks passing on the local chain; and, with the keeper frozen, the practice wallet settling a missed campaign and sending another account's refund. Not seen: "Use my own wallet", and the practice wallet on Arc.

# Boomerang — new frontend (site/)

The crowdfund that pays you to go first. Frontend only, for now.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Stack

- Next.js (app router) + TypeScript + Tailwind v4
- React Three Fiber + drei + postprocessing for the island scene
- anime.js for headline reveals and count-ups
- LT Superior Serif (local, `app/fonts`) + Geist

## Where things live

- `app/page.tsx` — home page sections and copy
- `lib/story.ts` — the scroll keyframes (one per section) and the demo campaign
- `components/home/IslandScene.tsx` — the 3D island, beacon, match block, bonus boomerang, 200 pilgrims, recipient islet
- `components/home/geometry.ts` — procedural island + boomerang geometry
- `components/home/CampaignHud.tsx` — the live campaign card
- `components/home/ScrollDriver.tsx` — maps scroll to scene state

To change what the island does in a section, edit that section's row in `lib/story.ts`.

## Status

The redesigned frontend, built beside `web/`. Pages:

- `/`: the home page (garden island, scroll story). Older scenes at `?scene=v1` and `?scene=v2`.
- `/login`: pick backer or sponsor; the practice wallet is the default.
- `/explore`: every campaign on the contract, live first.
- `/campaign/[id]`: one campaign in the garden palette, with pledging (`/campaign/[id]/pledge` focuses the amount).
- `/sponsor`: placeholder until the sponsor pages.

The working pages reuse the existing app's code directly: `web/src/data`, `web/src/flows`,
`web/src/views`, `web/src/wallet` and `packages/kit`, through `lib/boomerang/engine.tsx`. So the
contract reads, the one-signature pledge, the two-step fallback, the practice wallet and every
sentence are the same code `web/` runs.

## Setup

```bash
cp .env.example .env.local   # then set NEXT_PUBLIC_KEEPER_URL (same value as web's VITE_KEEPER_URL)
npm install
npm run dev
```

Without the keeper URL every campaign still reads from the contract, but the practice wallet
gets no test USDC and one-signature pledges are off. `NEXT_PUBLIC_MOCK=1` shows made-up
campaigns with no network, for checking layouts.

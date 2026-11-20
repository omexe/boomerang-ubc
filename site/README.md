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

This is the redesigned frontend, built beside `web/` on the `frontend` branch. It is standalone for now (its own package.json, not a root workspace) and runs on demo data from `lib/story.ts`. Next step: read real campaigns through the contract reads in `web/src/data` and `packages/kit`, then add the backer and sponsor dashboards.

Run it from this folder: `npm install && npm run dev`.

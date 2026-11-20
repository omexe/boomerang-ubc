// Shared scroll state for the home page. The DOM writes `target`,
// a single rAF loop eases `p` toward it, and the 3D scene + HUD read `p`.

export type StoryParams = {
  zoom: number; // orthographic zoom multiplier
  offsetX: number; // fraction of viewport to shift the island right (+) or left (-)
  lift: number; // camera target y
  spin: number; // extra rotation of the world, radians
  early: number; // 0..1 of early pilgrims standing at the beacon
  late: number; // 0..1 of late pilgrims standing at the beacon
  hesitate: number; // one pilgrim steps forward and back
  match: number; // 0 = match block hidden above, 1 = locked beside beacon
  bonus: number; // boomerang visible + orbiting
  met: number; // success state
  missed: number; // failure state
  many: number; // other islands appear
};

export const SECTION_COUNT = 9;

const K: StoryParams[] = [
  // 0 hero
  { zoom: 1.0, offsetX: 0.2, lift: -0.4, spin: 0, early: 0.55, late: 0.15, hesitate: 0, match: 1, bonus: 1, met: 0, missed: 0, many: 0 },
  // 1 the problem
  { zoom: 1.12, offsetX: 0.2, lift: -0.6, spin: 0.5, early: 0, late: 0, hesitate: 1, match: 0, bonus: 0, met: 0, missed: 0, many: 0 },
  // 2 the sponsor locks match + bonus
  { zoom: 1.3, offsetX: 0.2, lift: 0.1, spin: 1.0, early: 0, late: 0, hesitate: 0, match: 1, bonus: 1, met: 0, missed: 0, many: 0 },
  // 3 early backers
  { zoom: 1.15, offsetX: 0.2, lift: -0.3, spin: 1.5, early: 1, late: 0, hesitate: 0, match: 1, bonus: 1, met: 0, missed: 0, many: 0 },
  // 4 late backers
  { zoom: 1.1, offsetX: 0.2, lift: -0.3, spin: 2.0, early: 1, late: 0.65, hesitate: 0, match: 1, bonus: 1, met: 0, missed: 0, many: 0 },
  // 5 goal met
  { zoom: 1.0, offsetX: 0.22, lift: -0.2, spin: 2.35, early: 1, late: 1, hesitate: 0, match: 1, bonus: 1, met: 1, missed: 0, many: 0 },
  // 6 goal missed
  { zoom: 1.1, offsetX: 0.2, lift: -0.4, spin: 2.9, early: 0.8, late: 0.3, hesitate: 0, match: 1, bonus: 1, met: 0, missed: 1, many: 0 },
  // 7 why now
  { zoom: 0.5, offsetX: 0.2, lift: -0.8, spin: 3.4, early: 0.7, late: 0.3, hesitate: 0, match: 1, bonus: 1, met: 0, missed: 0, many: 1 },
  // 8 call to action
  { zoom: 1.0, offsetX: 0.2, lift: -0.3, spin: 3.8, early: 1, late: 1, hesitate: 0, match: 1, bonus: 1, met: 1, missed: 0, many: 0 },
];

const smooth = (t: number) => t * t * (3 - 2 * t);

export function paramsAt(p: number): StoryParams {
  const c = Math.min(Math.max(p, 0), SECTION_COUNT - 1);
  const i = Math.min(Math.floor(c), SECTION_COUNT - 2);
  const f = smooth(c - i);
  const a = K[i];
  const b = K[i + 1];
  const out = {} as StoryParams;
  (Object.keys(a) as (keyof StoryParams)[]).forEach((k) => {
    out[k] = a[k] + (b[k] - a[k]) * f;
  });
  return out;
}

export const story = {
  target: 0,
  p: 0,
  note: "", // legend line for the campaign card, set by the active scene
};

// ---- campaign used across the home page ---------------------------------

export const PILGRIMS = 200; // one figure = 0.5% of the goal
export const EARLY_COUNT = 120;
export const LATE_COUNT = PILGRIMS - EARLY_COUNT;

export const demoCampaign = {
  name: "Builder House, Denver",
  blurb: "Six nights of venue for a 300-person builder meetup",
  sponsor: "Front Range DAO",
  recipient: "Larimer Hall",
  goal: 40_000,
  match: 10_000,
  bonus: 4_000,
};

export function campaignAt(p: number) {
  const s = paramsAt(p);
  const early = Math.round(s.early * EARLY_COUNT);
  const late = Math.round(s.late * LATE_COUNT);
  const backers = early + late;
  const pledged = (backers / PILGRIMS) * demoCampaign.goal;
  let status: "live" | "met" | "missed" | "waiting" = "live";
  if (s.met > 0.5) status = "met";
  else if (s.missed > 0.5) status = "missed";
  else if (backers === 0) status = "waiting";
  return { early, late, backers, pledged, status, s };
}

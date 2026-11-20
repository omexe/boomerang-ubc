// The garden island shared by the home scene and the campaign pages: image size, the
// gardener sprite rig, the footpath graph, and how many gardeners a campaign shows.

export const IMG_W = 986;
export const IMG_H = 853;
export const GARDENERS = 12;
export const G_H = 38; // gardener height in island-image pixels
export const G_W = G_H * (53 / 67);
export const U = G_H / 67; // one sprite pixel, in island-image pixels
// sprite regions (in sprite pixels) for the simple walk rig
export const BODY = { x: 0, y: 0, w: 53, h: 58 };
export const LEG_L = { x: 16, y: 58, w: 12, h: 9 };
export const LEG_R = { x: 28, y: 58, w: 12, h: 9 };
export const STRIDE = 7; // island-image pixels per half step

// Footpaths on the island image as a graph: gardeners only ever walk along
// these edges, so they stay on the stepping stones and dirt paths.
export const NODES: [number, number][] = [
  [222, 352], [262, 360], [302, 346], [340, 332], [378, 322], // 0-4 greenhouse path
  [548, 300], [585, 312], [625, 356], [668, 378], [712, 390], // 5-9 terrace foot, pond bridge, gazebo path
  [745, 420], [790, 440], [835, 462], [870, 478], // 10-13 toward the shed
  [700, 456], [662, 505], [620, 535], [575, 545], [535, 560], // 14-18 stairs down, lower stones
  [505, 568], [470, 548], [440, 522], [410, 496], // 19-22 stream bridge, front meadow, meadow stairs
  [640, 590], [690, 605], [600, 598], // 23-25 lower right stones
  [460, 276], // 26 little bridge by the waterfall
  [190, 415], [240, 440], // 27-28 between the vegetable beds
  [725, 562], // 29 beside the pergola
  [637, 557], // 30 gap beside the bench
];
export const EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 26], [26, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10],
  [10, 11], [11, 12], [12, 13], [10, 14], [14, 15], [15, 16], [16, 17], [17, 18], [18, 19],
  [19, 20], [20, 21], [21, 22], [16, 30], [30, 23], [23, 24], [23, 25], [0, 27], [27, 28],
  [24, 29],
];
// the first two gardeners keep to the front meadow, where "nobody wants to
// go first" happens, so they are already there when that section arrives
export const MEADOW = new Set([15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 29, 30]);
export const NEIGHBOURS: number[][] = NODES.map((_, i) =>
  EDGES.flatMap(([a, b]) => (a === i ? [b] : b === i ? [a] : [])),
);

// How many gardeners are out: a couple at the start, a dozen at the goal.
// gardeners = 2 + round(10 × raised ÷ goal), capped at 12.
export const MIN_GARDENERS = 2;
export function gardenersFor(progress: number) {
  return Math.min(GARDENERS, MIN_GARDENERS + Math.round((GARDENERS - MIN_GARDENERS) * Math.min(Math.max(progress, 0), 1)));
}


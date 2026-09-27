import type { TileRecord } from "@/types";
import { nearRiver } from "./riverLayout";
import { regionWeights, sampleRegion } from "./regions";
import { canonicalTile, type Point, rotatePoint } from "./tileLayout";
import { hash01, vegetationSpots, worldSpot } from "./vegetation";

/** Enough to fill a big board without a crowd; each one is a single point. */
export const MAX_FIREFLIES = 160;

export interface Firefly {
  /** World position on the table, where the firefly hovers around. */
  at: Point;
  /** 0–1, so each drifts and blinks on its own rhythm. */
  phase: number;
}

// Where a riverbank firefly may start, in canonical tile space.
const BANK_CANDIDATES: Point[] = [
  [-0.3, -0.3],
  [0, -0.32],
  [0.3, -0.3],
  [-0.32, 0],
  [0.32, 0],
  [-0.3, 0.3],
  [0, 0.32],
  [0.3, 0.3],
  [-0.15, -0.15],
  [0.15, 0.15],
];

/**
 * Fireflies gather where it's green and damp: around meadow and forest plants
 * and along riverbanks, never over the water or out in the desert and fields.
 */
export function fireflySpots(records: TileRecord[], seed = 0): Firefly[] {
  const found: (Firefly & { order: number })[] = [];
  for (const { tile, position } of records) {
    const base = canonicalTile(tile);
    for (const spot of vegetationSpots(base)) {
      const [x, z] = worldSpot(position, tile.orientation, spot);
      const region = sampleRegion(regionWeights(x, z, seed), hash01(x, z, seed));
      if ((region === "meadow" || region === "forest") && hash01(x, z, seed + 23) < 0.5) {
        found.push({ at: [x, z], phase: hash01(x, z, seed + 29), order: hash01(x, z, seed + 31) });
      }
    }
    for (const point of BANK_CANDIDATES) {
      if (!nearRiver(base, point, 0.12) || nearRiver(base, point, 0.03)) continue;
      const [dx, dz] = rotatePoint(point, tile.orientation);
      const [x, z] = [position.x + dx, position.y + dz];
      found.push({ at: [x, z], phase: hash01(x, z, seed + 29), order: hash01(x, z, seed + 31) });
    }
  }
  // A stable shuffle keeps the cap spread across the whole board.
  return found
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_FIREFLIES)
    .map(({ at, phase }) => ({ at, phase }));
}

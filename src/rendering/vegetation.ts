import * as THREE from "three";
import type { ITile } from "@/interfaces/ITile";
import type { Position, TileRecord } from "@/types";
import { PaintBatch, place } from "./paint";
import { nearRiver, restaurantPosition, tileRoadPath } from "./riverLayout";
import { canonicalTile, CORNERS, insidePolygon, Point, positionKey, rotatePoint, zonePolygon } from "./tileLayout";
import { type Region, regionWeights, sampleRegion } from "./regions";
import { WIND_YAW } from "./wind";

export type SpotKind = "tree" | "shrub" | "sapling";

export interface VegetationSpot {
  kind: SpotKind;
  /** Canonical tile space. */
  at: Point;
  scale: number;
  /** Stable per tile type; used for alternating tints. */
  variant: number;
}

export type Species = "round" | "bush" | "pine" | "fern" | "hay" | "fence" | "cactus" | "rock" | "windpump";

const scenerySeed = (id: string) =>
  Array.from(id).reduce((seed, character) => (seed * 31 + character.charCodeAt(0)) >>> 0, 177);

/**
 * Where plants can grow on a canonical tile: one tree and shrub per open field
 * corner, sometimes a sapling. Spots avoid roads, lots, water and restaurants.
 */
export function vegetationSpots(base: ITile): VegetationSpot[] {
  const zones = base.costcoZones.map((_, i) => zonePolygon(base, i));
  const roads = base.roadConnections.flatMap((connection) => tileRoadPath(base, connection));
  const spots: VegetationSpot[] = [];
  const corners = [...new Set(base.fieldSegments.flatMap((segment) => segment.corners))];
  corners.forEach((corner, i) => {
    const [x, z] = CORNERS[corner];
    const variation = (scenerySeed(base.id) + i * 137) >>> 0;
    if (
      (i > 0 && variation % 5 === 0) ||
      nearRiver(base, [x, z], 0.1) ||
      (base.river &&
        base.hasMcDonalds &&
        Math.hypot(x - restaurantPosition(base)[0], z - restaurantPosition(base)[1]) < 0.28) ||
      zones.some((polygon) => insidePolygon([x, z], polygon)) ||
      roads.some(([rx, rz]) => Math.hypot(rx - x, rz - z) < 0.19)
    )
      return;
    const treeX = x + ((variation % 17) / 16 - 0.5) * 0.06;
    const treeZ = z + (((variation >>> 4) % 17) / 16 - 0.5) * 0.06;
    spots.push({ kind: "tree", at: [treeX, treeZ], scale: 1 + (variation % 4) * 0.11, variant: i });
    spots.push({ kind: "shrub", at: [x - 0.065, z + 0.027], scale: 1, variant: i });
    if (variation % 3 === 0) {
      const sapling: Point = [treeX - Math.sign(x) * 0.09, treeZ];
      if (
        !nearRiver(base, sapling, 0.06) &&
        !zones.some((polygon) => insidePolygon(sapling, polygon)) &&
        !roads.some(([rx, rz]) => Math.hypot(rx - sapling[0], rz - sapling[1]) < 0.15)
      ) {
        spots.push({ kind: "sapling", at: sapling, scale: 0.72, variant: 1 });
      }
    }
  });
  return spots;
}

const SPECIES: Record<Region, Record<SpotKind, Species>> = {
  meadow: { tree: "round", shrub: "bush", sapling: "round" },
  forest: { tree: "pine", shrub: "fern", sapling: "pine" },
  farmland: { tree: "hay", shrub: "fence", sapling: "hay" },
  desert: { tree: "cactus", shrub: "rock", sapling: "cactus" },
};

export const speciesFor = (region: Region, kind: SpotKind): Species => SPECIES[region][kind];

/** How far each species bends in the wind, in tile units at full gust; absent ones stand still. */
export const SWAY: Partial<Record<Species, number>> = { round: 0.016, pine: 0.009, bush: 0.03, fern: 0.03 };

/** Share of farmland and desert tree spots that get a windpump instead. */
export const WINDPUMP_SHARE = 0.1;
/** Where the windpump's wheel turns, in the tower's own space (+z faces the wind). */
export const WINDPUMP_HUB = new THREE.Vector3(0, 0.318, 0.022);

/** A farm windpump replaces some hay bales and cacti, never a plant in meadow or forest. */
export function isWindpumpSpot(region: Region, kind: SpotKind, x: number, z: number, seed = 0): boolean {
  return kind === "tree" && (region === "farmland" || region === "desert") && hash01(x, z, seed + 11) < WINDPUMP_SHARE;
}

/** Hash a world position to a stable pseudo-random number in [0, 1). */
export function hash01(x: number, z: number, salt = 0): number {
  let h = Math.imul(Math.round(x * 1000) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(z * 1000) + salt, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** A spot placed on the board: world position plus the tile it grows on. */
export function worldSpot(position: Position, orientation: number, spot: VegetationSpot): Point {
  const [x, z] = rotatePoint(spot.at, orientation);
  return [position.x + x, position.y + z];
}

/** Kinds of spot that are too small to see from far away. */
export const SMALL_SPECIES: ReadonlySet<Species> = new Set(["bush", "fern", "fence", "rock"]);

/**
 * Species geometry at the origin, painted with vertex colours. `coarse` keeps
 * the silhouette with fewer segments for zoomed-out boards.
 */
export function buildSpecies(species: Species, coarse = false): THREE.BufferGeometry {
  // Radial segments: full count, or the fewest that still read as round.
  const r = (segments: number) => (coarse ? Math.max(4, Math.ceil(segments / 2)) : segments);
  const batch = new PaintBatch();
  const add = (geometry: THREE.BufferGeometry, color: string, y: number, x = 0, z = 0, rotation?: THREE.Euler) =>
    batch.add(place(geometry, new THREE.Vector3(x, y, z), rotation), color);
  switch (species) {
    case "round":
      add(new THREE.CylinderGeometry(0.01, 0.015, 0.09, r(5)), "#826a4b", 0.043);
      add(new THREE.IcosahedronGeometry(0.055, coarse ? 0 : 1), "#65934d", 0.12);
      break;
    case "bush":
      add(new THREE.IcosahedronGeometry(0.035, 0), "#88a75a", 0.025);
      break;
    case "pine":
      add(new THREE.CylinderGeometry(0.008, 0.012, 0.06, r(5)), "#6f5238", 0.03);
      add(new THREE.ConeGeometry(0.06, 0.1, r(7)), "#2f5e3c", 0.1);
      add(new THREE.ConeGeometry(0.046, 0.085, r(7)), "#35684a", 0.16);
      add(new THREE.ConeGeometry(0.03, 0.065, r(7)), "#3b7050", 0.215);
      break;
    case "fern":
      add(new THREE.ConeGeometry(0.03, 0.04, r(5)), "#3f6b45", 0.02);
      break;
    case "hay":
      add(
        new THREE.CylinderGeometry(0.035, 0.035, 0.055, r(12)),
        "#d8b35e",
        0.035,
        0,
        0,
        new THREE.Euler(0, 0, Math.PI / 2),
      );
      add(
        new THREE.CylinderGeometry(0.03, 0.03, 0.057, r(12)),
        "#c79c48",
        0.035,
        0,
        0,
        new THREE.Euler(0, 0, Math.PI / 2),
      );
      break;
    case "fence":
      for (const x of [-0.035, 0.035]) add(new THREE.BoxGeometry(0.008, 0.045, 0.008), "#9b865a", 0.022, x);
      add(new THREE.BoxGeometry(0.08, 0.008, 0.007), "#af9d71", 0.03);
      add(new THREE.BoxGeometry(0.08, 0.008, 0.007), "#af9d71", 0.015);
      break;
    case "cactus":
      add(new THREE.CylinderGeometry(0.014, 0.016, 0.13, r(7)), "#5f8a4f", 0.065);
      add(new THREE.SphereGeometry(0.014, r(7), coarse ? 2 : 4, 0, Math.PI * 2, 0, Math.PI / 2), "#5f8a4f", 0.13);
      add(new THREE.CylinderGeometry(0.009, 0.009, 0.05, r(6)), "#5f8a4f", 0.085, 0.03);
      add(
        new THREE.CylinderGeometry(0.009, 0.009, 0.03, r(6)),
        "#5f8a4f",
        0.064,
        0.018,
        0,
        new THREE.Euler(0, 0, Math.PI / 2),
      );
      add(new THREE.CylinderGeometry(0.008, 0.008, 0.04, r(6)), "#5f8a4f", 0.07, -0.028);
      add(
        new THREE.CylinderGeometry(0.008, 0.008, 0.026, r(6)),
        "#5f8a4f",
        0.052,
        -0.016,
        0,
        new THREE.Euler(0, 0, Math.PI / 2),
      );
      break;
    case "rock":
      add(new THREE.DodecahedronGeometry(0.03, 0).scale(1.3, 0.7, 1), "#b86a44", 0.015);
      add(new THREE.DodecahedronGeometry(0.018, 0), "#c98457", 0.01, 0.035, 0.01);
      break;
    case "windpump":
      buildWindpumpTower(batch, coarse);
      break;
  }
  return batch.build()!;
}

const STEEL = "#a9aba5";
const STEEL_DARK = "#8d908a";

/** A thin strut from `a` to `b`, for the lattice tower. */
function strut(a: THREE.Vector3, b: THREE.Vector3, thickness: number): THREE.BufferGeometry {
  const direction = b.clone().sub(a);
  const geometry = new THREE.BoxGeometry(thickness, direction.length(), thickness);
  const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return geometry.applyMatrix4(
    new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), rotation, new THREE.Vector3(1, 1, 1)),
  );
}

/**
 * The classic American farm windpump without its wheel: a tapering lattice
 * tower, a gearbox with a tail vane pointing downwind, and a stock tank.
 */
function buildWindpumpTower(batch: PaintBatch, coarse: boolean): void {
  const top = WINDPUMP_HUB.y - 0.012;
  const corner = (y: number, sx: number, sz: number) => {
    const half = THREE.MathUtils.lerp(0.036, 0.011, y / top);
    return new THREE.Vector3(sx * half, y, sz * half);
  };
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (const [sx, sz] of corners) batch.add(strut(corner(0, sx, sz), corner(top, sx, sz), 0.006), STEEL);
  // Horizontal rings tie the legs together; the fine model adds diagonal braces.
  for (const y of coarse ? [0.1, 0.2] : [0.06, 0.13, 0.2, 0.26]) {
    corners.forEach(([sx, sz], i) => {
      const [nx, nz] = corners[(i + 1) % 4];
      batch.add(strut(corner(y, sx, sz), corner(y, nx, nz), 0.004), STEEL_DARK);
    });
  }
  if (!coarse) {
    corners.forEach(([sx, sz], i) => {
      const [nx, nz] = corners[(i + 1) % 4];
      batch.add(strut(corner(0.06, sx, sz), corner(0.13, nx, nz), 0.003), STEEL_DARK);
      batch.add(strut(corner(0.13, sx, sz), corner(0.2, nx, nz), 0.003), STEEL_DARK);
    });
  }
  const add = (geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number) =>
    batch.add(place(geometry, new THREE.Vector3(x, y, z)), color);
  add(new THREE.BoxGeometry(0.03, 0.006, 0.03), STEEL_DARK, 0, top, 0);
  add(new THREE.BoxGeometry(0.014, 0.016, 0.03), STEEL_DARK, 0, WINDPUMP_HUB.y, 0.004);
  // The tail boom and vane trail downwind, behind the wheel.
  add(new THREE.BoxGeometry(0.004, 0.004, 0.075), STEEL, 0, WINDPUMP_HUB.y, -0.045);
  add(new THREE.BoxGeometry(0.003, 0.03, 0.042), "#e8e1cb", 0, WINDPUMP_HUB.y + 0.004, -0.085);
  add(new THREE.BoxGeometry(0.0035, 0.008, 0.042), "#c64032", 0, WINDPUMP_HUB.y + 0.004, -0.085);
  // A round stock tank beside the tower's foot.
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.026, coarse ? 10 : 18), "#7f8781", 0.058, 0.013, 0.028);
  add(new THREE.CylinderGeometry(0.026, 0.026, 0.002, coarse ? 10 : 18), "#5c7f86", 0.058, 0.0265, 0.028);
}

/**
 * The windpump's wheel, centred on its hub and facing +z. It is its own mesh so
 * a shader can spin it about z without touching the tower.
 */
export function buildWindpumpWheel(coarse = false): THREE.BufferGeometry {
  const batch = new PaintBatch();
  // Painted well above the ground so the grounding shade leaves it alone.
  const lift = new THREE.Matrix4().makeTranslation(0, 1, 0);
  const blades = coarse ? 8 : 12;
  for (let i = 0; i < blades; i++) {
    const angle = (i / blades) * Math.PI * 2;
    const blade = new THREE.BoxGeometry(0.013, 0.048, 0.0015);
    // A slight twist, like the curved sails of a real windpump.
    blade.applyMatrix4(new THREE.Matrix4().makeRotationY(0.45));
    blade.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0.039, 0));
    blade.applyMatrix4(new THREE.Matrix4().makeRotationZ(angle));
    batch.add(blade.applyMatrix4(lift), "#d9d6cb");
  }
  batch.add(new THREE.TorusGeometry(0.062, 0.0018, 4, coarse ? 16 : 32).applyMatrix4(lift), STEEL_DARK);
  batch.add(new THREE.CylinderGeometry(0.008, 0.008, 0.012, 10).rotateX(Math.PI / 2).applyMatrix4(lift), STEEL_DARK);
  return batch.build()!.translate(0, -1, 0);
}

export interface PlantInstances {
  species: Species;
  matrices: THREE.Matrix4[];
  colors: THREE.Color[];
  /** The `positionKey` of the tile each plant grows on. */
  owners: string[];
}

// The alternate crown tint that meadow trees used before they were instanced.
const DARK_CROWN = new THREE.Color("#477d50");
const LIGHT_CROWN = new THREE.Color("#65934d");
const DARK_TINT = new THREE.Color(
  DARK_CROWN.r / LIGHT_CROWN.r,
  DARK_CROWN.g / LIGHT_CROWN.g,
  DARK_CROWN.b / LIGHT_CROWN.b,
);
const WHITE = new THREE.Color(1, 1, 1);

/** Group every plant on the board by species, with a world transform each. */
export function plantInstances(records: TileRecord[], seed?: number): PlantInstances[] {
  const groups = new Map<Species, PlantInstances>();
  for (const { tile, position } of records) {
    const base = canonicalTile(tile);
    for (const spot of vegetationSpots(base)) {
      const [x, z] = worldSpot(position, tile.orientation, spot);
      const region = sampleRegion(regionWeights(x, z, seed), hash01(x, z, seed ?? 0));
      const windpump = isWindpumpSpot(region, spot.kind, x, z, seed);
      const species = windpump ? "windpump" : speciesFor(region, spot.kind);
      const group = groups.get(species) ?? { species, matrices: [], colors: [], owners: [] };
      // Windpumps all turn their wheels into the wind; plants face any way.
      const yaw = windpump ? WIND_YAW : hash01(x, z, 1) * Math.PI * 2;
      const scale = windpump ? 1 : spot.scale;
      group.matrices.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(x, 0, z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
          new THREE.Vector3(scale, scale, scale),
        ),
      );
      group.colors.push(species === "round" && spot.kind === "tree" && spot.variant % 2 === 0 ? DARK_TINT : WHITE);
      group.owners.push(positionKey(position));
      groups.set(species, group);
    }
  }
  return [...groups.values()];
}

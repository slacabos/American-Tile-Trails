import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildDeck } from "@/tileLibrary";
import { buildWindpumpWheel, hash01, plantInstances, vegetationSpots, worldSpot } from "@/rendering/vegetation";
import { regionWeights, sampleRegion } from "@/rendering/regions";
import { WIND_DIRECTION, WIND_YAW } from "@/rendering/wind";

const road = buildDeck().find((tile) => tile.id === "straight-road")!;
const board = Array.from({ length: 13 * 13 }, (_, i) => ({
  tile: road,
  position: { x: (i % 13) - 6, y: Math.floor(i / 13) - 6 },
}));

describe("regional vegetation", () => {
  it("places every plant spot on the board exactly once", () => {
    const perTile = vegetationSpots(road).length;
    const total = plantInstances(board, 42).reduce((sum, group) => sum + group.matrices.length, 0);
    expect(total).toBe(perTile * board.length);
  });

  it("grows region-specific species across a large board", () => {
    const species = new Set(plantInstances(board, 42).map((group) => group.species));
    expect(species.size).toBeGreaterThanOrEqual(4);
  });

  it("keeps the opening tiles in meadow plants", () => {
    const home = board.filter(({ position }) => Math.abs(position.x) + Math.abs(position.y) <= 1);
    const species = new Set(plantInstances(home, 42).map((group) => group.species));
    expect([...species].every((kind) => kind === "round" || kind === "bush")).toBe(true);
  });
});

describe("plant owners", () => {
  it("records which tile each plant grows on", () => {
    const groups = plantInstances(board.slice(0, 3), 42);
    const owners = groups.flatMap((group) => group.owners);
    expect(new Set(owners)).toEqual(new Set(board.slice(0, 3).map(({ position }) => `${position.x},${position.y}`)));
    for (const group of groups) expect(group.owners).toHaveLength(group.matrices.length);
  });
});

describe("windpumps", () => {
  const windpumps = (seed: number) => plantInstances(board, seed).find((group) => group.species === "windpump");

  it("stand only where farmland or desert would grow a tree", () => {
    const towers = windpumps(42)!;
    expect(towers.matrices.length).toBeGreaterThan(0);
    const trees = board.flatMap(({ position, tile }) =>
      vegetationSpots(road)
        .filter((spot) => spot.kind === "tree")
        .map((spot) => worldSpot(position, tile.orientation, spot)),
    );
    for (const matrix of towers.matrices) {
      const at = new THREE.Vector3().setFromMatrixPosition(matrix);
      const spot = trees.find(([x, z]) => Math.hypot(x - at.x, z - at.z) < 1e-6);
      expect(spot).toBeDefined();
      const region = sampleRegion(regionWeights(at.x, at.z, 42), hash01(at.x, at.z, 42));
      expect(["farmland", "desert"]).toContain(region);
    }
  });

  it("are the same for the same seed and never crowd the fields", () => {
    const positions = (seed: number) =>
      windpumps(seed)!.matrices.map((matrix) => new THREE.Vector3().setFromMatrixPosition(matrix).toArray());
    expect(positions(42)).toEqual(positions(42));
    const plants = plantInstances(board, 42).reduce((sum, group) => sum + group.matrices.length, 0);
    expect(windpumps(42)!.matrices.length).toBeLessThan(plants * 0.1);
  });

  it("all turn their wheels into the wind", () => {
    const facing = new THREE.Vector3(0, 0, 1);
    const into = new THREE.Vector3(-WIND_DIRECTION.x, 0, -WIND_DIRECTION.y);
    for (const matrix of windpumps(42)!.matrices) {
      const rotation = new THREE.Quaternion();
      matrix.decompose(new THREE.Vector3(), rotation, new THREE.Vector3());
      expect(facing.clone().applyQuaternion(rotation).distanceTo(into)).toBeLessThan(1e-6);
    }
    expect(new THREE.Vector3(Math.sin(WIND_YAW), 0, Math.cos(WIND_YAW)).distanceTo(into)).toBeLessThan(1e-6);
  });

  it("paint the wheel without grounding shade, though it is built around its hub", () => {
    const colors = buildWindpumpWheel().getAttribute("color");
    const blade = new THREE.Color("#d9d6cb");
    const brightest = Math.max(...Array.from({ length: colors.count }, (_, i) => colors.getX(i)));
    expect(brightest).toBeCloseTo(blade.r);
  });
});

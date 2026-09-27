import * as THREE from "three";
import { buildRiverDeck, getRiverLake, getRiverSource } from "@/riverLibrary";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneryLibrary } from "@/rendering/scenery";
import { buildDeck, getStartTile } from "@/tileLibrary";
import { LANDMARK_RADIUS, LANDMARKS, landmarkConflict } from "@/rendering/landmarks";
import { warehouseLayout } from "@/rendering/warehouseLayout";

const tiles = [
  ...new Map(
    [getStartTile(), ...buildDeck(), getRiverSource(), ...buildRiverDeck(), getRiverLake()].map((tile) => [
      tile.id,
      tile,
    ]),
  ).values(),
];
beforeEach(() => {
  const ctx = document.createElement("canvas").getContext("2d")!;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(Object.assign(ctx, { setLineDash: () => {} }));
});
afterEach(() => vi.restoreAllMocks());

describe("procedural scenery resources", () => {
  it.each(tiles.map((tile) => [tile.id, tile] as const))(
    "builds finite geometry within the %s tile footprint",
    (_, tile) => {
      const library = new SceneryLibrary();
      const model = library.getGhost(tile);
      expect(model.parts.length).toBeGreaterThan(1);
      for (const part of model.parts) {
        const vertices = part.geometry.getAttribute("position");
        expect([...vertices.array].every(Number.isFinite)).toBe(true);
        part.geometry.computeBoundingBox();
        const bounds = part.geometry.boundingBox!;
        expect(bounds.min.x).toBeGreaterThanOrEqual(-0.501);
        expect(bounds.max.x).toBeLessThanOrEqual(0.501);
        expect(bounds.min.z).toBeGreaterThanOrEqual(-0.501);
        expect(bounds.max.z).toBeLessThanOrEqual(0.501);
        expect(bounds.max.y).toBeLessThan(0.4);
      }
      library.dispose();
    },
  );

  it("reuses canonical geometry across rotations and releases GPU resources", () => {
    const library = new SceneryLibrary();
    const tile = getStartTile();
    const model = library.get(tile);
    for (let turn = 1; turn < 4; turn++) expect(library.get(tile.rotate(turn))).toBe(model);
    const disposed = vi.fn();
    model.parts.forEach((part) => part.geometry.addEventListener("dispose", disposed));
    library.dispose();
    expect(disposed).toHaveBeenCalledTimes(model.parts.length);
  });
});

describe("landmarks", () => {
  it("rejects spots on a road or a follower spot", () => {
    const road = tiles.find((tile) => tile.id === "straight-road")!;
    expect(landmarkConflict(road, [0, 0], 0.05)).toBe("road");
    expect(landmarkConflict(road, [0.3, -0.3], 0.05)).toBe("follower field");
  });

  it.each(tiles.map((tile) => [tile.id, tile] as const))(
    "%s landmarks stay clear of roads, lots, water and follower spots",
    (_, tile) => {
      for (const landmark of LANDMARKS[tile.id] ?? []) {
        expect(
          landmarkConflict(tile, landmark.at, LANDMARK_RADIUS[landmark.kind]),
          `${landmark.kind} at ${landmark.at}`,
        ).toBeUndefined();
      }
    },
  );
});

describe("night lighting", () => {
  it("lights windows and lamps at night, including models built afterwards", () => {
    const library = new SceneryLibrary();
    const glowing = (tile: (typeof tiles)[number]) =>
      library
        .get(tile)
        .parts.map((part) => part.material as THREE.MeshStandardMaterial)
        .filter((material) => material.emissiveIntensity !== undefined && material.emissive?.getHex() !== 0);
    const mcdonalds = tiles.find((tile) => tile.id === "mcdonalds-abbey")!;
    expect(glowing(mcdonalds).every((material) => material.emissiveIntensity === 0)).toBe(true);
    library.setNight(true);
    expect(glowing(mcdonalds).length).toBeGreaterThan(0);
    expect(glowing(mcdonalds).every((material) => material.emissiveIntensity > 0)).toBe(true);
    const houses = tiles.find((tile) => tile.id === "road-end")!;
    expect(glowing(houses).every((material) => material.emissiveIntensity > 0)).toBe(true);
    library.setNight(false);
    expect(glowing(houses).every((material) => material.emissiveIntensity === 0)).toBe(true);
    library.dispose();
  });

  it("casts a pool of light under each lamppost only at night, without a shadow of its own", () => {
    const library = new SceneryLibrary();
    const pools = (id: string) =>
      library.get(tiles.find((tile) => tile.id === id)!).parts.filter((part) => part.glowOnly);
    const lampposts = (id: string) => (LANDMARKS[id] ?? []).filter((landmark) => landmark.kind === "lamp").length;
    const starter = pools("starter-proper");
    expect(starter).toHaveLength(1);
    // Two quads (four vertices each) for the starter tile's two lampposts.
    expect(starter[0].geometry.getAttribute("position").count).toBe(lampposts("starter-proper") * 4);
    expect(pools("mcdonalds-abbey")).toHaveLength(0);
    expect(starter[0].material.visible).toBe(false);
    library.setNight(true);
    expect(starter[0].material.visible).toBe(true);
    expect(pools("road-end")[0].material.visible).toBe(true);
    library.setNight(false);
    expect(starter[0].material.visible).toBe(false);
    library.dispose();
  });

  it("lights Costco windows and spills light in front of the entrance at night", () => {
    const library = new SceneryLibrary();
    const tile = tiles.find((candidate) => candidate.id === "costco-cap")!;
    const { parts } = library.createWarehouses(warehouseLayout([{ tile, position: { x: 0, y: 0 } }]));
    const glass = parts.find(
      (part) =>
        (part.material as THREE.MeshStandardMaterial).emissive?.getHex() !== undefined &&
        (part.material as THREE.MeshStandardMaterial).color.getHexString() === "254c58",
    )!;
    // Entrance glass plus at least one window per exterior wall.
    expect(glass.geometry.getAttribute("position").count / 24).toBeGreaterThan(4);
    const spill = parts.filter((part) => part.glowOnly);
    expect(spill).toHaveLength(1);
    expect(spill[0].material.visible).toBe(false);
    library.setNight(true);
    expect(spill[0].material.visible).toBe(true);
    expect((glass.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(0);
    library.dispose();
  });
});

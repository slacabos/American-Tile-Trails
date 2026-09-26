import { describe, expect, it } from "vitest";
import { buildDeck } from "@/tileLibrary";
import { buildRiverDeck } from "@/riverLibrary";
import { fireflySpots, MAX_FIREFLIES } from "@/rendering/fireflies";
import { nearRiver } from "@/rendering/riverLayout";
import { canonicalTile } from "@/rendering/tileLayout";

const road = buildDeck().find((tile) => tile.id === "straight-road")!;
const river = buildRiverDeck().find((tile) => tile.river && tile.river.kind !== "lake")!;
const grid = (size: number, tile = road) =>
  Array.from({ length: size * size }, (_, i) => ({
    tile,
    position: { x: (i % size) - Math.floor(size / 2), y: Math.floor(i / size) - Math.floor(size / 2) },
  }));

describe("fireflies", () => {
  it("gather around meadow plants near the start", () => {
    const flies = fireflySpots(grid(3), 42);
    expect(flies.length).toBeGreaterThan(0);
    for (const { phase } of flies) expect(phase).toBeGreaterThanOrEqual(0);
  });

  it("are the same for the same board and seed", () => {
    expect(fireflySpots(grid(5), 7)).toEqual(fireflySpots(grid(5), 7));
  });

  it("never outnumber the cap, however big the board", () => {
    expect(fireflySpots(grid(25), 42).length).toBeLessThanOrEqual(MAX_FIREFLIES);
  });

  it("hover along riverbanks but not over the water", () => {
    const base = canonicalTile(river);
    const flies = fireflySpots([{ tile: base, position: { x: 0, y: 0 } }], 3);
    expect(flies.some(({ at }) => nearRiver(base, at, 0.12))).toBe(true);
    for (const { at } of flies) expect(nearRiver(base, at, 0)).toBe(false);
  });
});

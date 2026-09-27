import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { TileModel } from "./scenery";
import { insidePolygon, Point, ROAD_WIDTH } from "./tileLayout";
import { WarehouseComplex, WarehouseWall, WAREHOUSE_ROOF_Y } from "./warehouseLayout";
import type { Position } from "@/types";

export interface WarehouseMaterials {
  wall: THREE.Material;
  roof: THREE.Material;
  trim: THREE.Material;
  fascia: THREE.Material;
  glass: THREE.Material;
  metal: THREE.Material;
  marking: THREE.Material;
  sign: THREE.Material;
  /** Light fanning out from the entrance at night; it must not cast a shadow. */
  spill: THREE.Material;
}

/** Spacing, width and height of the lit windows along exterior walls. */
const WINDOW_SPACING = 0.09;
const WINDOW_WIDTH = 0.045;
const WINDOW_HEIGHT = 0.014;
/** Size of the light cast on the lot by the entrance, along and away from the wall. */
const SPILL_WIDTH = 0.5;
const SPILL_DEPTH = 0.22;

function clampToTile(geometry: THREE.BufferGeometry, tile: Position): void {
  const vertices = geometry.getAttribute("position");
  for (let i = 0; i < vertices.count; i++) {
    vertices.setX(i, THREE.MathUtils.clamp(vertices.getX(i), tile.x - 0.5, tile.x + 0.5));
    vertices.setZ(i, THREE.MathUtils.clamp(vertices.getZ(i), tile.y - 0.5, tile.y + 0.5));
  }
  geometry.computeVertexNormals();
}

/** Batch the whole board's warehouses by material, without interior facades. */
export function buildWarehouses(complexes: WarehouseComplex[], materials: WarehouseMaterials): TileModel {
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
    const batch = batches.get(material) ?? [];
    batch.push(geometry);
    batches.set(material, batch);
  };
  const box = (
    point: Point,
    y: number,
    width: number,
    height: number,
    depth: number,
    material: THREE.Material,
    yaw = 0,
    tile?: Position,
  ) => {
    const geometry = new THREE.BoxGeometry(width, height, depth).rotateY(yaw).translate(point[0], y, point[1]);
    // Trim wall/curb ends at tile boundaries. Diagonal trim must not project
    // into a neighboring tile, and collinear fascia must still meet exactly.
    if (tile) clampToTile(geometry, tile);
    add(geometry, material);
  };
  const midpoint = (wall: WarehouseWall, offset = 0): Point => [
    (wall.a[0] + wall.b[0]) / 2 + wall.normal[0] * offset,
    (wall.a[1] + wall.b[1]) / 2 + wall.normal[1] * offset,
  ];
  const yaw = (wall: WarehouseWall) => -Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]);
  for (const complex of complexes) {
    for (const section of complex.sections) {
      const shape = new THREE.Shape(section.roof.map(([x, z]) => new THREE.Vector2(x, -z)));
      const roof = new THREE.ExtrudeGeometry(shape, { depth: 0.018, bevelEnabled: false, steps: 1 })
        .rotateX(-Math.PI / 2)
        .translate(0, WAREHOUSE_ROOF_Y - 0.018, 0);
      // World-aligned roof seams run continuously through adjoining tiles.
      const vertices = roof.getAttribute("position");
      const uv = roof.getAttribute("uv");
      for (let i = 0; i < vertices.count; i++) uv.setXY(i, vertices.getX(i), vertices.getZ(i));
      add(roof, materials.roof);
      for (const wall of section.walls) {
        box(midpoint(wall, -0.006), 0.076, wall.length, 0.152, 0.012, materials.wall, yaw(wall), section.position);
        box(midpoint(wall, -0.007), 0.132, wall.length, 0.024, 0.014, materials.fascia, yaw(wall), section.position);
        box(midpoint(wall, -0.007), 0.174, wall.length, 0.013, 0.014, materials.trim, yaw(wall), section.position);
        // A clerestory band of windows, lit from inside after dark.
        const windows = Math.floor(wall.length / WINDOW_SPACING);
        for (let i = 0; i < windows; i++) {
          const t = (i + 0.5) / windows;
          const point: Point = [
            wall.a[0] + (wall.b[0] - wall.a[0]) * t + wall.normal[0] * 0.001,
            wall.a[1] + (wall.b[1] - wall.a[1]) * t + wall.normal[1] * 0.001,
          ];
          box(point, 0.106, WINDOW_WIDTH, WINDOW_HEIGHT, 0.004, materials.glass, yaw(wall), section.position);
        }
        // Stalls follow the exterior of the complex, with room for the driveway.
        const count = Math.floor(wall.length / 0.065);
        for (let i = 1; i < count; i++) {
          const t = i / count;
          const point: Point = [
            wall.a[0] + (wall.b[0] - wall.a[0]) * t + wall.normal[0] * 0.044,
            wall.a[1] + (wall.b[1] - wall.a[1]) * t + wall.normal[1] * 0.044,
          ];
          const outside: Point = [point[0] + wall.normal[0] * 0.03, point[1] + wall.normal[1] * 0.03];
          if (
            !insidePolygon(outside, section.paving) ||
            section.roads.some(([x, z]) => Math.hypot(point[0] - x, point[1] - z) < ROAD_WIDTH / 2 + 0.04)
          )
            continue;
          box(point, 0.003, 0.003, 0.002, 0.06, materials.marking, yaw(wall), section.position);
        }
      }
      for (const curb of section.curbs) {
        const steps = Math.ceil(curb.length / 0.02);
        const point = (t: number): Point => [
          curb.a[0] + (curb.b[0] - curb.a[0]) * t,
          curb.a[1] + (curb.b[1] - curb.a[1]) * t,
        ];
        let start: number | undefined;
        for (let i = 0; i <= steps; i++) {
          const p = point((i + 0.5) / steps);
          const clear =
            i < steps && !section.roads.some(([x, z]) => Math.hypot(p[0] - x, p[1] - z) < ROAD_WIDTH / 2 + 0.02);
          if (clear && start === undefined) start = i;
          if (!clear && start !== undefined) {
            const span = { ...curb, a: point(start / steps), b: point(i / steps) };
            box(
              midpoint(span, -0.005),
              0.006,
              (curb.length * (i - start)) / steps,
              0.012,
              0.01,
              materials.trim,
              yaw(curb),
              section.position,
            );
            start = undefined;
          }
        }
      }
      const center: Point = [
        section.roof.reduce((sum, p) => sum + p[0], 0) / section.roof.length,
        section.roof.reduce((sum, p) => sum + p[1], 0) / section.roof.length,
      ];
      const signPoint = midpoint(complex.entrance, -0.08);
      if (Math.hypot(center[0] - signPoint[0], center[1] - signPoint[1]) > 0.16) {
        box(center, 0.19, 0.06, 0.04, 0.045, materials.metal);
        box([center[0] + 0.005, center[1]], 0.212, 0.041, 0.006, 0.031, materials.trim);
      }
    }
    const entrance = complex.entrance;
    const angle = yaw(entrance);
    const width = Math.min(0.22, entrance.length * 0.65);
    box(midpoint(entrance, 0.004), 0.06, width, 0.088, 0.013, materials.glass, angle);
    box(midpoint(entrance, 0.012), 0.06, 0.004, 0.092, 0.015, materials.trim, angle);
    box(midpoint(entrance, 0.018), 0.112, width + 0.025, 0.012, 0.06, materials.fascia, angle);
    const sign = midpoint(entrance, -0.075);
    add(
      new THREE.PlaneGeometry(Math.min(0.31, entrance.length * 0.8), 0.08)
        .rotateX(-Math.PI / 2)
        .rotateY(angle + Math.PI)
        .translate(sign[0], 0.182, sign[1]),
      materials.sign,
    );
    // Light from the doors fans out across the lot: v runs from the doors outwards.
    const along: Point = [
      (entrance.b[0] - entrance.a[0]) / entrance.length,
      (entrance.b[1] - entrance.a[1]) / entrance.length,
    ];
    const door = midpoint(entrance, 0.002);
    const corner = (u: number, v: number) => [
      door[0] + along[0] * (u - 0.5) * SPILL_WIDTH + entrance.normal[0] * v * SPILL_DEPTH,
      0.005,
      door[1] + along[1] * (u - 0.5) * SPILL_WIDTH + entrance.normal[1] * v * SPILL_DEPTH,
    ];
    const spill = new THREE.BufferGeometry();
    spill.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([...corner(0, 0), ...corner(1, 0), ...corner(1, 1), ...corner(0, 1)], 3),
    );
    spill.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    spill.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    spill.setIndex([0, 1, 2, 0, 2, 3]);
    const front = complex.sections.find((section) => section.walls.includes(entrance));
    if (front) clampToTile(spill, front.position);
    add(spill, materials.spill);
    if (complex.loadingBay) {
      const dock = complex.loadingBay;
      box(midpoint(dock, 0.003), 0.053, 0.13, 0.09, 0.012, materials.metal, yaw(dock));
      for (const y of [0.025, 0.043, 0.061, 0.079])
        box(midpoint(dock, 0.01), y, 0.12, 0.003, 0.005, materials.trim, yaw(dock));
    }
  }
  const parts: TileModel["parts"] = [];
  for (const [material, sources] of batches) {
    const geometry = mergeGeometries(sources);
    sources.forEach((source) => source.dispose());
    if (geometry) parts.push({ geometry, material, glowOnly: material === materials.spill });
  }
  return { parts };
}

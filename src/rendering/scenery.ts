import { hasRiverBridge, paintRiver, paintWaterDepth, restaurantPosition, tileRoadPath } from "./riverLayout";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ITile } from "@/interfaces/ITile";
import { buildWarehouses } from "./warehouseGeometry";
import { createWaterUniforms, makeRegional } from "./groundShader";
import { GLOW_COLOR, PaintBatch, place, type PropBuilder } from "./paint";
import { buildLandmark, LANDMARK_RADIUS, LANDMARKS } from "./landmarks";
import { buildSpecies, buildWindpumpWheel, type Species, speciesFor, SWAY, vegetationSpots } from "./vegetation";
import { makeSpinning, makeSwaying } from "./wind";
import { isFine, LodTracker } from "./lod";

/** Windows, lamps and warehouse glass after dark: bright enough to read as lit. */
const NIGHT_GLOW = 2;
/** How strongly a lamppost's pool of light warms the ground at night. */
const LAMP_POOL_OPACITY = 0.85;
/** Diameter of a lamppost's pool of light, in tile units. */
const LAMP_POOL_SIZE = 0.34;
import { WarehouseComplex, warehouseLayout } from "./warehouseLayout";
import { canonicalTile, insidePolygon, Point, ROAD_WIDTH, sceneryKey, zonePolygon } from "./tileLayout";

interface BuildingLayout {
  x: number;
  z: number;
  yaw?: number;
  width?: number;
  depth?: number;
}
const scenerySeed = (id: string) =>
  Array.from(id).reduce((seed, character) => (seed * 31 + character.charCodeAt(0)) >>> 0, 177);
const PENNANTS: Record<string, Point> = {
  "costco-road": [0.26, -0.2],
  "costco-complex-l": [0.17, -0.05],
  "costco-mega-complex": [0.11, -0.09],
};

// These fields are separate in the rules even where no road divides the grass.
const FIELD_FENCES: Record<string, [Point, Point][]> = {
  "costco-separate-dual": [
    [
      [-0.49, 0],
      [0.49, 0],
    ],
  ],
  "costco-peninsula": [
    [
      [0, -0.49],
      [0, 0.49],
    ],
  ],
  "costco-corner": [
    [
      [-0.49, 0],
      [0, 0],
    ],
  ],
};

export interface SceneryPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Thin props that are hidden when zoomed out. */
  fine?: boolean;
  /** Light cast on the ground, which must not cast a shadow of its own. */
  glowOnly?: boolean;
}
export interface TileModel {
  parts: SceneryPart[];
}

/** A canvas-scoped resource owner: models are shared by every instance and disposed together. */
export class SceneryLibrary {
  private models = new Map<string, TileModel>();
  private materials = new Map<string, THREE.Material>();
  private textures = new Set<THREE.Texture>();
  private ghosts = new Map<string, TileModel>();
  private ghostGeometry = new Set<THREE.BufferGeometry>();
  /** Zoom tier shared by every mesh on this canvas. */
  readonly lod = new LodTracker();
  /** Animated-water switches and clock, shared by every ground material. */
  readonly water = createWaterUniforms();

  /** Board geometry is owned by its component; shared materials live here. */
  createWarehouses(layout: WarehouseComplex[]): TileModel {
    let roof = this.materials.get("warehouse-roof");
    if (!roof) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#9caeaf";
      ctx.fillRect(0, 0, 256, 256);
      for (let x = 0; x < 256; x += 16) {
        ctx.fillStyle = "#82999b";
        ctx.fillRect(x, 0, 1, 256);
        ctx.fillStyle = "#b9c7c6";
        ctx.fillRect(x + 1, 0, 1, 256);
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = 4;
      this.textures.add(texture);
      roof = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85 });
      this.materials.set("warehouse-roof", roof);
    }
    return buildWarehouses(layout, {
      roof,
      wall: this.material("#e4ddca"),
      trim: this.material("#d9d4be"),
      fascia: this.material("#c5493f"),
      glass: this.warehouseGlass(),
      metal: this.material("#667b7e"),
      marking: this.material("#eef0dd"),
      sign: this.label("costco"),
    });
  }

  private warehouseGlass(): THREE.Material {
    let material = this.materials.get("warehouse-glass");
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: "#254c58",
        roughness: 0.6,
        emissive: GLOW_COLOR,
        emissiveIntensity: this.night ? NIGHT_GLOW : 0,
      });
      this.materials.set("warehouse-glass", material);
    }
    return material;
  }

  private species = new Map<string, THREE.BufferGeometry>();

  /** Shared geometry for one plant species, drawn with the paint material. */
  getSpecies(kind: Species, coarse = false): THREE.BufferGeometry {
    const key = `${kind}${coarse ? "-coarse" : ""}`;
    let geometry = this.species.get(key);
    if (!geometry) {
      geometry = buildSpecies(kind, coarse);
      this.species.set(key, geometry);
    }
    return geometry;
  }

  /** The windpump wheel, drawn apart from its tower so it can spin. */
  getWindpumpWheel(coarse = false): THREE.BufferGeometry {
    const key = `windpump-wheel${coarse ? "-coarse" : ""}`;
    let geometry = this.species.get(key);
    if (!geometry) {
      geometry = buildWindpumpWheel(coarse);
      this.species.set(key, geometry);
    }
    return geometry;
  }

  /**
   * How a species is drawn: bending in the wind if it sways, otherwise with the
   * shared paint. The depth material keeps its shadow bending along with it.
   */
  plantMaterials(species: Species): { material: THREE.Material; depth?: THREE.Material } {
    const amplitude = SWAY[species];
    if (!amplitude) return { material: this.paintMaterial() };
    return this.windMaterials(`sway-${amplitude}`, (material) => makeSwaying(material, this.water, amplitude));
  }

  /** The windpump wheel's material and shadow, turning in the wind. */
  wheelMaterials(): { material: THREE.Material; depth: THREE.Material } {
    return this.windMaterials("wheel", (material) => makeSpinning(material, this.water));
  }

  private windMaterials(
    key: string,
    patch: (material: THREE.Material) => void,
  ): { material: THREE.Material; depth: THREE.Material } {
    let material = this.materials.get(key);
    let depth = this.materials.get(`${key}-depth`);
    if (!material || !depth) {
      material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.87 });
      depth = new THREE.MeshDepthMaterial();
      patch(material);
      patch(depth);
      this.materials.set(key, material);
      this.materials.set(`${key}-depth`, depth);
    }
    return { material, depth };
  }

  /** A prospective tile shows a complete standalone section before placement. */
  getGhost(tile: ITile): TileModel {
    const key = sceneryKey(tile);
    const cached = this.ghosts.get(key);
    if (cached) return cached;
    const base = canonicalTile(tile);
    const warehouse = this.createWarehouses(warehouseLayout([{ tile: base, position: { x: 0, y: 0 } }]));
    warehouse.parts.forEach((part) => this.ghostGeometry.add(part.geometry));
    // The ghost has no region yet, so it previews meadow plants.
    const plants = new PaintBatch();
    for (const spot of vegetationSpots(base)) {
      const geometry = this.getSpecies(speciesFor("meadow", spot.kind)).clone();
      plants.add(place(geometry, new THREE.Vector3(spot.at[0], 0, spot.at[1]), undefined, spot.scale));
    }
    const plantGeometry = plants.build();
    const vegetation = plantGeometry ? [{ geometry: plantGeometry, material: this.paintMaterial() }] : [];
    vegetation.forEach((part) => this.ghostGeometry.add(part.geometry));
    const model = { parts: [...this.get(tile).parts, ...warehouse.parts, ...vegetation] };
    this.ghosts.set(key, model);
    return model;
  }

  private material(color: string): THREE.Material {
    let material = this.materials.get(color);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, roughness: 0.87 });
      this.materials.set(color, material);
    }
    return material;
  }

  /** One vertex-coloured material shared by every painted prop. */
  paintMaterial(): THREE.Material {
    let material = this.materials.get("paint");
    if (!material) {
      material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.87 });
      this.materials.set("paint", material);
    }
    return material;
  }

  /** Painted windows and lamps that light up at night. */
  private glowMaterial(): THREE.MeshStandardMaterial {
    let material = this.materials.get("glow") as THREE.MeshStandardMaterial | undefined;
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.6,
        emissive: GLOW_COLOR,
        emissiveIntensity: this.night ? NIGHT_GLOW : 0,
      });
      this.materials.set("glow", material);
    }
    return material;
  }

  /**
   * A soft warm disc under each lamppost, added onto the ground at night. It
   * stands in for a real light, which would cost every fragment on the board.
   */
  private lampPoolMaterial(): THREE.MeshBasicMaterial {
    let material = this.materials.get("lamp-pool") as THREE.MeshBasicMaterial | undefined;
    if (!material) {
      const size = 64;
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const r = Math.min(1, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2));
          const i = (y * size + x) * 4;
          data.set([255, 255, 255, Math.round(255 * (1 - r) ** 1.6)], i);
        }
      }
      const texture = new THREE.DataTexture(data, size, size);
      texture.needsUpdate = true;
      this.textures.add(texture);
      material = new THREE.MeshBasicMaterial({
        map: texture,
        color: GLOW_COLOR,
        transparent: true,
        opacity: LAMP_POOL_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        visible: this.night,
      });
      this.materials.set("lamp-pool", material);
    }
    return material;
  }

  private night = false;

  /** Windows, lamps and warehouse glass glow after dark, and lampposts light the ground. */
  setNight(night: boolean): void {
    this.night = night;
    this.water.waterNight.value = night ? 1 : 0;
    for (const key of ["glow", "warehouse-glass"]) {
      const material = this.materials.get(key) as THREE.MeshStandardMaterial | undefined;
      if (material) material.emissiveIntensity = night ? NIGHT_GLOW : 0;
    }
    const pool = this.materials.get("lamp-pool");
    if (pool) pool.visible = night;
  }

  /** Animated water is an optional extra; off, rivers keep their painted look. */
  setExtraVfx(enabled: boolean): void {
    this.water.waterOn.value = enabled ? 1 : 0;
  }

  private label(kind: "costco" | "mcdonalds"): THREE.Material {
    const key = `label-${kind}`;
    const cached = this.materials.get(key);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 160;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = kind === "costco" ? "#f6f1e6" : "#bd302a";
    ctx.fillRect(0, 0, 512, 160);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "italic 900 99px Arial, sans-serif";
    ctx.fillStyle = kind === "costco" ? "#cb3438" : "#ffd461";
    ctx.fillText(kind === "costco" ? "COSTCO" : "McDonald's", 256, 66, 474);
    if (kind === "costco") {
      ctx.fillStyle = "#34728b";
      ctx.font = "bold 28px Arial, sans-serif";
      ctx.fillText("WHOLESALE", 286, 131);
      ctx.fillRect(28, 117, 79, 5);
      ctx.fillRect(28, 128, 70, 5);
      ctx.fillRect(28, 139, 61, 5);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.add(texture);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      toneMapped: false,
    });
    this.materials.set(key, material);
    return material;
  }

  /** Get a shared canonical model, building its geometry and textures on first use. */
  get(tile: ITile): TileModel {
    const key = sceneryKey(tile);
    const cached = this.models.get(key);
    if (cached) return cached;
    const base = canonicalTile(tile);
    const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const paint = new PaintBatch();
    const glow = new PaintBatch();
    const finePaint = new PaintBatch();
    const fineGlow = new PaintBatch();
    // Textured or special materials (ground, labels, bridge deck) keep their own batch.
    const add = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      position: THREE.Vector3,
      rotation = new THREE.Euler(),
    ) => {
      place(geometry, position, rotation);
      const list = batches.get(material) ?? [];
      list.push(geometry);
      batches.set(material, list);
    };
    const shape = (
      geometry: THREE.BufferGeometry,
      color: string,
      position: THREE.Vector3,
      rotation = new THREE.Euler(),
      lit = false,
    ) => {
      const fine = isFine(geometry);
      (lit ? (fine ? fineGlow : glow) : fine ? finePaint : paint).add(place(geometry, position, rotation), color);
    };
    const box = (
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      color: string,
      yaw = 0,
      lit = false,
    ) => shape(new THREE.BoxGeometry(w, h, d), color, new THREE.Vector3(x, y, z), new THREE.Euler(0, yaw, 0), lit);
    const props: PropBuilder = { box, shape };
    (LANDMARKS[base.id] ?? []).forEach((landmark) => buildLandmark(props, landmark));

    box(0, -0.047, 0, 0.994, 0.084, 0.994, "#ad9171");
    box(0, -0.012, 0, 0.998, 0.012, 0.998, "#d1c6a0");
    const groundTextures = this.ground(base);
    const groundMaterial = new THREE.MeshStandardMaterial({
      map: groundTextures.map,
      roughness: 1,
    });
    makeRegional(
      groundMaterial,
      groundTextures.mask,
      groundTextures.water && { depth: groundTextures.water, uniforms: this.water },
    );
    this.materials.set(`ground-${key}`, groundMaterial);
    add(new THREE.PlaneGeometry(1, 1), groundMaterial, new THREE.Vector3(0, 0, 0), new THREE.Euler(-Math.PI / 2, 0, 0));

    const building = (layout: BuildingLayout) => {
      const { x, z, yaw = 0, width = 0.36, depth = 0.23 } = layout;
      const height = 0.105;
      const local = (lx: number, ly: number, lz: number) =>
        new THREE.Vector3(x + lx * Math.cos(yaw) + lz * Math.sin(yaw), ly, z - lx * Math.sin(yaw) + lz * Math.cos(yaw));
      const block = (
        lx: number,
        ly: number,
        lz: number,
        w: number,
        h: number,
        d: number,
        color: string,
        lit = false,
      ) => {
        const p = local(lx, ly, lz);
        box(p.x, p.y, p.z, w, h, d, color, yaw, lit);
      };
      block(0, 0.008, 0, width + 0.025, 0.016, depth + 0.025, "#d9d4be");
      block(0, height / 2 + 0.016, 0, width, height, depth, "#e9d6b7");
      block(0, height + 0.022, 0, width + 0.018, 0.018, depth + 0.018, "#c64032");
      block(0, height * 0.62, depth / 2 + 0.003, width * 0.94, 0.025, 0.008, "#bf3d32");
      for (const sign of [-1, 1]) {
        block(
          sign * width * 0.27,
          height * 0.27,
          depth / 2 + 0.006,
          width * 0.24,
          height * 0.37,
          0.008,
          "#466b73",
          true,
        );
      }
      block(0, height * 0.25, depth / 2 + 0.009, width * 0.16, height * 0.41, 0.011, "#254c58", true);
      // Roof lettering remains legible from the fixed tabletop camera.
      add(
        new THREE.PlaneGeometry(width * 0.9, depth * 0.62),
        this.label("mcdonalds"),
        local(0, height + 0.032, 0),
        new THREE.Euler(-Math.PI / 2, 0, yaw),
      );
      block(-width * 0.27, height + 0.05, -depth * 0.27, 0.043, 0.035, 0.036, "#8e9a97");
    };
    if (base.hasMcDonalds) {
      const [rx, rz] = restaurantPosition(base);
      building({ x: rx, z: rz, ...(base.river ? { width: 0.28, depth: 0.17 } : {}) });
      const signZ = base.id === "river-lake" ? 0.04 : -0.33;
      box(0.3, 0.14, base.river ? signZ : -0.27, 0.016, 0.28, 0.016, "#e4d8b7");
      box(0.3, 0.24, base.river ? signZ : -0.27, 0.14, 0.075, 0.025, "#bf3a2e");
      for (const x of [0.271, 0.329]) {
        const arc = new THREE.EllipseCurve(x, 0.262, 0.029, 0.063, 0, Math.PI, false, 0).getPoints(12);
        for (let i = 1; i < arc.length; i++) {
          const a = arc[i - 1],
            b = arc[i];
          const geometry = new THREE.BoxGeometry(0.01, a.distanceTo(b) + 0.003, 0.01);
          shape(
            geometry,
            "#ffd35b",
            new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, base.river ? signZ + 0.02 : -0.25),
            new THREE.Euler(0, 0, -Math.atan2(b.x - a.x, b.y - a.y)),
          );
        }
      }
    }

    // Bonus pennants become gold roadside markers; the gas-station tile also gets a canopy.
    base.costcoZones.forEach((zone) => {
      if (!zone.hasPennant) return;
      const [x, z] = PENNANTS[base.id] ?? [0.11, -0.03];
      box(x, 0.23, z, 0.008, 0.14, 0.008, "#b89a51");
      box(x + 0.03, 0.28, z, 0.065, 0.044, 0.009, "#ffd15c");
    });
    if (base.id === "costco-road") {
      box(-0.08, 0.09, 0.02, 0.2, 0.019, 0.105, "#ce4a38");
      for (const x of [-0.15, -0.01]) {
        box(x, 0.045, 0.02, 0.009, 0.09, 0.009, "#eee0bf");
        box(x, 0.025, 0.02, 0.03, 0.043, 0.03, "#3d656a");
      }
    }

    const zones = base.costcoZones.map((_, i) => zonePolygon(base, i));
    const roads = base.roadConnections.flatMap((connection) => tileRoadPath(base, connection));
    (FIELD_FENCES[base.id] ?? []).forEach(([a, b]) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.ceil(length / 0.065);
      const yaw = -Math.atan2(b[1] - a[1], b[0] - a[0]);
      for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) / steps;
        const x = a[0] + (b[0] - a[0]) * t,
          z = a[1] + (b[1] - a[1]) * t;
        if (
          zones.some((polygon) => insidePolygon([x, z], polygon)) ||
          roads.some(([rx, rz]) => Math.hypot(rx - x, rz - z) < 0.13)
        )
          continue;
        box(x, 0.022, z, 0.009, 0.045, 0.009, "#9b865a");
        box(x, 0.03, z, length / steps, 0.009, 0.008, "#af9d71", yaw);
      }
    });
    if (hasRiverBridge(base)) {
      const horizontal = base.id === "river-road-bridge";
      const halfLength = horizontal ? 0.36 : 0.3;
      const heightAt = (t: number) => 0.012 + 0.065 * Math.sin(Math.PI * t);
      const vertices: number[] = [];
      const indices: number[] = [];
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const along = -halfLength + t * 2 * halfLength;
        for (const side of [-1, 1])
          vertices.push(
            horizontal ? along : (side * ROAD_WIDTH) / 2,
            heightAt(t),
            horizontal ? (side * ROAD_WIDTH) / 2 : along,
          );
        if (i < 16) {
          const k = i * 2;
          indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
        }
        if (i < 16) {
          const next = -halfLength + ((i + 1) / 16) * 2 * halfLength;
          for (const side of [-1, 1]) {
            const rail = ROAD_WIDTH / 2 + 0.012;
            box(
              horizontal ? (along + next) / 2 : side * rail,
              heightAt((i + 0.5) / 16) + 0.035,
              horizontal ? side * rail : (along + next) / 2,
              horizontal ? next - along + 0.002 : 0.012,
              0.027,
              horizontal ? 0.012 : next - along + 0.002,
              "#d8d5bd",
            );
          }
          if (i % 3 === 0)
            box(
              horizontal ? along : 0,
              heightAt(t) + 0.002,
              horizontal ? 0 : along,
              horizontal ? 0.035 : 0.004,
              0.004,
              horizontal ? 0.004 : 0.035,
              "#f2d786",
            );
        }
      }
      const deck = new THREE.BufferGeometry();
      deck.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
      deck.setAttribute("uv", new THREE.Float32BufferAttribute(new Array((vertices.length / 3) * 2).fill(0), 2));
      deck.setIndex(indices);
      deck.computeVertexNormals();
      // The ribbon's winding depends on the road axis.
      let material = this.materials.get("bridge-deck");
      if (!material) {
        material = new THREE.MeshStandardMaterial({ color: "#626c69", roughness: 0.87, side: THREE.DoubleSide });
        this.materials.set("bridge-deck", material);
      }
      add(deck, material, new THREE.Vector3());
    }

    const parts: SceneryPart[] = [];
    for (const [material, geometries] of batches) {
      const geometry = mergeGeometries(geometries);
      geometries.forEach((source) => source.dispose());
      if (geometry) parts.push({ geometry, material });
    }
    const painted = paint.build();
    if (painted) parts.push({ geometry: painted, material: this.paintMaterial() });
    const lit = glow.build();
    if (lit) parts.push({ geometry: lit, material: this.glowMaterial() });
    const lamps = (LANDMARKS[base.id] ?? []).filter((landmark) => landmark.kind === "lamp");
    if (lamps.length > 0) {
      const pools = mergeGeometries(
        lamps.map(({ at: [x, z] }) =>
          place(
            new THREE.PlaneGeometry(LAMP_POOL_SIZE, LAMP_POOL_SIZE),
            new THREE.Vector3(x, 0.003, z),
            new THREE.Euler(-Math.PI / 2, 0, 0),
          ),
        ),
      );
      if (pools) parts.push({ geometry: pools, material: this.lampPoolMaterial(), glowOnly: true });
    }
    const finePainted = finePaint.build();
    if (finePainted) parts.push({ geometry: finePainted, material: this.paintMaterial(), fine: true });
    const fineLit = fineGlow.build();
    if (fineLit) parts.push({ geometry: fineLit, material: this.glowMaterial(), fine: true });
    const model = { parts };
    this.models.set(key, model);
    return model;
  }

  private ground(tile: ITile): { map: THREE.Texture; mask: THREE.Texture; water?: THREE.Texture } {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#83a365";
    ctx.fillRect(0, 0, 512, 512);
    // Deterministic, fine-grained grass texture; no runtime random scenery changes.
    let seed = scenerySeed(tile.id);
    for (let i = 0; i < 2400; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const x = seed % 512;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const y = seed % 512;
      ctx.fillStyle = i % 2 ? "#819e642c" : "#bfcb902c";
      ctx.fillRect(x, y, 2, 2);
    }
    // Soft meadow patches vary by tile type, fading before the matching edges.
    for (let i = 0; i < 18; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const x = 80 + (seed % 352);
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const y = 80 + (seed % 352);
      for (let radius = 64; radius >= 16; radius -= 16) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = i % 2 ? "#547b4707" : "#c1c98107";
        ctx.fill();
      }
    }
    paintFeatures(ctx, tile, 512);
    paintContactShadows(ctx, tile, 512);
    // White where regional landscapes may recolour the ground; black under
    // roads, lots, water and painted markings, which keep their colours.
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = maskCanvas.height = 256;
    const maskCtx = maskCanvas.getContext("2d")!;
    maskCtx.fillStyle = "#ffffff";
    maskCtx.fillRect(0, 0, 256, 256);
    maskCtx.fillStyle = maskCtx.strokeStyle = "#000000";
    paintFeatures(inkOnly(maskCtx), tile, 256);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const mask = new THREE.CanvasTexture(maskCanvas);
    this.textures.add(texture);
    this.textures.add(mask);
    if (!tile.river) return { map: texture, mask };
    const waterCanvas = document.createElement("canvas");
    waterCanvas.width = waterCanvas.height = 256;
    const waterCtx = waterCanvas.getContext("2d")!;
    waterCtx.fillStyle = "#000000";
    waterCtx.fillRect(0, 0, 256, 256);
    waterCtx.translate(128, 128);
    waterCtx.scale(256, 256);
    paintWaterDepth(waterCtx, tile);
    const water = new THREE.CanvasTexture(waterCanvas);
    this.textures.add(water);
    return { map: texture, mask, water };
  }

  /** Release the canvas's geometry, materials, and textures on unmount. */
  dispose(): void {
    this.ghostGeometry.forEach((geometry) => geometry.dispose());
    this.species.forEach((geometry) => geometry.dispose());
    this.models.forEach((model) => model.parts.forEach((part) => part.geometry.dispose()));
    this.materials.forEach((material) => material.dispose());
    this.textures.forEach((texture) => texture.dispose());
  }
}

/** Roads, lots, markings and water, in tile units centred on the canvas. */
/**
 * Soft shade on the ground under every plant and landmark, painted once per tile
 * type. Stacked translucent discs darken towards the centre, like the meadow
 * patches, so it costs nothing at runtime.
 */
function paintContactShadows(ctx: CanvasRenderingContext2D, tile: ITile, size: number): void {
  const blob = ([x, z]: Point, radius: number) => {
    ctx.fillStyle = "#26341e12";
    for (let step = 5; step >= 1; step--) {
      ctx.beginPath();
      ctx.arc((x + 0.5) * size, (z + 0.5) * size, (radius * size * step) / 5, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  for (const spot of vegetationSpots(tile)) blob(spot.at, (spot.kind === "shrub" ? 0.04 : 0.062) * spot.scale);
  for (const landmark of LANDMARKS[tile.id] ?? []) blob(landmark.at, LANDMARK_RADIUS[landmark.kind] * 1.15);
}

function paintFeatures(ctx: CanvasRenderingContext2D, tile: ITile, size: number): void {
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.scale(size, size);
  const path = (points: Point[], close = false) => {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (close) ctx.closePath();
  };
  const roads = tile.roadConnections.map((connection) => tileRoadPath(tile, connection));
  const zones = tile.costcoZones.map((_, index) => zonePolygon(tile, index));
  const approaches = roads.filter((points) => points[points.length - 1].every((coordinate) => coordinate === 0));
  const junction = approaches.length > 1;
  const roadLayer = (color: string, width: number) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    roads.forEach((points) => {
      path(points);
      ctx.stroke();
    });
  };
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Paint the network one layer at a time so branch caps cannot create
  // curbs across an intersection. Parking covers shoulders at entrances;
  // the asphalt is painted last to form a driveway into the lot.
  roadLayer("#d3c298", ROAD_WIDTH + 0.058);
  roadLayer("#ddd8bd", ROAD_WIDTH + 0.016);
  tile.costcoZones.forEach((_, index) => {
    const polygon = zonePolygon(tile, index);
    path(polygon, true);
    ctx.fillStyle = "#b6bbad";
    ctx.fill();
  });
  if (tile.hasMcDonalds && !tile.river) {
    ctx.fillStyle = "#b8b9a6";
    ctx.fillRect(-0.3, -0.25, 0.58, 0.51);
    ctx.strokeStyle = "#f4e4bf";
    ctx.lineWidth = 0.006;
    for (let x = -0.26; x < 0.26; x += 0.085) {
      ctx.beginPath();
      ctx.moveTo(x, 0.145);
      ctx.lineTo(x, 0.235);
      ctx.stroke();
    }
    // Drive-thru lane past the menu board, with direction arrows.
    ctx.fillStyle = "#9d9f94";
    ctx.fillRect(0.135, -0.24, 0.05, 0.36);
    ctx.fillStyle = "#f4e4bf";
    for (const z of [0.06, -0.12]) {
      ctx.beginPath();
      ctx.moveTo(0.16, z - 0.03);
      ctx.lineTo(0.147, z);
      ctx.lineTo(0.173, z);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(0.156, z, 0.008, 0.028);
    }
  }
  if (tile.hasMcDonalds && tile.river) {
    const [x, z] = restaurantPosition(tile);
    ctx.fillStyle = "#b8b9a6";
    ctx.fillRect(x - 0.18, z - 0.12, 0.36, 0.26);
  }
  roadLayer("#626c69", ROAD_WIDTH);
  ctx.lineWidth = 0.0035;
  ctx.strokeStyle = "#f2d786";
  ctx.setLineDash([0.036, 0.025]);
  roads.forEach((points) => {
    const terminates = approaches.includes(points);
    let drawing = false;
    ctx.beginPath();
    for (const [x, z] of points) {
      const clearCenter = terminates && Math.hypot(x, z) < (junction ? ROAD_WIDTH : 0.06);
      const inParking = zones.some((polygon) => insidePolygon([x, z], polygon));
      if (clearCenter || inParking) {
        drawing = false;
        continue;
      }
      if (drawing) ctx.lineTo(x, z);
      else ctx.moveTo(x, z);
      drawing = true;
    }
    ctx.stroke();
  });
  ctx.setLineDash([]);
  if (junction) {
    // Stop lines sit in each inbound lane, leaving the shared junction clear.
    ctx.lineCap = "butt";
    ctx.lineWidth = 0.012;
    ctx.strokeStyle = "#f4efda";
    approaches.forEach((points) => {
      const [x, z] = points[0].map((coordinate) => coordinate * 2);
      const distance = ROAD_WIDTH * 0.85;
      path([
        [x * distance + z * 0.012, z * distance - x * 0.012],
        [x * distance + z * ROAD_WIDTH * 0.44, z * distance - x * ROAD_WIDTH * 0.44],
      ]);
      ctx.stroke();
    });
  }
  paintRiver(ctx, tile);
  ctx.restore();
}

/** A view of a context that ignores colour changes, so everything paints in its current ink. */
function inkOnly(ctx: CanvasRenderingContext2D): CanvasRenderingContext2D {
  return new Proxy(ctx, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "fillStyle" || property === "strokeStyle") return true;
      return Reflect.set(target, property, value, target);
    },
  });
}

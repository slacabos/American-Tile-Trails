import * as THREE from "three";
import type { RegionWeights } from "./regions";
import { WIND_DIRECTION_GLSL } from "./wind";

/** Per-instance corner weights (farmland, forest, desert); meadow is the rest. */
export const REGION_ATTRIBUTES = ["regionNW", "regionNE", "regionSW", "regionSE"] as const;

const GRASS = new THREE.Color("#83a365");
/** Linear-space multipliers that turn the base grass into each landscape. */
const tint = (target: string) => {
  const color = new THREE.Color(target);
  return new THREE.Vector3(color.r / GRASS.r, color.g / GRASS.g, color.b / GRASS.b);
};

const VERTEX_HEAD = /* glsl */ `
attribute vec3 regionNW;
attribute vec3 regionNE;
attribute vec3 regionSW;
attribute vec3 regionSE;
varying vec3 vRegion;
varying vec2 vRegionWorld;
`;

const VERTEX_BODY = /* glsl */ `
vec2 regionT = position.xz + 0.5;
vRegion = mix(mix(regionNW, regionNE, regionT.x), mix(regionSW, regionSE, regionT.x), regionT.y);
#ifdef USE_INSTANCING
vRegionWorld = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xz;
#else
vRegionWorld = (modelMatrix * vec4(position, 1.0)).xz;
#endif
`;

const WATER_FUNCTIONS = /* glsl */ `
float waterHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float waterNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(waterHash(i), waterHash(i + vec2(1.0, 0.0)), u.x),
             mix(waterHash(i + vec2(0.0, 1.0)), waterHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Three drifting octaves in world space, so ripples run on across tile seams.
float waterHeight(vec2 p, float t) {
  return waterNoise(p * 9.0 + vec2(t * 0.6, t * 0.35)) * 0.5
       + waterNoise(p * 17.0 - vec2(t * 0.45, -t * 0.7)) * 0.3
       + waterNoise(p * 31.0 + vec2(-t * 0.9, t * 0.5)) * 0.2;
}
`;

// Runs after the map and regional tint. Leaves waterAmount, waterNormal and
// waterGlow for the roughness, normal and emissive chunks further down.
const WATER_BODY = /* glsl */ `
float waterAmount = 0.0;
vec3 waterNormal = vec3(0.0, 1.0, 0.0);
vec3 waterGlow = vec3(0.0);
float waterDepth = texture2D(waterMask, vMapUv).r * hasWater;
if (waterOn > 0.5 && waterDepth > 0.01) {
  vec2 wp = vRegionWorld;
  float t = waterTime;
  waterAmount = smoothstep(0.0, 0.1, waterDepth);
  float h = waterHeight(wp, t);
  float e = 0.004;
  vec2 slope = vec2(waterHeight(wp + vec2(e, 0.0), t) - h, waterHeight(wp + vec2(0.0, e), t) - h) / e;
  waterNormal = normalize(vec3(-slope.x * 0.025, 1.0, -slope.y * 0.025));
  vec3 shallow = vec3(0.10, 0.50, 0.62);
  vec3 deep = vec3(0.02, 0.20, 0.40);
  vec3 water = mix(shallow, deep, smoothstep(0.15, 0.95, waterDepth)) * (0.88 + 0.24 * h);
  // Two drifting noise fields; where they agree, a thin bright caustic web.
  float n1 = waterNoise(wp * 16.0 + vec2(t * 0.5, t * 0.3));
  float n2 = waterNoise(wp * 21.0 - vec2(t * 0.4, -t * 0.45) + 5.0);
  float caustic = pow(1.0 - abs(n1 - n2), 28.0) * smoothstep(0.3, 0.8, waterDepth);
  water += caustic * vec3(0.16, 0.26, 0.28);
  // Foam laps at the banks.
  float lap = 0.03 * sin(t * 1.8 + (wp.x - wp.y) * 23.0);
  float foamNoise = waterNoise(wp * 42.0 + vec2(t * 0.8, -t * 0.6));
  float foam = 1.0 - smoothstep(0.1, 0.22, waterDepth + 0.1 * (foamNoise - 0.5) + lap);
  water = mix(water, vec3(0.86, 0.94, 0.92), foam * 0.7);
  water *= 1.0 - 0.3 * waterNight;
  diffuseColor.rgb = mix(diffuseColor.rgb, water, waterAmount);
  float glint = smoothstep(0.95, 1.05, waterNoise(wp * 70.0 + t * vec2(1.3, -0.7)) * (0.55 + h));
  float daylight = 1.0 - 0.85 * waterNight;
  waterGlow = waterAmount * (1.0 - foam) * daylight
    * (vec3(0.03, 0.06, 0.08) + glint * vec3(0.9, 0.95, 1.0) + caustic * vec3(0.05, 0.08, 0.08));
}
`;

const FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D regionMask;
uniform sampler2D waterMask;
uniform float hasWater;
uniform float waterOn;
uniform float waterTime;
uniform float waterNight;
uniform vec3 farmTint;
uniform vec3 forestTint;
uniform vec3 desertTint;
varying vec3 vRegion;
varying vec2 vRegionWorld;
const vec2 cropWind = ${WIND_DIRECTION_GLSL};
${WATER_FUNCTIONS}
`;

const FRAGMENT_BODY = /* glsl */ `
float grass = texture2D(regionMask, vMapUv).r;
float meadowWeight = clamp(1.0 - vRegion.x - vRegion.y - vRegion.z, 0.0, 1.0);
// Crop rows run north-south across farmland; desert sand gets a fine speckle.
float rows = 0.86 + 0.14 * smoothstep(0.15, 0.45, abs(fract(vRegionWorld.x * 7.0) - 0.5));
float speck = fract(sin(dot(floor(vRegionWorld * 48.0), vec2(12.9898, 78.233))) * 43758.5453);
vec3 landscape = meadowWeight * vec3(1.0)
  + vRegion.x * farmTint * rows
  + vRegion.y * forestTint
  + vRegion.z * desertTint * (0.93 + 0.14 * speck);
diffuseColor.rgb *= mix(vec3(1.0), landscape, grass);
// With extra effects, gusts roll across the crops as bands of lighter stalks.
if (waterOn > 0.5) {
  float along = dot(vRegionWorld, cropWind);
  float gust = sin(along * 5.0 - waterTime * 1.3) * 0.65 + sin(along * 11.0 - waterTime * 2.2 + vRegionWorld.y * 3.0) * 0.35;
  diffuseColor.rgb *= 1.0 + 0.08 * gust * vRegion.x * grass;
}
${WATER_BODY}
`;

/** Shared by every ground material on a canvas, so one write animates them all. */
export interface WaterUniforms {
  waterOn: THREE.IUniform<number>;
  waterTime: THREE.IUniform<number>;
  waterNight: THREE.IUniform<number>;
}

export const createWaterUniforms = (): WaterUniforms => ({
  waterOn: { value: 0 },
  waterTime: { value: 0 },
  waterNight: { value: 0 },
});

/**
 * Let a tile type's ground take on the regional landscape wherever the mask
 * is white. Instances without region attributes read zeros, which is meadow.
 */
export function makeRegional(
  material: THREE.MeshStandardMaterial,
  mask: THREE.Texture,
  water?: { depth: THREE.Texture; uniforms: WaterUniforms },
): void {
  material.userData.regional = true;
  material.onBeforeCompile = (shader) => {
    // Land-only tiles bind the region mask so the sampler is never empty.
    shader.uniforms.waterMask = { value: water?.depth ?? mask };
    shader.uniforms.hasWater = { value: water ? 1 : 0 };
    Object.assign(shader.uniforms, water?.uniforms ?? createWaterUniforms());
    shader.uniforms.regionMask = { value: mask };
    shader.uniforms.farmTint = { value: tint("#c9b872") };
    shader.uniforms.forestTint = { value: tint("#5a7f4c") };
    shader.uniforms.desertTint = { value: tint("#dcc294") };
    shader.vertexShader =
      VERTEX_HEAD + shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader =
      FRAGMENT_HEAD +
      shader.fragmentShader
        .replace("#include <map_fragment>", `#include <map_fragment>\n${FRAGMENT_BODY}`)
        .replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.16, waterAmount);",
        )
        .replace(
          "#include <normal_fragment_maps>",
          "#include <normal_fragment_maps>\nnormal = normalize(mix(normal, (viewMatrix * vec4(waterNormal, 0.0)).xyz, waterAmount));",
        )
        .replace(
          "#include <emissivemap_fragment>",
          "#include <emissivemap_fragment>\ntotalEmissiveRadiance += waterGlow;",
        );
  };
}

/** Write each instance's corner weights onto the shared ground geometry. */
export function writeRegionAttributes(geometry: THREE.BufferGeometry, corners: RegionWeights[][]): void {
  REGION_ATTRIBUTES.forEach((name, corner) => {
    const values = new Float32Array(corners.length * 3);
    corners.forEach((weights, i) => {
      values[i * 3] = weights[corner].farmland;
      values[i * 3 + 1] = weights[corner].forest;
      values[i * 3 + 2] = weights[corner].desert;
    });
    geometry.setAttribute(name, new THREE.InstancedBufferAttribute(values, 3));
  });
}

import * as THREE from "three";
import type { WaterUniforms } from "./groundShader";

/**
 * The wind blows from the south-south-east, towards −z and slightly west.
 * Plants lean with it and windpumps turn their wheels into it, which faces
 * the wheels towards the tabletop camera in the south-east.
 */
export const WIND_DIRECTION = new THREE.Vector2(-Math.sin(0.35), -Math.cos(0.35));

/** Yaw that turns a model's +z to face into the wind, where it comes from. */
export const WIND_YAW = Math.atan2(-WIND_DIRECTION.x, -WIND_DIRECTION.y);

const glslVec2 = (v: THREE.Vector2) => `vec2(${v.x.toFixed(5)}, ${v.y.toFixed(5)})`;

/** The wind direction as a GLSL constant. */
export const WIND_DIRECTION_GLSL = glslVec2(WIND_DIRECTION);

/**
 * GLSL for gusty wind at a world position: a slow gust that rolls across the
 * board along the wind, with a quicker flutter on top. Zero while `windOn` is
 * off, so every effect it drives stands still without extra effects.
 */
export const WIND_FUNCTIONS = /* glsl */ `
uniform float windTime;
uniform float windOn;
const vec2 windDirection = ${WIND_DIRECTION_GLSL};
float windGust(vec2 world) {
  float along = dot(world, windDirection);
  return 0.5 + 0.5 * sin(windTime * 0.45 - along * 0.9);
}
float windStrength(vec2 world) {
  float flutter = sin(windTime * 2.1 + world.x * 3.7 + world.y * 2.3) * 0.5
                + sin(windTime * 3.3 + world.y * 4.1) * 0.25;
  return windOn * (0.3 + 0.7 * windGust(world)) * (0.55 + 0.45 * flutter);
}
`;

/** The shared clock and switch: the same objects the water animates with. */
export const windUniforms = (water: WaterUniforms) => ({ windTime: water.waterTime, windOn: water.waterOn });

/** Plants taller than this bend fully; shorter ones only in proportion. */
const SWAY_HEIGHT = 0.2;

/**
 * Bend instanced plants along the wind. The offset is added after the instance
 * transform, so it is in world space whatever way the plant was turned, and
 * grows with the square of height so trunks stay rooted.
 */
export function makeSwaying(material: THREE.Material, water: WaterUniforms, amplitude: number): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms(water), { swayAmplitude: { value: amplitude } });
    shader.vertexShader =
      `${WIND_FUNCTIONS}\nuniform float swayAmplitude;\n` +
      shader.vertexShader.replace(
        "#include <project_vertex>",
        /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
float bend = clamp( transformed.y / ${SWAY_HEIGHT.toFixed(3)}, 0.0, 1.0 );
mvPosition.xz += windDirection * swayAmplitude * bend * bend * windStrength( mvPosition.xz );
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`,
      );
  };
  // Materials with different amplitudes share one compiled program.
  material.customProgramCacheKey = () => "wind-sway";
}

/** How fast windpump wheels turn, in radians per second. */
const WHEEL_SPEED = 1.4;

/**
 * Spin instanced windpump wheels about their own z axis while extra effects
 * are on. Each wheel starts at its own angle, taken from where it stands, so
 * neighbours don't turn in lockstep.
 */
export function makeSpinning(material: THREE.Material, water: WaterUniforms): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms(water));
    shader.vertexShader =
      WIND_FUNCTIONS +
      /* glsl */ `
mat2 wheelSpin() {
  float phase = 0.0;
  #ifdef USE_INSTANCING
    phase = fract( sin( dot( instanceMatrix[3].xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 6.2832;
  #endif
  float angle = windOn * ( windTime * ${WHEEL_SPEED.toFixed(2)} + phase );
  return mat2( cos( angle ), sin( angle ), -sin( angle ), cos( angle ) );
}
` +
      shader.vertexShader
        .replace(
          "#include <beginnormal_vertex>",
          "#include <beginnormal_vertex>\nobjectNormal.xy = wheelSpin() * objectNormal.xy;",
        )
        .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed.xy = wheelSpin() * transformed.xy;");
  };
  material.customProgramCacheKey = () => "wind-wheel";
}

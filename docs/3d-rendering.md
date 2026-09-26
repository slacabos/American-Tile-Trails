# 3D tabletop rendering

The React UI and framework-independent game engine remain connected through the
existing state-change listener. `BoardView` chooses the renderer; `GameBoard`
owns the game and renderer preference, so changing the view never recreates the
game. The preference is optional browser storage. Graphics failures affect the
current session, not the saved preference or game state.

## Coordinates and scenery

The board's `(x, y)` coordinates map to Three.js `(x, 0, z)`. Tile centers are at
integer coordinates, with edges half a unit away. Canonical geometry uses north
at negative Z. `Tile.rotate()` already rotates the logical connections;
`canonicalTile()` removes that orientation before model construction. Each
instance then applies one negative-Y quarter-turn per clockwise orientation.

`tileLayout.ts` derives road paths, shopping footprints, feature anchors, and
claim resolution from `ITile`. `scenery.ts` owns building layouts, fences,
materials, and procedural ground/sign textures. Shopping portals share a
half-tile width; roads share a fixed width and tangent-aligned endpoints. Buildings
sit within their tile, and separate Costco zones retain separate paved areas.
`warehouseLayout.ts` groups Costco zones by their actual edge connections. Each
tile contributes a roof section; joined portals remove both internal walls and
curbs. `warehouseGeometry.ts` batches the complete board's warehouses by material,
with continuous roof seams, exterior red fascia, one main entrance/sign per
complex, and loading bays on larger complexes. Entrance selection excludes
enclosed courtyards. Parking follows the perimeter and leaves road entrances clear.
The main board, current-tile preview, and placement ghost use the same footprints.
Warehouse geometry changes only when placed Costco topology changes, and its old
buffers are disposed on replacement. Fields and separately defined Costco zones
retain their original connections and claim anchors.

Grass has subtle meadow patches, trees vary in size and form small clusters,
and through-roads meander gently while retaining matching edge positions/tangents.
Road shoulders, curbs, and asphalt are painted across the whole network in
separate passes so intersections have no internal borders. Lane markings leave
junction centers clear, with stop lines on incoming lanes. Asphalt extends into
shopping lots while parking covers the shoulders at each driveway entrance.

### Landmarks, regions and night

`landmarks.ts` gives some tile types a man-made landmark in canonical tile space
(billboard, overlook, barn and silo, cul-de-sac houses, drive-thru menu board,
picnic table, lamps). `landmarkConflict()` keeps every landmark clear of roads,
lots, water, the restaurant and every follower anchor; a unit test enforces it.
Tile names describe what is drawn, never a landscape, because the same tile can
land in any region.

`regions.ts` is the single source of truth for regional landscapes. Seeded,
two-octave value noise in a rotated frame yields weights for meadow, farmland,
pine forest and desert. They sum to 1 and are forced to meadow within two tiles
of the origin. The seed is `GameState.sceneSeed` (scenery only; it never
affects rules). Each placed tile passes the weights at its four world corners to
the ground shader (`groundShader.ts`) as instanced attributes. Neighbours share
those corners, so there are no seams. The shader interpolates across the tile and
tints only where the per-type grass mask is white, so roads, lots, water and
painted markings keep their colours. Farmland adds world-space crop rows; desert
adds speckle.

`vegetation.ts` lists plant spots per tile type (tree, shrub, sapling). The
board draws them in one instanced mesh per species. Each spot's region is
sampled from the weights, so borders mingle: round trees and bushes in meadow,
pines in forest, hay bales and fences on farmland, cacti and red rocks in the
desert. The placement ghost and the tile preview always show meadow. A tenth of
the tree spots in farmland and desert get a classic farm windpump instead
(`isWindpumpSpot`): a lattice tower, tail vane and stock tank, with its wheel in
a separate instanced mesh so it can spin. Every windpump faces into the wind.

Solid-coloured props merge into one vertex-coloured mesh per tile type
(`paint.ts`). A second mesh holds windows and lamps. At night,
`SceneryLibrary.setNight()` turns on their emissive glow, and the warehouse
glass's too (entrance and a band of windows along every exterior wall, with a
wedge of light fanning from the doors across the lot), and each lamppost casts a
soft warm pool of light on the ground (an additive disc, cheaper than a real
light). Night lighting swaps the sun for a cool moon and darkens the table; the
UI switches palettes through
`:root[data-time="night"]` tokens. The choice is stored in `localStorage`,
defaults to the system dark-mode setting, and toggles from the HUD's settings
panel, the setup screen, or the `N` key.

### Sun, moon and grounding shade

The key light follows the game (`skyPose` in `skyPath.ts`). Progress is the
share of the deck on the board, so a resumed game gets the same sky. The sun
rises in the east (+x) at the first tile, crosses the south (+z) at midday and
sets in the west as the deck runs out. Its colour runs from soft morning light
through white midday to golden hour. At night the moon makes the same crossing,
lower, cooler and dimmer. A night game opens at dusk and ends at dawn, in soft
mauve light under a violet sky; the twilight eases out quickly, so moonlight
fills the middle. Elevation never drops below about 24°, so shadows stay on the
board. The light moves a little with each placed tile and does not animate, so
an idle board stays idle. The tile preview keeps the midday light.

Props are shaded where they meet the ground, at no runtime cost.
`PaintBatch` darkens vertex colours near y = 0 (`groundShade` in `paint.ts`),
leaving the tile's slab below the surface alone. Each tile type's ground
texture also gets a soft contact shadow under every plant spot and landmark
(`paintContactShadows` in `scenery.ts`). It is painted into the colour map only,
so the regional tint still applies over it.

### Extra effects

The HUD's settings panel (or `G`) switches optional effects; the choice is
stored in `localStorage` and starts on, unless the player prefers reduced
motion. Each river tile gets a depth mask (`paintWaterDepth`, bank to channel
centre), and the ground shader swaps the painted water for world-space ripples
that bend the lighting normal, glossy glints, caustics and foam at the banks.
Working in world space keeps the pattern continuous across tiles. All ground
materials share one set of water uniforms on the `SceneryLibrary`.

The wind (`wind.ts`) blows from the south-south-east, so windpump wheels face
the tabletop camera. Gusts roll across the board along it. Trees, bushes and
ferns bend with it in the vertex shader (`makeSwaying`), by the square of their
height so trunks stay rooted, and a matching depth material keeps their shadows
in step. Windpump wheels spin about their hub (`makeSpinning`), and bands of
lighter crops ripple across farmland. At night, fireflies (`fireflies.ts`) drift
and blink over meadow and forest plants and along riverbanks: one `Points` mesh
of at most 160.

Water, wind and fireflies all read the water uniforms' clock. `AmbientMotion`
advances it and requests the next frame only while effects are on, so with them
off the canvas stays on demand rendering, with painted water and still
plants.

Stored road/store claims use cardinal directions, and field claims use corners.
They are resolved to the matching feature before placing followers. Claims match exact tile coordinates, including
negative positions. Feature anchors deliberately avoid centroids that could sit
inside another feature.
Claim markers keep these world-space anchors but render as a final transparent
overlay with depth testing and depth writing disabled. Their solid colour and
base ring stay visible through buildings, trees, and placement previews; farmers
retain their lying-down shape. Markers do not cast misleading scenery shadows.
Claim highlights clear on game-state changes, including when claiming or skipping
removes a focused button without blur. Missing features and empty highlight
polygons are ignored so stale selections cannot take down the 3D canvas.

## Rendering and interaction

Three.js 0.170 and React Three Fiber 8 support the existing React 18 application.
Each canvas owns and disposes its scenery library. Geometry is merged by material
within a tile type (all painted props share one material), then repeated tiles
are instanced across the board. At its fitted zoom, a full 63-tile board draws
about 150 calls and 46k triangles in the colour pass. Since three r186,
`renderer.info` also counts the shadow-map pass, so the e2e budget test reports
about 232 calls and 82k triangles for the same scene. A subtle
shader grid aligns to tile edges and fades out beyond the board, using one
additional draw call. The tile
gallery uses one canvas for every tile and rotation. The current-tile preview is
a second canvas, sharing the same model-building code and camera angle. It stays
mounted (hidden while claiming) and reuses its library across turns, avoiding
repeated WebGL context creation and delayed teardown.

The orthographic camera has two views (`src/rendering/cameraPose.ts`). The
tabletop looks along a fixed 45-degree diagonal from 50 degrees up. The drone
looks straight down with `camera.up` set to north (negative Z). OrbitControls
reads `camera.up` when it is built, so the controls are rebuilt for each view; the
drone pans in screen space so dragging slides across the table. Switching blends
direction, up vector, target and zoom over 350 ms (instant with reduced motion),
keeping the player's focus, or the fitted frame when auto-fit is on. The choice is
stored as `american-tile-trails.view`; a saved `"2d"` from the old renderer switch
migrates to the drone view. Rotation is disabled. Automatic fitting follows board growth until
the player pans or zooms; Fit board re-enables it. Pointer-up placement requires a
primary click with no drag or multi-touch gesture. Touch selects a preview and
requires a separate confirmation. Placement is gated to human turns.

Game-state notifications produce fresh render snapshots because the engine's
board object and tile map mutate in place. Rendering uses `frameloop="demand"`;
camera and instance-matrix changes explicitly invalidate it, including preview
rotation. Pixel density is capped at 1.5, with one
1024-pixel directional shadow map per scene. There is no 2D renderer: context-loss
listeners and a graphics error boundary replace the board with a panel whose
**Try again** remounts the canvas, without resetting the game. Preview failures
hide only the preview; a healthy board keeps rendering. Context loss from a
detached or inactive canvas during teardown is ignored.

### Landing animation

Each tile placed after the scene mounts drops in over 480 ms
(`src/rendering/landing.ts`). It falls from 0.6 above the table, squashes to
about 0.9 height on impact, then settles through a small damped rebound. A
dust ring spreads and fades as it settles. AI placements animate too; the
board a scene opens on never does, and `prefers-reduced-motion` skips the
animation.

`BoardScene`'s `LandingDriver` writes the pose once per frame into a shared
ref. It uses a negative `useFrame` priority, so it runs first without taking
over rendering. It keeps demand rendering going only until the tile lands.
The tile's instanced parts and plants are moved inside their existing
`useFrame` callbacks, by rewriting that instance's matrix (and restoring it at
rest). `PlantInstances.owners` maps plants to their tile. Warehouses are one
board-wide mesh, so a landing Costco tile is left out of the joined layout and
falls as its own section (`landing-warehouse`). It joins its neighbours once it
lands.

## Verification

- Unit checks cover all 16 tile types in every rotation, edge portals, negative
  coordinates, separate shopping zones, stored claims, mutable board snapshots,
  and renderer preferences.
- Playwright exercises actual WebGL rendering, mouse drag versus click, rotation,
  feature claiming, touch confirmation/cancellation, switching views, context
  loss, unsupported WebGL, and a completed 52-tile game. Preview checks compare
  rendered pixels after each quarter turn, and texture checks catch borders or
  parking markings crossing junctions and driveway entrances.
  Marker checks compare their complete silhouettes with and without scenery for
  every feature on every tile/rotation, including opaque and translucent blockers.
- Storybook provides connected scenery, a full game, and all 64 type/rotation
  combinations for visual inspection.
- The development-only `/e2e/tiles.html?page=0` gallery has four pages (`0`–`3`)
  showing all 16 tile types at four readable orientations. Playwright saves these
  review sheets in its test artifacts.
- `/e2e/warehouses.html?example=0` through `4` shows the straight, L-shaped,
  four-tile courtyard, separate-zone, and gas-station prototypes. Add/remove
  controls exercise live joins and GPU geometry cleanup. These layouts are also
  available in the Connected Warehouses Storybook story.

The headless Linux Chromium/SwiftShader check measures draw calls, triangles,
and idle-frame stability; software-renderer timing is not a hardware FPS benchmark.
The target is smooth 60 fps desktop / 30 fps tablet navigation. Physical tablet
and GPU performance must still be measured on those devices before claiming that
target has been met.

Coverage combines the unit and Storybook browser suites because jsdom cannot
exercise WebGL. `npm run test:coverage` writes `coverage/combined/index.html` and
enforces the 80% line, statement, function, and branch targets on that merged
report. `npm run test:coverage:unit` produces the faster unit-only report.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Minus, Plus } from "lucide-react";
import type { ClaimableFeature, GameState, Position } from "@/types";
import type { ITile } from "@/interfaces/ITile";
import { GamePhase } from "@/types";
import {
  boardSnapshot,
  featureAnchor,
  positionKey,
  resolveClaim,
  samePosition,
  worldToBoard,
} from "@/rendering/tileLayout";
import {
  CellOutline,
  Daylight,
  FeatureHighlight,
  Follower,
  GhostTile,
  LandingDust,
  NightLights,
  Scenery,
  SceneryProvider,
  AmbientMotion,
  Fireflies,
} from "./Scenery";
import { useTranslations } from "@/hooks/useTranslations";
import { PlacementGrid } from "./PlacementGrid";
import type { CompletedCostco } from "@/rendering/completedCostcos";
import { SCENE_PALETTE } from "@/rendering/timeOfDay";
import { gameProgress } from "@/rendering/skyPath";
import type { CameraView } from "@/rendering/cameraView";
import { directionKey, isTypingTarget } from "@/rendering/keyboard";
import { applyPose, blendPose, VIEW_POSES, VIEW_TRANSITION_MS, type ViewPose } from "@/rendering/cameraPose";
import { LANDING_MS, landingPose, prefersReducedMotion, type LandingFrame } from "@/rendering/landing";

export interface BoardSceneProps {
  state: GameState;
  onTilePlace: (position: Position) => void;
  onUnavailable: () => void;
  highlightedFeature?: ClaimableFeature;
  completedCostcos?: CompletedCostco[];
  night?: boolean;
  view?: CameraView;
  /** The keyboard placement cursor; a pointer hover or touch selection wins. */
  cursor?: Position;
  extraVfx?: boolean;
  /** Sets how far the sun or moon has travelled (0–1) instead of following the game; for Storybook. */
  skyProgress?: number;
}

function CompletedCostcoMarker({ center }: { center: CompletedCostco["center"] }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 160;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#f4bf4f";
    ctx.beginPath();
    ctx.arc(80, 80, 73, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#62461e";
    ctx.lineWidth = 9;
    ctx.stroke();
    ctx.fillStyle = "#352a17";
    ctx.font = "bold 100px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("✓", 80, 86);
    const result = new THREE.CanvasTexture(canvas);
    result.colorSpace = THREE.SRGBColorSpace;
    return result;
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite
      name="completed-costco-marker"
      position={[center.x, 0.54, center.y]}
      scale={[0.22, 0.22, 1]}
      renderOrder={20}
    >
      <spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} />
    </sprite>
  );
}
interface CameraActions {
  fit: () => void;
  zoom: (factor: number) => void;
  /** Move the view by screen pixels (right, up), staying on the table. */
  pan: (right: number, up: number) => void;
  /** Bring a board position back into view when it nears the edge. */
  focus: (position: Position) => void;
}

/** How far one Shift+arrow press pans, in screen pixels. */
const PAN_STEP = 90;
interface ViewTransition {
  view: CameraView;
  from: ViewPose;
  to: ViewPose;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromZoom: number;
  toZoom: number;
  start: number;
  duration: number;
}

function ContextHealth({ onUnavailable }: { onUnavailable: () => void }) {
  const { gl, get } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (event: Event) => {
      // R3F deliberately loses the context when disposing an unmounted canvas.
      if (!canvas.isConnected || !get().internal.active) return;
      event.preventDefault();
      onUnavailable();
    };
    canvas.addEventListener("webglcontextlost", lost);
    return () => canvas.removeEventListener("webglcontextlost", lost);
  }, [gl, get, onUnavailable]);
  return null;
}

function Navigation({
  state,
  view,
  legal,
  onHover,
  onSelect,
  onTilePlace,
  actions,
}: {
  state: GameState;
  view: CameraView;
  legal: Position[];
  onHover: (position?: Position) => void;
  onSelect: (position: Position) => void;
  onTilePlace: (position: Position) => void;
  actions: React.MutableRefObject<CameraActions | null>;
}) {
  const { camera, gl, size, invalidate } = useThree();
  const controls = useRef<OrbitControls | undefined>(undefined);
  const autoFit = useRef(true);
  const fitRef = useRef<() => void>(() => {});
  // Pointer listeners are attached once; they read the latest props from here.
  const latest = useRef({ legal, onHover, onSelect, onTilePlace });
  useLayoutEffect(() => {
    latest.current = { legal, onHover, onSelect, onTilePlace };
  });
  const bounds = state.board.getBounds();
  const { minX, minY, maxX, maxY } = bounds;

  // The view the controls are built for. It changes once a switch has landed.
  const [settledView, setSettledView] = useState(view);
  // The look target, kept across control rebuilds and view switches.
  const target = useRef(new THREE.Vector3());
  const transition = useRef<ViewTransition | null>(null);

  /** Where to look, and how far to zoom, to frame the whole board in a pose. */
  const framing = useCallback(
    (pose: ViewPose) => {
      const center = new THREE.Vector3((minX + maxX) / 2, 0, (minY + maxY) / 2);
      const probe = (camera as THREE.OrthographicCamera).clone();
      applyPose(probe, center, pose);
      const inverse = probe.matrixWorldInverse;
      const projected = new THREE.Box3();
      for (const x of [minX - 1.5, maxX + 1.5])
        for (const z of [minY - 1.5, maxY + 1.5]) {
          projected.expandByPoint(new THREE.Vector3(x, 0, z).applyMatrix4(inverse));
          projected.expandByPoint(new THREE.Vector3(x, 0.4, z).applyMatrix4(inverse));
        }
      const span = projected.getSize(new THREE.Vector3());
      const zoom = Math.min(180, size.width / span.x, size.height / span.y) * 0.9;
      return { center, zoom };
    },
    [camera, minX, minY, maxX, maxY, size.width, size.height],
  );

  const fit = useCallback(() => {
    // A view switch lands on a fitted frame by itself.
    if (transition.current) return;
    const cam = camera as THREE.OrthographicCamera;
    const pose = VIEW_POSES[settledView];
    const { center, zoom } = framing(pose);
    target.current.copy(center);
    applyPose(camera, center, pose);
    cam.zoom = zoom;
    cam.updateProjectionMatrix();
    if (controls.current) {
      controls.current.target.copy(center);
      controls.current.update();
    }
    invalidate();
  }, [camera, framing, settledView, invalidate]);
  // Layout effects run before the controls effect below first calls it.
  useLayoutEffect(() => {
    fitRef.current = fit;
  }, [fit]);

  // Start swinging the camera when the requested view changes.
  useEffect(() => {
    if (view === settledView || transition.current?.view === view) return;
    const cam = camera as THREE.OrthographicCamera;
    const to = VIEW_POSES[view];
    const framed = autoFit.current ? framing(to) : undefined;
    if (controls.current) controls.current.enabled = false;
    transition.current = {
      view,
      from: {
        direction: camera.position.clone().sub(target.current).normalize(),
        up: camera.up.clone(),
      },
      to,
      fromTarget: target.current.clone(),
      toTarget: framed?.center ?? target.current.clone(),
      fromZoom: cam.zoom,
      toZoom: framed?.zoom ?? cam.zoom,
      start: performance.now(),
      duration: prefersReducedMotion() ? 0 : VIEW_TRANSITION_MS,
    };
    invalidate();
  }, [view, settledView, camera, framing, invalidate]);

  useFrame(() => {
    const move = transition.current;
    if (!move) return;
    const cam = camera as THREE.OrthographicCamera;
    const t = move.duration ? (performance.now() - move.start) / move.duration : 1;
    const k = Math.min(1, t);
    target.current.lerpVectors(move.fromTarget, move.toTarget, k);
    applyPose(camera, target.current, blendPose(move.from, move.to, k));
    cam.zoom = THREE.MathUtils.lerp(move.fromZoom, move.toZoom, k);
    cam.updateProjectionMatrix();
    if (k < 1) {
      invalidate();
      return;
    }
    transition.current = null;
    setSettledView(move.view);
  });

  useEffect(() => {
    // OrbitControls reads camera.up when it is built, so each view gets its own.
    applyPose(camera, target.current, VIEW_POSES[settledView]);
    const orbit = new OrbitControls(camera, gl.domElement);
    controls.current = orbit;
    orbit.target.copy(target.current);
    orbit.enableRotate = false;
    orbit.enableDamping = false;
    // Looking straight down, screen-space panning slides across the table.
    orbit.screenSpacePanning = settledView === "drone";
    orbit.minZoom = 8;
    orbit.maxZoom = 320;
    orbit.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    orbit.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    const changed = () => {
      target.current.copy(orbit.target);
      invalidate();
    };
    orbit.addEventListener("change", changed);
    // Slide camera and target together, then drop the target back onto the
    // table along the view direction (which does not change an orthographic view).
    const shift = (offset: THREE.Vector3) => {
      autoFit.current = false;
      const direction = camera.getWorldDirection(new THREE.Vector3());
      const next = orbit.target.clone().add(offset);
      next.addScaledVector(direction, -next.y / direction.y);
      camera.position.add(next.clone().sub(orbit.target));
      orbit.target.copy(next);
      target.current.copy(next);
      orbit.update();
      invalidate();
    };
    actions.current = {
      fit: () => {
        autoFit.current = true;
        fitRef.current();
      },
      pan: (right, up) => {
        const cam = camera as THREE.OrthographicCamera;
        camera.updateMatrixWorld();
        const offset = new THREE.Vector3()
          .setFromMatrixColumn(camera.matrixWorld, 0)
          .multiplyScalar(right / cam.zoom)
          .add(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(up / cam.zoom));
        shift(offset);
      },
      focus: ({ x, y }) => {
        const point = new THREE.Vector3(x, 0, y).project(camera);
        if (Math.abs(point.x) < 0.7 && Math.abs(point.y) < 0.7) return;
        shift(new THREE.Vector3(x, 0, y).sub(orbit.target));
      },
      zoom: (factor) => {
        autoFit.current = false;
        const cam = camera as THREE.OrthographicCamera;
        cam.zoom = THREE.MathUtils.clamp(cam.zoom * factor, 8, 320);
        cam.updateProjectionMatrix();
        invalidate();
      },
    };
    if (autoFit.current) fitRef.current();
    else orbit.update();
    return () => {
      orbit.dispose();
      controls.current = undefined;
      actions.current = null;
    };
  }, [camera, gl, invalidate, actions, settledView]);

  useEffect(() => {
    if (autoFit.current) fit();
  }, [fit]);

  useEffect(() => {
    const canvas = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    const pointers = new Set<number>();
    let start: { x: number; y: number; type: string; button: number } | undefined;
    let cancelled = false;
    const pick = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          (-(event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      if (!raycaster.ray.intersectPlane(plane, hit)) return undefined;
      const position = worldToBoard(hit.x, hit.z);
      return latest.current.legal.find((candidate) => samePosition(position, candidate));
    };
    const down = (event: PointerEvent) => {
      pointers.add(event.pointerId);
      if (pointers.size === 1) {
        start = {
          x: event.clientX,
          y: event.clientY,
          type: event.pointerType,
          button: event.button,
        };
        cancelled = false;
      } else {
        cancelled = true;
        autoFit.current = false;
        latest.current.onHover(undefined);
      }
    };
    const move = (event: PointerEvent) => {
      if (start && pointers.size && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) {
        cancelled = true;
        autoFit.current = false;
        latest.current.onHover(undefined);
      }
      if (!pointers.size && event.pointerType !== "touch") latest.current.onHover(pick(event));
    };
    const up = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      if (
        start &&
        !cancelled &&
        start.button === 0 &&
        pointers.size === 0 &&
        Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6
      ) {
        const position = pick(event);
        if (position) {
          if (start.type === "touch") latest.current.onSelect(position);
          else latest.current.onTilePlace(position);
        }
      }
      if (!pointers.size) start = undefined;
    };
    const cancel = () => {
      cancelled = true;
      pointers.clear();
      start = undefined;
      latest.current.onHover(undefined);
    };
    const leave = () => latest.current.onHover(undefined);
    const wheel = () => {
      autoFit.current = false;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("lostpointercapture", cancel);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: true });
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("lostpointercapture", cancel);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [camera, gl]);
  return null;
}

interface Landing {
  key: string;
  center: Position;
}

/**
 * The tile placed since the scene mounted, while it lands. The board a
 * scene opens on never animates, and reduced motion skips landings. Only a
 * board that gained a tile animates, so a restored or taken-back game never
 * drops an older tile again.
 */
function useLanding(state: GameState) {
  const placed = state.lastPlacedPosition;
  const placedKey = placed ? positionKey(placed) : undefined;
  const tileCount = state.board.getAllTiles().size;
  const [seen, setSeen] = useState({ key: placedKey, tileCount });
  const [landing, setLanding] = useState<Landing | null>(null);
  if (placedKey !== seen.key || tileCount !== seen.tileCount) {
    setSeen({ key: placedKey, tileCount });
    const grew = tileCount > seen.tileCount;
    setLanding(grew && placed && placedKey && !prefersReducedMotion() ? { key: placedKey, center: placed } : null);
  }
  const done = useCallback(() => setLanding(null), []);
  return { landing, done };
}

/**
 * Advances the landing once per frame, before the meshes that draw the tile
 * read it, and keeps demand rendering going only until the tile has landed.
 */
function LandingDriver({
  landing,
  frame,
  onDone,
}: {
  landing: Landing | null;
  frame: React.RefObject<LandingFrame | null>;
  onDone: () => void;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const started = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (landing) invalidate();
  }, [landing, invalidate]);
  // A negative priority runs first without taking over rendering.
  useFrame(() => {
    if (!landing) {
      frame.current = null;
      return;
    }
    if (started.current?.key !== landing.key) started.current = { key: landing.key, at: performance.now() };
    const t = (performance.now() - started.current.at) / LANDING_MS;
    if (t >= 1) {
      frame.current = null;
      onDone();
      return;
    }
    frame.current = {
      key: landing.key,
      center: landing.center,
      pose: landingPose(t),
    };
    invalidate();
  }, -1);
  return null;
}

export function BoardScene({
  state,
  onTilePlace,
  onUnavailable,
  highlightedFeature,
  completedCostcos = [],
  night = false,
  view = "tabletop",
  cursor,
  extraVfx = false,
  skyProgress,
}: BoardSceneProps) {
  const palette = SCENE_PALETTE[night ? "night" : "day"];
  const { t } = useTranslations();
  const { landing, done: landed } = useLanding(state);
  const landingFrame = useRef<LandingFrame | null>(null);
  const snapshot = useMemo(() => boardSnapshot(state), [state]);
  // A hover or touch selection survives rotation, but never a turn or a
  // placement: each remembers the turn it was made in and lapses after it.
  const turn = `${state.turnNumber}:${state.phase}:${state.currentPlayerIndex}`;
  const [hoverAt, setHoverAt] = useState<{
    turn: string;
    position?: Position;
  }>();
  const [selectedAt, setSelectedAt] = useState<{
    turn: string;
    position?: Position;
  }>();
  const hover = hoverAt?.turn === turn ? hoverAt.position : undefined;
  const selected = selectedAt?.turn === turn ? selectedAt.position : undefined;
  const actions = useRef<CameraActions | null>(null);
  // Camera keys. Game keys (cursor, placing, claiming) live in GameBoard.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event) || event.ctrlKey || event.metaKey || event.altKey) return;
      const camera = actions.current;
      if (!camera) return;
      if (event.key === "+" || event.key === "=") camera.zoom(1.2);
      else if (event.key === "-" || event.key === "_") camera.zoom(1 / 1.2);
      else if (event.key === "f" || event.key === "F") camera.fit();
      else if (event.shiftKey && directionKey(event.key)) {
        event.preventDefault();
        const direction = directionKey(event.key);
        const right = direction === "ArrowRight" ? PAN_STEP : direction === "ArrowLeft" ? -PAN_STEP : 0;
        const up = direction === "ArrowUp" ? PAN_STEP : direction === "ArrowDown" ? -PAN_STEP : 0;
        camera.pan(right, up);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  // Keep the keyboard cursor on screen.
  useEffect(() => {
    if (cursor) actions.current?.focus(cursor);
  }, [cursor]);
  const setHovered = useCallback(
    (position?: Position) =>
      setHoverAt((previous) =>
        previous?.turn === turn && samePosition(previous.position, position) ? previous : { turn, position },
      ),
    [turn],
  );
  const setSelected = useCallback((position?: Position) => setSelectedAt({ turn, position }), [turn]);
  const preview = snapshot.legal.find((position) => samePosition(position, selected ?? hover ?? cursor));
  const last = state.lastPlacedPosition && state.board.getTile(state.lastPlacedPosition);
  const bounds = state.board.getBounds();
  const center: [number, number] = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) + 5;
  const progress = skyProgress ?? gameProgress(snapshot.tiles.length, state.tileDeck.length);

  return (
    <div className="tabletop-scene" data-testid="board-3d">
      <Canvas
        orthographic
        shadows="percentage"
        camera={{ position: [12, 20, 12], zoom: 90, near: 0.1, far: 150 }}
        dpr={[1, 1.5]}
        frameloop="demand"
        gl={{ antialias: true, alpha: false, powerPreference: "low-power" }}
        fallback={t("board.unavailable")}
      >
        <color attach="background" args={[palette.background]} />
        <ContextHealth onUnavailable={onUnavailable} />
        <Navigation
          state={state}
          view={view}
          legal={snapshot.legal}
          onHover={setHovered}
          onSelect={setSelected}
          onTilePlace={onTilePlace}
          actions={actions}
        />
        <Daylight center={center} span={span} night={night} progress={progress} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center[0], -0.096, center[1]]} receiveShadow>
          <planeGeometry args={[300, 300]} />
          <meshStandardMaterial color={palette.table} roughness={1} />
        </mesh>
        <PlacementGrid bounds={bounds} color={palette.grid} />
        <SceneryProvider>
          <NightLights night={night} />
          <LandingDriver landing={landing} frame={landingFrame} onDone={landed} />
          <AmbientMotion enabled={extraVfx} />
          <Scenery records={snapshot.tiles} seed={state.sceneSeed} landing={landingFrame} landingKey={landing?.key} />
          {night && extraVfx && <Fireflies records={snapshot.tiles} seed={state.sceneSeed} />}
          <LandingDust landing={landingFrame} night={night} />
          {snapshot.legal.map((position) => (
            <CellOutline key={positionKey(position)} x={position.x} z={position.y} fill />
          ))}
          {preview && state.currentTile && (
            <>
              <GhostTile tile={state.currentTile} x={preview.x} z={preview.y} />
              <CellOutline x={preview.x} z={preview.y} color="#fff2ba" />
            </>
          )}
        </SceneryProvider>
        {snapshot.tiles.flatMap((record) =>
          snapshot.claims.flatMap((claim) => {
            const feature = resolveClaim(record.tile, record.position, claim);
            if (!feature) return [];
            const [x, z] = featureAnchor(record.tile, feature);
            return claim.players.map((id, i) => {
              const player = state.players.find((candidate) => candidate.id === id);
              return player ? (
                <Follower
                  key={`${claim.edge}-${id}-${i}`}
                  point={[
                    record.position.x + x + i * 0.085,
                    feature.type === "mcdonalds" ? 0.16 : 0.012,
                    record.position.y + z,
                  ]}
                  color={player.color}
                  farmer={claim.followerType === "farmer"}
                />
              ) : null;
            });
          }),
        )}
        {completedCostcos.map((completed, index) => (
          <CompletedCostcoMarker
            key={`${completed.center.x},${completed.center.y},${index}`}
            center={completed.center}
          />
        ))}
        {last && <CellOutline x={last.position.x} z={last.position.y} color="#e8c572" />}
        {last && highlightedFeature && state.phase === GamePhase.CLAIM_FEATURE && (
          <FeatureHighlight tile={last.tile} feature={highlightedFeature} x={last.position.x} z={last.position.y} />
        )}
      </Canvas>
      <div className="tabletop-compass" aria-hidden="true">
        {t("board.compass")}
        {view === "drone" ? "↑" : "↗"}
      </div>
      <div className="board-pill tabletop-camera-controls" role="group" aria-label={t("board.cameraControls")}>
        <span className="board-pill-status">
          {t(snapshot.tiles.length === 1 ? "board.tilesOne" : "board.tiles", {
            count: snapshot.tiles.length,
          })}
          {snapshot.canPlace
            ? ` · ${t(snapshot.legal.length === 1 ? "board.legalOne" : "board.legal", { count: snapshot.legal.length })}`
            : ""}
        </span>
        <span className="board-pill-divider" aria-hidden="true" />
        <button type="button" aria-label={t("board.zoomOut")} onClick={() => actions.current?.zoom(1 / 1.2)}>
          <Minus size={16} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => actions.current?.fit()}>
          {t("board.fit")}
        </button>
        <button type="button" aria-label={t("board.zoomIn")} onClick={() => actions.current?.zoom(1.2)}>
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      {selected && snapshot.canPlace && (
        <div className="tabletop-confirm">
          <button
            type="button"
            disabled={!preview}
            onClick={() => {
              if (!preview) return;
              onTilePlace(preview);
              setSelected(undefined);
            }}
          >
            {t("board.place")}
          </button>
          <button type="button" onClick={() => setSelected(undefined)}>
            {t("board.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

export function TilePreviewScene({
  tile,
  onUnavailable,
  night = false,
  extraVfx = false,
}: {
  tile?: ITile;
  onUnavailable: () => void;
  night?: boolean;
  extraVfx?: boolean;
}) {
  const { t } = useTranslations();
  const records = useMemo(() => (tile ? [{ tile, position: { x: 0, y: 0 } }] : []), [tile]);
  return (
    <div className="tabletop-tile-preview" role="img" aria-label={tile?.name}>
      <Canvas
        orthographic
        shadows="percentage"
        camera={{ position: [3, 5.056, 3], zoom: 122, near: 0.1, far: 40 }}
        frameloop="demand"
        dpr={[1, 1.5]}
        fallback={t("board.previewUnavailable")}
        onCreated={({ camera }) => camera.lookAt(0, 0.04, 0)}
      >
        <ContextHealth onUnavailable={onUnavailable} />
        <Daylight night={night} />
        <SceneryProvider>
          <NightLights night={night} />
          <AmbientMotion enabled={extraVfx} />
          <Scenery records={records} />
        </SceneryProvider>
      </Canvas>
    </div>
  );
}

// First-person "drop in" walk mode: a 1.8 m tall player so every scale in the
// map can be judged against a real human eye height.

import * as THREE from "three";
import { PLAYER_EYE, TerrainModel, WATER_LEVEL, LAND_R } from "./model";
import type { Grids } from "./bake";
import { HALF, WORLD } from "./model";

const WALK = 4.4; // m/s
const RUN = 8.6; // m/s
const GRAVITY = 22;
const JUMP = 6.4;

function sampleHeight(grids: Grids, x: number, z: number) {
  const n = grids.n;
  const u = THREE.MathUtils.clamp((x + HALF) / WORLD, 0, 1) * (n - 1);
  const v = THREE.MathUtils.clamp((z + HALF) / WORLD, 0, 1) * (n - 1);
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const tx = u - x0;
  const ty = v - y0;
  const a = grids.height[y0 * n + x0]!;
  const b = grids.height[y0 * n + x1]!;
  const c = grids.height[y1 * n + x0]!;
  const d = grids.height[y1 * n + x1]!;
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

export type FirstPerson = {
  update: (dt: number) => void;
  dispose: () => void;
  spawn: (x: number, z: number) => void;
  info: () => { x: number; y: number; z: number; underground: boolean };
};

export function createFirstPerson(
  camera: THREE.PerspectiveCamera,
  dom: HTMLElement,
  model: TerrainModel,
  grids: Grids,
): FirstPerson {
  const keys = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  let vy = 0;
  let grounded = false;
  let underground = false;
  const pos = new THREE.Vector3(0, 0, 0);

  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code);
    if (e.code === "Space") e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== dom) return;
    yaw -= e.movementX * 0.0022;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.0022, -1.5, 1.5);
  };
  const onClick = () => {
    if (document.pointerLockElement !== dom) void dom.requestPointerLock();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousemove", onMouseMove);
  dom.addEventListener("click", onClick);

  /** ground level under the player, accounting for tunnels below the surface */
  function groundAt(x: number, z: number, y: number) {
    const surface = Math.max(sampleHeight(grids, x, z), WATER_LEVEL - 0.4);
    const t = model.tunnelAt(x, z);
    if (t.dist < t.radius * 0.8) {
      // inside a tunnel corridor: pick the floor the player is closest to
      const useTunnel = y < surface - 1.5 || surface - t.floor < 4;
      if (useTunnel) return t.floor;
    }
    return surface;
  }

  function spawn(x: number, z: number) {
    pos.set(x, groundAt(x, z, 1e9) + PLAYER_EYE, z);
    vy = 0;
  }

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();

  function update(dt: number) {
    const speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? RUN : WALK;
    forward.set(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(-1);
    right.set(forward.z, 0, -forward.x);

    const move = new THREE.Vector3();
    if (keys.has("KeyW") || keys.has("ArrowUp")) move.add(forward);
    if (keys.has("KeyS") || keys.has("ArrowDown")) move.sub(forward);
    if (keys.has("KeyD") || keys.has("ArrowRight")) move.sub(right);
    if (keys.has("KeyA") || keys.has("ArrowLeft")) move.add(right);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);

    const nx = THREE.MathUtils.clamp(pos.x + move.x, -LAND_R + 4, LAND_R - 4);
    const nz = THREE.MathUtils.clamp(pos.z + move.z, -LAND_R + 4, LAND_R - 4);

    const nextGround = groundAt(nx, nz, pos.y - PLAYER_EYE);
    const stepUp = nextGround - (pos.y - PLAYER_EYE);
    // block impossibly steep climbs (a 1.8 m human can't scale a cliff)
    if (stepUp < 1.2 || !grounded) {
      pos.x = nx;
      pos.z = nz;
    }

    const ground = groundAt(pos.x, pos.z, pos.y - PLAYER_EYE);
    underground = model.tunnelAt(pos.x, pos.z).dist < 12 && ground < sampleHeight(grids, pos.x, pos.z) - 2;

    vy -= GRAVITY * dt;
    if (grounded && keys.has("Space")) vy = JUMP;
    pos.y += vy * dt;

    const feet = pos.y - PLAYER_EYE;
    if (feet <= ground) {
      pos.y = ground + PLAYER_EYE;
      vy = 0;
      grounded = true;
    } else {
      grounded = false;
    }

    camera.position.copy(pos);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(yaw);
    camera.rotateX(pitch);
  }

  function dispose() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("mousemove", onMouseMove);
    dom.removeEventListener("click", onClick);
    if (document.pointerLockElement === dom) document.exitPointerLock();
  }

  return {
    update,
    dispose,
    spawn,
    info: () => ({ x: pos.x, y: pos.y, z: pos.z, underground }),
  };
}

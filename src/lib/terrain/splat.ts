// Tiled-material terrain: instead of baking one huge unique albedo atlas
// (which costs tens of MB of VRAM in the target engine), the ground mesh is
// split into material groups and each group uses the small 512px tiling
// texture directly (grass / dirt / rock / sand / road). Five 512px textures
// cost ~4 MB of VRAM total versus ~90 MB for a single 4096 atlas.

import * as THREE from "three";
import { clamp, fbm, smoothstep } from "./noise";
import { HALF, LAND_R, TerrainModel, WATER_LEVEL, WORLD } from "./model";
import type { Grids, TexSet } from "./bake";
import { terrainHeight } from "./surface";

export type MatKey = keyof TexSet;
export const MAT_KEYS: MatKey[] = ["grass", "dirt", "rock", "sand", "road"];

function sampleGrid(grid: Float32Array, n: number, u: number, v: number) {
  const fx = clamp(u, 0, 1) * (n - 1);
  const fy = clamp(v, 0, 1) * (n - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = grid[y0 * n + x0]!;
  const b = grid[y0 * n + x1]!;
  const c = grid[y1 * n + x0]!;
  const d = grid[y1 * n + x1]!;
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Which surface material dominates at a world position. */
export function materialAt(model: TerrainModel, grids: Grids, wx: number, wz: number): MatKey {
  const u = (wx + HALF) / WORLD;
  const v = (wz + HALF) / WORLD;
  const h = sampleGrid(grids.height, grids.n, u, v);
  const slope = sampleGrid(grids.slope, grids.n, u, v);
  const road = clamp(sampleGrid(grids.road, grids.n, u, v) * 1.15, 0, 1);
  const rad = Math.hypot(wx, wz);

  if (road > 0.5) return "road";

  const rockW = clamp(smoothstep(0.3, 0.55, slope) + smoothstep(20, 30, h) * 0.5, 0, 1);
  const beach = smoothstep(LAND_R - 6, LAND_R - 26, rad);
  const sandW =
    clamp(Math.max(1 - smoothstep(WATER_LEVEL + 0.6, WATER_LEVEL + 4.2, h), 1 - beach), 0, 1) *
    (1 - rockW * 0.6);
  const dirtW = clamp((fbm(wx / 45, wz / 45, model.seed + 91, 4) - 0.42) * 3.2 + slope * 0.8, 0, 1);

  if (sandW > 0.5) return "sand";
  if (rockW > 0.5) return "rock";
  if (dirtW > 0.5) return "dirt";
  return "grass";
}

function textureFromImageData(img: ImageData, repeat: number, srgb: boolean) {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 16;
  return t;
}

/**
 * Builds the ground mesh with one geometry and five material groups, each
 * using a tiling 512px texture. Exports as five glTF primitives sharing one
 * buffer — small file, tiny VRAM, crisp up close.
 */
export function buildTiledTerrain(
  model: TerrainModel,
  grids: Grids,
  segments: number,
  tex: TexSet,
  normalMap: THREE.Texture,
  repeat = 110,
) {
  const geo = new THREE.PlaneGeometry(WORLD, WORLD, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes['position'] as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, terrainHeight(grids, x, z));
    // low-frequency tint so the repeating tiles never read as a pattern
    const m = 0.8 + fbm(x / 120, z / 120, model.seed + 17, 3) * 0.42;
    colors[i * 3] = m;
    colors[i * 3 + 1] = m * (0.98 + fbm(x / 200, z / 200, model.seed + 5, 2) * 0.06);
    colors[i * 3 + 2] = m * 0.97;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();

  // sort faces into per-material index buckets
  const src = geo.index!.array as ArrayLike<number>;
  const buckets: Record<MatKey, number[]> = {
    grass: [],
    dirt: [],
    rock: [],
    sand: [],
    road: [],
  };
  for (let f = 0; f < src.length; f += 3) {
    const a = src[f]!;
    const b = src[f + 1]!;
    const c = src[f + 2]!;
    const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const key = materialAt(model, grids, cx, cz);
    buckets[key].push(a, b, c);
  }

  const ordered = new Uint32Array(src.length);
  let cursor = 0;
  const materials: THREE.Material[] = [];
  geo.clearGroups();
  for (const key of MAT_KEYS) {
    const list = buckets[key];
    if (!list.length) continue;
    geo.addGroup(cursor, list.length, materials.length);
    for (let i = 0; i < list.length; i++) ordered[cursor + i] = list[i]!;
    cursor += list.length;

    const map = textureFromImageData(tex[key], repeat, true);
    const mat = new THREE.MeshStandardMaterial({
      name: `Ground_${key}`,
      map,
      normalMap,
      normalScale: new THREE.Vector2(0.55, 0.55),
      vertexColors: true,
      roughness: key === "road" ? 0.8 : 0.95,
      metalness: 0,
    });
    materials.push(mat);
  }
  geo.setIndex(
    pos.count > 65535
      ? new THREE.BufferAttribute(ordered, 1)
      : new THREE.BufferAttribute(Uint16Array.from(ordered), 1),
  );


  const mesh = new THREE.Mesh(geo, materials);
  mesh.name = "Terrain";
  return mesh;
}

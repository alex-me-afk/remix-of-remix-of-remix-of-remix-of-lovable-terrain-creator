// Bakes one photoreal albedo atlas for the whole island by blending the
// generated tiling textures (grass / dirt / rock / sand / asphalt) with masks
// derived from the heightfield, slope and road network. Also derives a
// tangent-space normal map so the exported GLB carries real surface detail.

import { clamp, fbm, smoothstep } from "./noise";
import { HALF, LAND_R, TerrainModel, WATER_LEVEL, WORLD } from "./model";

export type TexSet = Record<"grass" | "dirt" | "rock" | "sand" | "road", ImageData>;

export const TEX_URLS: Record<keyof TexSet, string> = {
  grass: "/textures/grass.jpg",
  dirt: "/textures/dirt.jpg",
  rock: "/textures/rock.jpg",
  sand: "/textures/sand.jpg",
  road: "/textures/road.jpg",
};

export async function loadImageData(url: string, size = 512): Promise<ImageData> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

export async function loadTexSet(size = 512): Promise<TexSet> {
  const keys = Object.keys(TEX_URLS) as (keyof TexSet)[];
  const imgs = await Promise.all(keys.map((k) => loadImageData(TEX_URLS[k], size)));
  return Object.fromEntries(keys.map((k, i) => [k, imgs[i]])) as TexSet;
}

/** grid of terrain data sampled once, then bilinearly reused everywhere */
export type Grids = {
  n: number;
  height: Float32Array;
  slope: Float32Array;
  road: Float32Array;
};

export function buildGrids(model: TerrainModel, n = 513): Grids {
  const height = new Float32Array(n * n);
  const road = new Float32Array(n * n);
  const slope = new Float32Array(n * n);
  const step = WORLD / (n - 1);
  for (let j = 0; j < n; j++) {
    const z = -HALF + j * step;
    for (let i = 0; i < n; i++) {
      const x = -HALF + i * step;
      const idx = j * n + i;
      height[idx] = model.height(x, z);
      road[idx] = model.roadMask(x, z);
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n - 1, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(n - 1, j + 1);
      const dx = (height[j * n + i1]! - height[j * n + i0]!) / ((i1 - i0) * step);
      const dz = (height[j1 * n + i]! - height[j0 * n + i]!) / ((j1 - j0) * step);
      slope[j * n + i] = Math.hypot(dx, dz);
    }
  }
  return { n, height, slope, road };
}

function sample(grid: Float32Array, n: number, u: number, v: number) {
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

const TILE = 512;
function tap(img: ImageData, x: number, y: number, out: [number, number, number]) {
  const xi = ((x % TILE) + TILE) % TILE | 0;
  const yi = ((y % TILE) + TILE) % TILE | 0;
  const o = (yi * TILE + xi) * 4;
  out[0] = img.data[o]!;
  out[1] = img.data[o + 1]!;
  out[2] = img.data[o + 2]!;
}

/** Composites the island albedo into a canvas. */
export function bakeAlbedo(
  model: TerrainModel,
  grids: Grids,
  tex: TexSet,
  size = 2048,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const out = ctx.createImageData(size, size);
  const px = out.data;

  const repeat = 128; // texture tiles across the map
  const scale = (TILE * repeat) / size;
  const g: [number, number, number] = [0, 0, 0];
  const d: [number, number, number] = [0, 0, 0];
  const r: [number, number, number] = [0, 0, 0];
  const s: [number, number, number] = [0, 0, 0];
  const a: [number, number, number] = [0, 0, 0];

  for (let y = 0; y < size; y++) {
    const v = y / (size - 1);
    const wz = -HALF + v * WORLD;
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1);
      const wx = -HALF + u * WORLD;
      const idx = (y * size + x) * 4;

      const h = sample(grids.height, grids.n, u, v);
      const slope = sample(grids.slope, grids.n, u, v);
      const roadW = clamp(sample(grids.road, grids.n, u, v) * 1.15, 0, 1);
      const rad = Math.hypot(wx, wz);

      const tx = x * scale;
      const ty = y * scale;
      tap(tex.grass, tx, ty, g);
      tap(tex.dirt, tx * 0.7, ty * 0.7, d);
      tap(tex.rock, tx * 0.55, ty * 0.55, r);
      tap(tex.sand, tx, ty, s);
      tap(tex.road, tx * 1.6, ty * 1.6, a);

      // masks
      const dirtW = clamp(
        (fbm(wx / 45, wz / 45, model.seed + 91, 4) - 0.42) * 3.2 + slope * 0.8,
        0,
        1,
      );
      const rockW = clamp(
        smoothstep(0.3, 0.55, slope) + smoothstep(20, 30, h) * 0.5,
        0,
        1,
      );
      const beach = smoothstep(LAND_R - 6, LAND_R - 26, rad);
      const sandW = clamp(
        Math.max(1 - smoothstep(WATER_LEVEL + 0.6, WATER_LEVEL + 4.2, h), 1 - beach),
        0,
        1,
      ) * (1 - rockW * 0.6);

      let cr = g[0];
      let cg = g[1];
      let cb = g[2];
      cr += (d[0] - cr) * dirtW;
      cg += (d[1] - cg) * dirtW;
      cb += (d[2] - cb) * dirtW;
      cr += (r[0] - cr) * rockW;
      cg += (r[1] - cg) * rockW;
      cb += (r[2] - cb) * rockW;
      cr += (s[0] - cr) * sandW;
      cg += (s[1] - cg) * sandW;
      cb += (s[2] - cb) * sandW;
      cr += (a[0] - cr) * roadW;
      cg += (a[1] - cg) * roadW;
      cb += (a[2] - cb) * roadW;

      // subtle macro colour variation so tiling never reads as repetition
      const macro = 0.86 + fbm(wx / 120, wz / 120, model.seed + 17, 3) * 0.28;
      px[idx] = clamp(cr * macro, 0, 255);
      px[idx + 1] = clamp(cg * macro, 0, 255);
      px[idx + 2] = clamp(cb * macro, 0, 255);
      px[idx + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/** Sobel-derives a tangent-space normal map from an albedo canvas. */
export function bakeNormalMap(src: HTMLCanvasElement, size = 1024, strength = 2.2) {
  const tmp = document.createElement("canvas");
  tmp.width = size;
  tmp.height = size;
  const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
  tctx.drawImage(src, 0, 0, size, size);
  const img = tctx.getImageData(0, 0, size, size);
  const lum = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    lum[i] =
      (img.data[i * 4]! * 0.299 + img.data[i * 4 + 1]! * 0.587 + img.data[i * 4 + 2]! * 0.114) / 255;
  }
  const out = tctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      const dx = (lum[y * size + xp]! - lum[y * size + xm]!) * strength;
      const dy = (lum[yp * size + x]! - lum[ym * size + x]!) * strength;
      let nx = -dx;
      let ny = -dy;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const o = (y * size + x) * 4;
      out.data[o] = (nx * 0.5 + 0.5) * 255;
      out.data[o + 1] = (ny * 0.5 + 0.5) * 255;
      out.data[o + 2] = (nz * 0.5 + 0.5) * 255;
      out.data[o + 3] = 255;
    }
  }
  const dst = document.createElement("canvas");
  dst.width = size;
  dst.height = size;
  dst.getContext("2d")!.putImageData(out, 0, 0);
  return dst;
}

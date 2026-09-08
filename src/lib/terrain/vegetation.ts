// Procedural vegetation scatter: places trees, rocks and grass tufts across the
// island using the heightfield + slope/road masks so vegetation respects the
// terrain (no trees in water, on roads, on build pads or cliff faces).

import { clamp, fbm, makeRng } from "./noise";
import { HALF, LAND_R, WATER_LEVEL, TerrainModel, WORLD } from "./model";
import type { Grids } from "./bake";

export type Placement = {
  x: number;
  y: number;
  z: number;
  /** uniform scale */
  s: number;
  /** y-axis rotation (radians) */
  rot: number;
};

export type Scatter = {
  trees: Placement[];
  rocks: Placement[];
  grass: Placement[];
};

/** bilinear sample of a square Float32 grid at normalized (u,v) in [0,1] */
function sampleGrid(g: Float32Array, n: number, u: number, v: number) {
  const fx = clamp(u, 0, 1) * (n - 1);
  const fy = clamp(v, 0, 1) * (n - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = g[y0 * n + x0]!;
  const b = g[y0 * n + x1]!;
  const c = g[y1 * n + x0]!;
  const d = g[y1 * n + x1]!;
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

export function generateScatter(
  model: TerrainModel,
  grids: Grids,
  seed: number,
): Scatter {
  const rng = makeRng(seed ^ 0x9e3779b9);
  const trees: Placement[] = [];
  const rocks: Placement[] = [];
  const grass: Placement[] = [];

  const SP = 5.2; // candidate grid spacing in world units
  const n = Math.ceil(WORLD / SP) + 1;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const baseX = -HALF + i * SP;
      const baseZ = -HALF + j * SP;
      // jitter within the cell
      const x = baseX + (rng() - 0.5) * SP;
      const z = baseZ + (rng() - 0.5) * SP;

      const rad = Math.hypot(x, z);
      if (rad > LAND_R - 3) continue; // past the coast

      const u = (x + HALF) / WORLD;
      const v = (z + HALF) / WORLD;
      const h = sampleGrid(grids.height, grids.n, u, v);
      if (h < WATER_LEVEL + 0.8) continue; // underwater / shoreline

      const slope = sampleGrid(grids.slope, grids.n, u, v);
      const roadW = clamp(sampleGrid(grids.road, grids.n, u, v) * 1.15, 0, 1);

      // keep build pads clear of vegetation
      let onPad = false;
      for (const p of model.pads) {
        if (Math.hypot(x - p.x, z - p.z) < p.r + 2.5) {
          onPad = true;
          break;
        }
      }
      if (onPad) continue;

      const forest = fbm(x / 58, z / 58, seed + 204, 4);

      // Trees: gentle slopes, off roads, clumped by a forest-noise mask.
      if (slope < 0.34 && roadW < 0.05 && h > WATER_LEVEL + 1.6) {
        // fbm here lands roughly in [0.1, 0.42]; remap so high-noise areas
        // become dense forest and low-noise areas stay clear.
        const density = clamp((forest - 0.18) * 4.6, 0, 1);
        if (rng() < density * density * 0.95) {
          trees.push({
            x,
            y: h,
            z,
            s: 0.8 + rng() * 0.7,
            rot: rng() * Math.PI * 2,
          });
          continue;
        }
      }

      // Rocks: prefer steep / rocky faces and scattered boulders near the coast.
      if ((slope > 0.36 && slope < 1.1) || rad > LAND_R - 18) {
        if (rng() < 0.08 && roadW < 0.1) {
          rocks.push({
            x,
            y: h,
            z,
            s: 0.5 + rng() * 1.3,
            rot: rng() * Math.PI * 2,
          });
          continue;
        }
      }

      // Grass tufts: flat-ish grassland, sparse on roads.
      if (slope < 0.3 && roadW < 0.12 && h > WATER_LEVEL + 1.2) {
        if (rng() < 0.5) {
          grass.push({
            x,
            y: h,
            z,
            s: 0.6 + rng() * 0.8,
            rot: rng() * Math.PI * 2,
          });
        }
      }
    }
  }

  return { trees, rocks, grass };
}

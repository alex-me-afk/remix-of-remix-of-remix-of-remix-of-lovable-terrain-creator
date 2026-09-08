// Exact terrain-surface sampling shared by the mesh builder and every prop
// scatterer, so nothing can float above (or sink under) the rendered ground.

import { HALF, LAND_R, WORLD } from "./model";
import type { Grids } from "./bake";

/** extra depth carved outside the coast line (must match the mesh builder) */
export function coastDrop(x: number, z: number) {
  const rad = Math.hypot(x, z);
  if (rad <= LAND_R - 14) return 0;
  const t = Math.min(1, (rad - (LAND_R - 14)) / 70);
  return t * t * 14;
}

/** bilinear read of the heightfield, including the coastal drop */
export function terrainHeight(grids: Grids, x: number, z: number) {
  const n = grids.n;
  const u = (x + HALF) / WORLD;
  const v = (z + HALF) / WORLD;
  const fx = Math.min(n - 1, Math.max(0, u * (n - 1)));
  const fy = Math.min(n - 1, Math.max(0, v * (n - 1)));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = grids.height[y0 * n + x0]!;
  const b = grids.height[y0 * n + x1]!;
  const c = grids.height[y1 * n + x0]!;
  const d = grids.height[y1 * n + x1]!;
  const h = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  return h - coastDrop(x, z);
}

/**
 * Height of the *rendered triangle* under (x, z). The ground mesh is a
 * `segments x segments` plane, so its faces sit below the smooth heightfield in
 * every concave cell — sampling the field alone is what makes rocks look like
 * they hover. This reproduces the exact triangle the exporter writes out.
 */
export function meshSurfaceHeight(grids: Grids, x: number, z: number, segments: number) {
  const cell = WORLD / segments;
  const gx = Math.min(segments - 1e-6, Math.max(0, (x + HALF) / cell));
  const gz = Math.min(segments - 1e-6, Math.max(0, (z + HALF) / cell));
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const tx = gx - ix;
  const tz = gz - iz;

  const px = (i: number) => -HALF + i * cell;
  const ha = terrainHeight(grids, px(ix), px(iz)); // (0,0)
  const hb = terrainHeight(grids, px(ix), px(iz + 1)); // (0,1)
  const hc = terrainHeight(grids, px(ix + 1), px(iz + 1)); // (1,1)
  const hd = terrainHeight(grids, px(ix + 1), px(iz)); // (1,0)

  // PlaneGeometry splits each quad along the b–d diagonal.
  return tx + tz <= 1
    ? ha + (hd - ha) * tx + (hb - ha) * tz
    : hc + (hb - hc) * (1 - tx) + (hd - hc) * (1 - tz);
}

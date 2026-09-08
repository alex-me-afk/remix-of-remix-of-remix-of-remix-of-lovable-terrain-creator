// Procedural BR-style island.
// The map is 1500 x 1500 units (1 unit = 1 metre) with an outer water ring.
// The island is split into three regions that blend into each other:
//   0. Highlands  - the original rolling walkable hills (unchanged style)
//   1. Mesa plateau - a raised tier with flat mesa tops and steeper edges
//   2. Sunken basin - a lower tier with wetlands / lakes and small mounds
// Underground tunnels connect the regions.

import { clamp, fbm, lerp, makeRng, smoothstep } from "./noise";

export const WORLD = 1500; // map is 1500 x 1500 units (3x the original 500)
export const HALF = WORLD / 2; // 750
export const WATER_RING = 200; // outer 200 units are water
export const LAND_R = HALF - WATER_RING; // 550 -> land radius
export const WATER_LEVEL = 1.5;
export const BASE_LAND = 6; // plain elevation above sea level
export const ROAD_HALF_WIDTH = 5.5;
export const ROAD_SHOULDER = 9;

/** eye height of the player used by the first-person walk mode */
export const PLAYER_EYE = 1.8;

export type Hill = {
  x: number;
  z: number;
  r: number;
  h: number;
  /** fraction of the radius that stays perfectly flat (build pad on top) */
  flat: number;
};

export type Seg = {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  h1: number;
  h2: number;
  len2: number;
  /** half width of the carriageway in metres */
  half: number;
  /** true for unpaved dirt tracks, false for the paved network */
  dirt: boolean;
};


export type Tunnel = {
  /** centreline points, ground (floor) level is constant along the tunnel */
  pts: [number, number][];
  floor: number;
  radius: number;
  /** portal (entrance) positions at both ends */
  portals: [number, number][];
};

/**
 * Measured footprints (metres) of the imported building models. Filled in from
 * the real GLB bounding boxes once they load, so the terrain carves level
 * ground that matches each model at its original scale.
 */
export const BUILDING_FOOTPRINTS: Record<string, { w: number; d: number; h: number }> = {
  BROKEN_HOUSE: { w: 16.6, d: 22.9, h: 12.0 },
  VILLA_3_FLOORS: { w: 27.2, d: 20.8, h: 14.0 },
  BIG_TOWER_5_FLOORS: { w: 10.7, d: 10.7, h: 18.2 },
  STONE_HOUSE_2_FLOORS: { w: 10.2, d: 11.8, h: 7.7 },
  PLASTER_HOUSE_2_FLOORS: { w: 19.2, d: 13.2, h: 8.5 },
  DUBPLEX_2_FLOORS: { w: 15.6, d: 12.4, h: 8.7 },
  WOODEN_SHACK: { w: 8.3, d: 6.8, h: 3.7 },
  WOODEN_WATCH_POST: { w: 6.0, d: 6.0, h: 9.0 },
  THE_CLOCK_TOWER: { w: 65.2, d: 65.2, h: 35.4 },
  FACTORYY: { w: 63.2, d: 84.3, h: 14.2 },
};

/** replaces a footprint with the real measured size of the loaded model */
export function setBuildingFootprint(kind: string, f: { w: number; d: number; h: number }) {
  BUILDING_FOOTPRINTS[kind] = f;
}

export const HOUSE_KINDS = [
  "BROKEN_HOUSE",
  "VILLA_3_FLOORS",
  "BIG_TOWER_5_FLOORS",
  "STONE_HOUSE_2_FLOORS",
  "PLASTER_HOUSE_2_FLOORS",
  "DUBPLEX_2_FLOORS",
  "WOODEN_SHACK",
  "WOODEN_WATCH_POST",
];
/** used exactly once each on the whole map */
export const LANDMARK_KINDS = ["THE_CLOCK_TOWER", "FACTORYY"];

/** footprint radius of a building kind (with a small walking margin) */
export function buildingRadius(kind: string) {
  const f = BUILDING_FOOTPRINTS[kind] ?? { w: 10, d: 10, h: 6 };
  return Math.hypot(f.w, f.d) / 2 + 2.5;
}

/** a flattened plateau carved into the terrain for a settlement or landmark */
export type Site = {
  x: number;
  z: number;
  /** ground level of the plateau */
  y: number;
  /** radius that is perfectly flat */
  flat: number;
  /** radius where the plateau has fully blended back into the terrain */
  r: number;
};

/** one building instance to drop onto the map */
export type BuildingSlot = {
  kind: string;
  x: number;
  z: number;
  y: number;
  /** y-axis rotation in radians */
  rot: number;
};


/** region centre angles, in radians */
const REGION_ANGLES = [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6];
/** base elevation offset for each region */
const REGION_BASE = [0, 46, -9];

function angDiff(a: number, b: number) {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/** smooth blend weights of the three regions at a world position */
export function regionWeights(x: number, z: number): [number, number, number] {
  const a = Math.atan2(z, x);
  const r = Math.hypot(x, z);
  // near the centre everything melts together
  const centreBlend = smoothstep(0, 150, r);
  const w: number[] = [0, 0, 0];
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const d = angDiff(a, REGION_ANGLES[i]!);
    const v = Math.pow(Math.max(0, 1 - d / (Math.PI * 0.75)), 3) + 1e-4;
    w[i] = v;
    sum += v;
  }
  const out: [number, number, number] = [w[0]! / sum, w[1]! / sum, w[2]! / sum];
  // blend toward an even mix at the island centre
  for (let i = 0; i < 3; i++) out[i] = lerp(1 / 3, out[i]!, centreBlend) as number;
  return out;
}

export class TerrainModel {
  seed: number;
  hills: Hill[] = [];
  segs: Seg[] = [];
  tunnels: Tunnel[] = [];
  /** flat plateau centers usable for houses/POIs */
  pads: { x: number; z: number; y: number; r: number }[] = [];
  /** carved settlement / landmark plateaus */
  sites: Site[] = [];
  /** every building instance placed on the map */
  buildings: BuildingSlot[] = [];

  /** uniform grid acceleration structure over `segs` */
  private cell = 60;
  private buckets = new Map<number, number[]>();

  constructor(seed: number) {
    this.seed = seed;
    const rng = makeRng(seed);
    this.buildHills(rng);
    this.buildRoads(rng);
    this.indexRoads();
    this.buildTunnels(rng);
    this.buildSettlements(rng);
  }


  private regionPoint(region: number, rng: () => number, rMin: number, rMax: number) {
    const spread = Math.PI * 0.52;
    const a = REGION_ANGLES[region]! + (rng() - 0.5) * 2 * spread;
    const rad = lerp(rMin, rMax, Math.sqrt(rng()));
    return { x: Math.cos(a) * rad, z: Math.sin(a) * rad };
  }

  private tryPlace(x: number, z: number, r: number, h: number, flat: number) {
    for (const hill of this.hills) {
      const d = Math.hypot(hill.x - x, hill.z - z);
      if (d < (hill.r + r) * 0.55) return false;
    }
    this.hills.push({ x, z, r, h, flat });
    this.pads.push({ x, z, y: 0, r: r * flat * 0.9 });
    return true;
  }

  private buildHills(rng: () => number) {
    // --- Region 0: the original rolling walkable hills (scaled up in count) ---
    const classic: { count: number; rMin: number; rMax: number; slope: number }[] = [
      { count: 6, rMin: 62, rMax: 95, slope: 0.2 },
      { count: 10, rMin: 34, rMax: 55, slope: 0.22 },
      { count: 12, rMin: 16, rMax: 28, slope: 0.2 },
    ];
    for (const t of classic) {
      for (let i = 0; i < t.count; i++) {
        for (let tries = 0; tries < 50; tries++) {
          const p = this.regionPoint(0, rng, 40, LAND_R - 70);
          const r = lerp(t.rMin, t.rMax, rng());
          const height = r * t.slope * lerp(0.85, 1.15, rng());
          if (this.tryPlace(p.x, p.z, r, height, lerp(0.3, 0.45, rng()))) break;
        }
      }
    }

    // --- Region 1: mesa plateau - wide flat tops, taller, steeper flanks ---
    const mesas: { count: number; rMin: number; rMax: number; slope: number }[] = [
      { count: 5, rMin: 85, rMax: 130, slope: 0.26 },
      { count: 7, rMin: 45, rMax: 70, slope: 0.3 },
      { count: 8, rMin: 20, rMax: 34, slope: 0.24 },
    ];
    for (const t of mesas) {
      for (let i = 0; i < t.count; i++) {
        for (let tries = 0; tries < 50; tries++) {
          const p = this.regionPoint(1, rng, 60, LAND_R - 80);
          const r = lerp(t.rMin, t.rMax, rng());
          const height = r * t.slope * lerp(0.9, 1.2, rng());
          if (this.tryPlace(p.x, p.z, r, height, lerp(0.5, 0.68, rng()))) break;
        }
      }
    }

    // --- Region 2: sunken basin - low mounds and islets in the wetlands ---
    const mounds: { count: number; rMin: number; rMax: number; slope: number }[] = [
      { count: 4, rMin: 55, rMax: 90, slope: 0.1 },
      { count: 9, rMin: 22, rMax: 42, slope: 0.13 },
    ];
    for (const t of mounds) {
      for (let i = 0; i < t.count; i++) {
        for (let tries = 0; tries < 50; tries++) {
          const p = this.regionPoint(2, rng, 60, LAND_R - 70);
          const r = lerp(t.rMin, t.rMax, rng());
          const height = r * t.slope * lerp(0.8, 1.2, rng());
          if (this.tryPlace(p.x, p.z, r, height, lerp(0.4, 0.6, rng()))) break;
        }
      }
    }
  }

  /** region base elevation (raised mesa tier / sunken basin tier) */
  private regionBase(x: number, z: number) {
    const w = regionWeights(x, z);
    let b = 0;
    for (let i = 0; i < 3; i++) b += w[i]! * REGION_BASE[i]!;
    return b;
  }

  /** terrain before roads are carved into it */
  baseHeight(x: number, z: number) {
    const r = Math.hypot(x, z);
    const island = 1 - smoothstep(LAND_R - 60, LAND_R, r);
    if (island <= 0) return 0;

    let h = BASE_LAND + this.regionBase(x, z);
    // gentle rolling ground
    h += (fbm(x / 320, z / 320, this.seed, 4) - 0.5) * 14;
    h += (fbm(x / 105, z / 105, this.seed + 31, 4) - 0.5) * 4.5;

    for (const hill of this.hills) {
      const d = Math.hypot(x - hill.x, z - hill.z);
      if (d > hill.r) continue;
      const t = 1 - d / hill.r; // 0 at edge, 1 at center
      // flat top: reaches full height before the center -> buildable plateau
      const f = smoothstep(0, 1, clamp(t / (1 - hill.flat), 0, 1));
      h += hill.h * f;
    }
    return h * island;
  }

  private buildRoads(rng: () => number) {
    const pts: [number, number][][] = [];

    const ringAt = (baseR: number, n: number, noiseSeed: number, amp: number) => {
      const line: [number, number][] = [];
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr =
          baseR + (fbm(Math.cos(a) * 2 + 5, Math.sin(a) * 2 + 5, this.seed + noiseSeed, 3) - 0.5) * amp;
        line.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
      return line;
    };

    pts.push(ringAt(340, 56, 7, 70));
    pts.push(ringAt(190, 40, 11, 46));
    pts.push(ringAt(80, 24, 23, 22));

    // Radial spokes from the centre out to the coast
    const spokes = 9;
    const a0 = rng() * Math.PI * 2;
    for (let i = 0; i < spokes; i++) {
      const a = a0 + (i / spokes) * Math.PI * 2 + (rng() - 0.5) * 0.25;
      const line: [number, number][] = [];
      for (let d = 0; d <= LAND_R - 25; d += 16) {
        const wob = (fbm(d / 90, i * 10 + 3, this.seed + 53, 3) - 0.5) * 30 * smoothstep(0, 120, d);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        line.push([ca * d - sa * wob, sa * d + ca * wob]);
      }
      pts.push(line);
    }

    // Chord connectors between ring sections
    for (let i = 0; i < 8; i++) {
      const aa = rng() * Math.PI * 2;
      const bb = aa + lerp(1.1, 2.2, rng());
      const ra = lerp(200, 420, rng());
      const rb = lerp(200, 420, rng());
      const ax = Math.cos(aa) * ra;
      const az = Math.sin(aa) * ra;
      const bx = Math.cos(bb) * rb;
      const bz = Math.sin(bb) * rb;
      const line: [number, number][] = [];
      const steps = 14;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const bend = Math.sin(t * Math.PI) * lerp(-60, 60, rng() * 0.02 + 0.5);
        const nx = -(bz - az);
        const nz = bx - ax;
        const nl = Math.hypot(nx, nz) || 1;
        line.push([lerp(ax, bx, t) + (nx / nl) * bend, lerp(az, bz, t) + (nz / nl) * bend]);
      }
      pts.push(line);
    }

    // Convert polylines to height-sampled segments (roads ramp with the land)
    for (const line of pts) {
      // smooth the centerline elevation so roads are drivable ramps
      const hs = line.map(([x, z]) => this.baseHeight(x, z));
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 1; i < hs.length - 1; i++) {
          hs[i] = ((hs[i - 1] ?? 0) + (hs[i] ?? 0) * 2 + (hs[i + 1] ?? 0)) / 4;
        }
      }
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        if (!a || !b) continue;
        const [x1, z1] = a;
        const [x2, z2] = b;
        this.segs.push({
          x1,
          z1,
          x2,
          z2,
          h1: hs[i] ?? 0,
          h2: hs[i + 1] ?? 0,
          len2: (x2 - x1) ** 2 + (z2 - z1) ** 2 || 1e-6,
        });
      }
    }
  }

  /** bucket the road segments so nearest-road lookups stay fast on a 1500u map */
  private indexRoads() {
    const c = this.cell;
    this.segs.forEach((s, i) => {
      const minX = Math.floor(Math.min(s.x1, s.x2) / c) - 1;
      const maxX = Math.floor(Math.max(s.x1, s.x2) / c) + 1;
      const minZ = Math.floor(Math.min(s.z1, s.z2) / c) - 1;
      const maxZ = Math.floor(Math.max(s.z1, s.z2) / c) + 1;
      for (let gz = minZ; gz <= maxZ; gz++) {
        for (let gx = minX; gx <= maxX; gx++) {
          const key = gx * 100000 + gz;
          let arr = this.buckets.get(key);
          if (!arr) this.buckets.set(key, (arr = []));
          arr.push(i);
        }
      }
    });
  }

  /** underground tunnels linking the three regions */
  private buildTunnels(rng: () => number) {
    const mk = (
      ax: number,
      az: number,
      bx: number,
      bz: number,
      radius: number,
    ): Tunnel => {
      const steps = 8;
      const pts: [number, number][] = [];
      const nx = -(bz - az);
      const nz = bx - ax;
      const nl = Math.hypot(nx, nz) || 1;
      const bend = (rng() - 0.5) * 120;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const w = Math.sin(t * Math.PI) * bend;
        pts.push([lerp(ax, bx, t) + (nx / nl) * w, lerp(az, bz, t) + (nz / nl) * w]);
      }
      // floor sits below the lowest surface point along the path
      let lowest = Infinity;
      for (const [x, z] of pts) lowest = Math.min(lowest, this.baseHeight(x, z));
      const floor = Math.min(lowest - 14, WATER_LEVEL + 2);
      return { pts, floor, radius, portals: [pts[0]!, pts[pts.length - 1]!] };
    };

    const pick = (region: number, rMin: number, rMax: number) => {
      const p = this.regionPoint(region, rng, rMin, rMax);
      return p;
    };

    const a = pick(0, 150, 330);
    const b = pick(1, 150, 330);
    const c = pick(2, 150, 330);
    this.tunnels.push(mk(a.x, a.z, b.x, b.z, 6));
    this.tunnels.push(mk(b.x, b.z, c.x, c.z, 6));
    this.tunnels.push(mk(c.x, c.z, a.x, a.z, 5.5));
    // a short bunker tunnel inside the mesa region
    const d = pick(1, 90, 200);
    const e = pick(1, 220, 380);
    this.tunnels.push(mk(d.x, d.z, e.x, e.z, 5));
  }

  /** distance to the nearest tunnel centreline (and its floor level) */
  tunnelAt(x: number, z: number) {
    let best = Infinity;
    let floor = 0;
    let radius = 0;
    for (const t of this.tunnels) {
      for (let i = 0; i < t.pts.length - 1; i++) {
        const [x1, z1] = t.pts[i]!;
        const [x2, z2] = t.pts[i + 1]!;
        const len2 = (x2 - x1) ** 2 + (z2 - z1) ** 2 || 1e-6;
        const s = clamp(((x - x1) * (x2 - x1) + (z - z1) * (z2 - z1)) / len2, 0, 1);
        const d = Math.hypot(x - (x1 + (x2 - x1) * s), z - (z1 + (z2 - z1) * s));
        if (d < best) {
          best = d;
          floor = t.floor;
          radius = t.radius;
        }
      }
    }
    return { dist: best, floor, radius };
  }

  /** distance to the nearest tunnel portal mouth */
  portalAt(x: number, z: number) {
    let best = Infinity;
    let floor = 0;
    for (const t of this.tunnels) {
      for (const [px, pz] of t.portals) {
        const d = Math.hypot(x - px, z - pz);
        if (d < best) {
          best = d;
          floor = t.floor;
        }
      }
    }
    return { dist: best, floor };
  }

  /** distance to the closest road centerline + that road's elevation there */
  roadAt(x: number, z: number) {
    const c = this.cell;
    const gx = Math.floor(x / c);
    const gz = Math.floor(z / c);
    let best = Infinity;
    let bestH = 0;
    let found = false;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.buckets.get((gx + dx) * 100000 + (gz + dz));
        if (!arr) continue;
        for (const i of arr) {
          const s = this.segs[i]!;
          const t = clamp(((x - s.x1) * (s.x2 - s.x1) + (z - s.z1) * (s.z2 - s.z1)) / s.len2, 0, 1);
          const px = s.x1 + (s.x2 - s.x1) * t;
          const pz = s.z1 + (s.z2 - s.z1) * t;
          const d2 = (x - px) ** 2 + (z - pz) ** 2;
          if (d2 < best) {
            best = d2;
            bestH = lerp(s.h1, s.h2, t);
            found = true;
          }
        }
      }
    }
    if (!found) return { dist: Infinity, height: 0 };
    return { dist: Math.sqrt(best), height: bestH };
  }

  /** terrain before settlement plateaus are carved (roads + portals applied) */
  private preSiteHeight(x: number, z: number) {
    let h = this.baseHeight(x, z);
    const road = this.roadAt(x, z);
    if (road.dist < ROAD_HALF_WIDTH + ROAD_SHOULDER) {
      const t = 1 - smoothstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + ROAD_SHOULDER, road.dist);
      h = lerp(h, road.height, t);
    }
    const portal = this.portalAt(x, z);
    if (portal.dist < 46) {
      const t = 1 - smoothstep(10, 46, portal.dist);
      h = lerp(h, portal.floor - 0.2, t);
    }
    return h;
  }

  /** final terrain elevation: roads, portal mouths and settlement plateaus */
  height(x: number, z: number) {
    const r = Math.hypot(x, z);
    if (r > LAND_R + 5) return 0;
    let h = this.preSiteHeight(x, z);
    for (const s of this.sites) {
      const d = Math.hypot(x - s.x, z - s.z);
      if (d >= s.r) continue;
      const t = 1 - smoothstep(s.flat, s.r, d);
      h = lerp(h, s.y, t);
    }
    return h;
  }

  roadMask(x: number, z: number) {
    const d = this.roadAt(x, z).dist;
    return 1 - smoothstep(ROAD_HALF_WIDTH - 1.5, ROAD_HALF_WIDTH + 2.5, d);
  }

  // --- settlements ---------------------------------------------------------

  /** ground level + roughness of a disc, sampled on the pre-settlement terrain */
  private probe(x: number, z: number, radius: number) {
    let sum = 0;
    let lo = Infinity;
    let hi = -Infinity;
    let n = 0;
    for (let ring = 0; ring <= 2; ring++) {
      const rr = (radius * ring) / 2;
      const steps = ring === 0 ? 1 : 10;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const h = this.preSiteHeight(x + Math.cos(a) * rr, z + Math.sin(a) * rr);
        sum += h;
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
        n++;
      }
    }
    return { avg: sum / n, spread: hi - lo, lo };
  }

  /** is a disc free of tunnels, water, coast and other settlements? */
  private siteFree(x: number, z: number, r: number, maxSpread: number) {
    if (Math.hypot(x, z) + r > LAND_R - 45) return false;
    if (this.tunnelAt(x, z).dist < r + 25) return false;
    if (this.portalAt(x, z).dist < r + 55) return false;
    for (const s of this.sites) {
      if (Math.hypot(x - s.x, z - s.z) < s.r + r + 35) return false;
    }
    const p = this.probe(x, z, r * 0.85);
    if (p.avg < WATER_LEVEL + 5) return false;
    if (p.spread > maxSpread) return false;
    return true;
  }

  /** pick a spot near a road so settlements stay connected to the network */
  private roadSideSpot(rng: () => number, offset: number) {
    const s = this.segs[Math.floor(rng() * this.segs.length)];
    if (!s) return null;
    const t = rng();
    const px = lerp(s.x1, s.x2, t);
    const pz = lerp(s.z1, s.z2, t);
    const nx = -(s.z2 - s.z1);
    const nz = s.x2 - s.x1;
    const nl = Math.hypot(nx, nz) || 1;
    const side = rng() < 0.5 ? 1 : -1;
    return { x: px + (nx / nl) * offset * side, z: pz + (nz / nl) * offset * side };
  }

  /** carve plateaus and lay out the imported buildings on them */
  private buildSettlements(rng: () => number) {
    const addSite = (x: number, z: number, flat: number, r: number) => {
      const y = Math.max(WATER_LEVEL + 4.5, this.probe(x, z, flat).avg);
      const site: Site = { x, z, y, flat, r };
      this.sites.push(site);
      this.pads.push({ x, z, y, r: flat });
      return site;
    };

    // --- the two landmarks: clock tower district and factory ---------------
    for (const kind of LANDMARK_KINDS) {
      const f = BUILDING_FOOTPRINTS[kind]!;
      const flat = Math.hypot(f.w, f.d) / 2 + 10;
      const r = flat + 60;
      for (let tries = 0; tries < 400; tries++) {
        const spot = this.roadSideSpot(rng, flat + lerp(10, 40, rng()));
        if (!spot) break;
        if (!this.siteFree(spot.x, spot.z, r, 34)) continue;
        const site = addSite(spot.x, spot.z, flat, r);
        this.buildings.push({
          kind,
          x: site.x,
          z: site.z,
          y: site.y,
          rot: Math.floor(rng() * 4) * (Math.PI / 2) + (rng() - 0.5) * 0.25,
        });
        break;
      }
    }

    // --- villages: 5 clusters of 4-7 houses on one shared plateau ----------
    const villages = 5;
    for (let v = 0; v < villages; v++) {
      const count = 4 + Math.floor(rng() * 4);
      const kinds: string[] = [];
      for (let i = 0; i < count; i++) {
        const k = HOUSE_KINDS[Math.floor(rng() * HOUSE_KINDS.length)]!;
        kinds.push(k);
        // sometimes a matching pair of the same kind side by side
        if (i < count - 1 && rng() < 0.35) {
          kinds.push(k);
          i++;
        }
      }
      let area = 0;
      for (const k of kinds) area += Math.PI * buildingRadius(k) ** 2;
      const flat = Math.sqrt(area / Math.PI) * 1.85 + 16;
      const r = flat + 55;

      let site: Site | null = null;
      for (let tries = 0; tries < 400; tries++) {
        const spot = this.roadSideSpot(rng, flat + lerp(6, 30, rng()));
        if (!spot) break;
        if (!this.siteFree(spot.x, spot.z, r, 30)) continue;
        site = addSite(spot.x, spot.z, flat, r);
        break;
      }
      if (!site) continue;

      const placed: { x: number; z: number; rad: number }[] = [];
      for (const kind of kinds) {
        const rad = buildingRadius(kind);
        for (let tries = 0; tries < 120; tries++) {
          const a = rng() * Math.PI * 2;
          const dist = Math.sqrt(rng()) * Math.max(0, flat - rad - 6);
          const x = site.x + Math.cos(a) * dist;
          const z = site.z + Math.sin(a) * dist;
          let clear = true;
          for (const p of placed) {
            if (Math.hypot(p.x - x, p.z - z) < p.rad + rad + 4) {
              clear = false;
              break;
            }
          }
          if (!clear) continue;
          placed.push({ x, z, rad });
          // face the village centre, snapped loosely so rows look intentional
          const face = Math.atan2(site.x - x, site.z - z);
          this.buildings.push({
            kind,
            x,
            z,
            y: site.y,
            rot: face + (rng() - 0.5) * 0.3,
          });
          break;
        }
      }
    }

    // --- lone outposts: single buildings on their own small pad ------------
    for (let i = 0; i < 7; i++) {
      const kind = HOUSE_KINDS[Math.floor(rng() * HOUSE_KINDS.length)]!;
      const rad = buildingRadius(kind);
      const flat = rad + 9;
      const r = flat + 34;
      for (let tries = 0; tries < 300; tries++) {
        const spot = this.roadSideSpot(rng, flat + lerp(4, 26, rng()));
        if (!spot) break;
        if (!this.siteFree(spot.x, spot.z, r, 26)) continue;
        const site = addSite(spot.x, spot.z, flat, r);
        this.buildings.push({
          kind,
          x: site.x,
          z: site.z,
          y: site.y,
          rot: rng() * Math.PI * 2,
        });
        break;
      }
    }
  }
}


// Loads the uploaded building GLBs and places them on the carved flat sites.
// Models are used at their ORIGINAL scale — never resized.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { setBuildingFootprint, type TerrainModel } from "./model";
import type { Grids } from "./bake";
import { meshSurfaceHeight } from "./surface";

import BROKEN_HOUSE from "@/assets/BROKEN_HOUSE.glb.asset.json";
import VILLA_3_FLOORS from "@/assets/VILLA_3_FLOORS.glb.asset.json";
import BIG_TOWER_5_FLOORS from "@/assets/BIG_TOWER_5_FLOORS.glb.asset.json";
import STONE_HOUSE_2_FLOORS from "@/assets/STONE_HOUSE_2_FLOORS.glb.asset.json";
import PLASTER_HOUSE_2_FLOORS from "@/assets/PLASTER_HOUSE_2_FLOORS.glb.asset.json";
import DUBPLEX_2_FLOORS from "@/assets/DUBPLEX_2_FLOORS.glb.asset.json";
import WOODEN_SHACK from "@/assets/WOODEN_SHACK.glb.asset.json";
import WOODEN_WATCH_POST from "@/assets/WOODEN_WATCH_POST.glb.asset.json";
import THE_CLOCK_TOWER from "@/assets/THE_CLOCK_TOWER.glb.asset.json";
import FACTORYY from "@/assets/FACTORYY.glb.asset.json";

export const BUILDING_URLS: Record<string, string> = {
  BROKEN_HOUSE: BROKEN_HOUSE.url,
  VILLA_3_FLOORS: VILLA_3_FLOORS.url,
  BIG_TOWER_5_FLOORS: BIG_TOWER_5_FLOORS.url,
  STONE_HOUSE_2_FLOORS: STONE_HOUSE_2_FLOORS.url,
  PLASTER_HOUSE_2_FLOORS: PLASTER_HOUSE_2_FLOORS.url,
  DUBPLEX_2_FLOORS: DUBPLEX_2_FLOORS.url,
  WOODEN_SHACK: WOODEN_SHACK.url,
  WOODEN_WATCH_POST: WOODEN_WATCH_POST.url,
  THE_CLOCK_TOWER: THE_CLOCK_TOWER.url,
  FACTORYY: FACTORYY.url,
};

export type BuildingTemplate = {
  /** flattened geometry list, already centred on x/z with its base at y = 0 */
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[];
  w: number;
  d: number;
  h: number;
};

export type BuildingTemplates = Record<string, BuildingTemplate>;

/**
 * Bakes a loaded GLB scene into world-space geometry, keeping the model's own
 * scale untouched; only recentres it horizontally and drops its base to y = 0.
 */
function toTemplate(root: THREE.Object3D): BuildingTemplate {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const ox = -(box.min.x + box.max.x) / 2;
  const oz = -(box.min.z + box.max.z) / 2;
  const oy = -box.min.y;

  const parts: BuildingTemplate["parts"] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry.clone();
    geo.applyMatrix4(m.matrixWorld);
    geo.translate(ox, oy, oz);
    const mat = Array.isArray(m.material) ? (m.material[0] as THREE.Material) : (m.material as THREE.Material);
    parts.push({ geometry: geo, material: mat });
  });

  return { parts, w: size.x, d: size.z, h: size.y };
}

/** Loads every building GLB once and registers its real footprint. */
export async function loadBuildingTemplates(
  onProgress?: (label: string) => void,
): Promise<BuildingTemplates> {
  const loader = new GLTFLoader();
  const out: BuildingTemplates = {};
  const entries = Object.entries(BUILDING_URLS);
  let i = 0;
  for (const [kind, url] of entries) {
    i++;
    onProgress?.(`Loading buildings ${i}/${entries.length} · ${kind.replaceAll("_", " ")}…`);
    const gltf = await loader.loadAsync(url);
    const tpl = toTemplate(gltf.scene);
    out[kind] = tpl;
    setBuildingFootprint(kind, { w: tpl.w, d: tpl.d, h: tpl.h });
  }
  return out;
}

/**
 * Instances every planned building on the map. Each one is dropped onto the
 * lowest rendered ground point under its own footprint, so no building floats
 * and none of them sinks a corner into a hill.
 */
export function buildBuildings(
  model: TerrainModel,
  templates: BuildingTemplates,
  grids: Grids,
  segments: number,
) {
  const group = new THREE.Group();
  group.name = "Buildings";
  if (!model.buildings.length) return group;

  const byKind = new Map<string, typeof model.buildings>();
  for (const b of model.buildings) {
    const arr = byKind.get(b.kind);
    if (arr) arr.push(b);
    else byKind.set(b.kind, [b]);
  }

  const dummy = new THREE.Object3D();
  for (const [kind, slots] of byKind) {
    const tpl = templates[kind];
    if (!tpl) continue;
    const hw = tpl.w / 2;
    const hd = tpl.d / 2;

    // ground each instance on the lowest corner of its own footprint
    for (const b of slots) {
      const c = Math.cos(b.rot);
      const s = Math.sin(b.rot);
      let lowest = Infinity;
      for (const [lx, lz] of [
        [0, 0],
        [-hw, -hd],
        [hw, -hd],
        [-hw, hd],
        [hw, hd],
        [0, -hd],
        [0, hd],
        [-hw, 0],
        [hw, 0],
      ] as [number, number][]) {
        const wx = b.x + lx * c + lz * s;
        const wz = b.z - lx * s + lz * c;
        lowest = Math.min(lowest, meshSurfaceHeight(grids, wx, wz, segments));
      }
      // sink a few centimetres so the floor never hovers over the ground
      b.y = lowest - 0.08;
    }

    tpl.parts.forEach((part, pi) => {
      const inst = new THREE.InstancedMesh(part.geometry, part.material, slots.length);
      inst.name = `${kind}${pi ? `_${pi}` : ""}`;
      slots.forEach((b, i) => {
        dummy.position.set(b.x, b.y, b.z);
        dummy.rotation.set(0, b.rot, 0);
        dummy.scale.setScalar(1); // original game scale — never resized
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = false;
      inst.frustumCulled = false;
      group.add(inst);
    });
  }
  return group;
}

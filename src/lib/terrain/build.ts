// Builds the three.js meshes (terrain + water disc + tunnels + vegetation)
// from the terrain model.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { HALF, LAND_R, TerrainModel, WATER_LEVEL, WORLD } from "./model";
import {
  bakeNormalMap,
  buildGrids,
  loadImageData,
  loadTexSet,
  type Grids,
} from "./bake";
import { buildTiledTerrain } from "./splat";
import { generateScatter, type Placement, type Scatter } from "./vegetation";
import { meshSurfaceHeight, terrainHeight } from "./surface";



export type VegKind = "trees" | "rocks" | "grass";
/** custom GLB templates that replace the procedural props */
export type VegTemplates = Partial<Record<VegKind, THREE.Object3D>>;

export type BuildResult = {
  group: THREE.Group;
  model: TerrainModel;
  grids: Grids;
  /** ground mesh resolution, needed to snap props to the exact rendered surface */
  segments: number;

  vegetation: THREE.Group;
  scatter: Scatter;
  stats: {
    vertices: number;
    triangles: number;
    hills: number;
    roadSegments: number;
    pads: number;
    tunnels: number;
    trees: number;
    rocks: number;
    grass: number;
  };
};




/** how deep each prop kind is pushed into the ground (world units) */
const SINK: Record<VegKind, number> = { trees: 0.25, rocks: 0.35, grass: 0.06 };

/**
 * Clamps every placement onto the exact rendered triangle beneath it and sinks
 * it slightly, so no prop can float once the mesh is exported.
 */
export function snapScatter(scatter: Scatter, grids: Grids, segments: number) {
  (Object.keys(SINK) as VegKind[]).forEach((kind) => {
    for (const p of scatter[kind]) {
      p.y = meshSurfaceHeight(grids, p.x, p.z, segments) - SINK[kind];
    }
  });
  return scatter;
}

/** max height a prop sits above the ground mesh — 0 means nothing floats */
export function maxFloatGap(scatter: Scatter, grids: Grids, segments: number) {
  let worst = 0;
  for (const kind of ["trees", "rocks", "grass"] as VegKind[]) {
    for (const p of scatter[kind]) {
      worst = Math.max(worst, p.y - meshSurfaceHeight(grids, p.x, p.z, segments));
    }
  }
  return worst;
}


export async function buildIsland(
  seed: number,
  opts: { segments?: number; templates?: VegTemplates } = {},
  onProgress?: (label: string) => void,
): Promise<BuildResult> {
  const segments = opts.segments ?? 512;


  onProgress?.("Generating regions, hills & roads…");
  const model = new TerrainModel(seed);
  await frame();

  onProgress?.("Sampling heightfield…");
  const grids = buildGrids(model, 769);
  await frame();

  onProgress?.("Loading textures…");
  const [tex, waterImg] = await Promise.all([loadTexSet(512), loadImageData("/textures/water.jpg", 512)]);
  await frame();

  onProgress?.("Deriving detail normal map…");
  // One shared high-frequency detail normal, tiled across the terrain UVs.
  const detailSrc = document.createElement("canvas");
  detailSrc.width = detailSrc.height = 512;
  detailSrc.getContext("2d")!.putImageData(tex.rock, 0, 0);
  const normalCanvas = bakeNormalMap(detailSrc, 512, 3.2);
  await frame();

  onProgress?.("Building meshes…");
  const GROUND_TILES = 110; // texture repeats across the whole map
  const normalMap = new THREE.CanvasTexture(normalCanvas);
  normalMap.anisotropy = 16;
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat.set(GROUND_TILES, GROUND_TILES);

  // Tiling materials instead of one baked mega-atlas: five 512px textures
  // (~4 MB VRAM) instead of a unique 4096 albedo (~90 MB).
  const ground = buildTiledTerrain(model, grids, segments, tex, normalMap, GROUND_TILES);
  const geo = ground.geometry;



  // Water disc covering the outer ring (and the sea floor beyond the shore)
  const waterCanvas = document.createElement("canvas");
  waterCanvas.width = waterCanvas.height = 512;
  waterCanvas.getContext("2d")!.putImageData(waterImg, 0, 0);
  const waterTex = new THREE.CanvasTexture(waterCanvas);
  waterTex.colorSpace = THREE.SRGBColorSpace;
  waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping;
  waterTex.repeat.set(70, 70);
  const waterNormal = new THREE.CanvasTexture(bakeNormalMap(waterCanvas, 512, 3));
  waterNormal.wrapS = waterNormal.wrapT = THREE.RepeatWrapping;
  waterNormal.repeat.set(70, 70);

  const waterGeo = new THREE.CircleGeometry(HALF, 200);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(
    waterGeo,
    new THREE.MeshPhysicalMaterial({
      color: 0x2b7a9e,
      map: waterTex,
      normalMap: waterNormal,
      normalScale: new THREE.Vector2(1.2, 1.2),
      roughness: 0.12,
      metalness: 0.05,
      transmission: 0.25,
      thickness: 2.0,
      ior: 1.33,
      transparent: true,
      opacity: 0.88,
    }),
  );
  water.name = "Water";
  water.position.y = WATER_LEVEL;

  onProgress?.("Digging tunnels…");
  const tunnels = buildTunnels(model);

  onProgress?.("Scattering vegetation…");
  const scatter = snapScatter(generateScatter(model, grids, seed), grids, segments);
  await frame();
  const vegetation = buildVegetation(scatter, opts.templates);

  const group = new THREE.Group();
  group.name = `BR_Island_${seed}`;
  group.add(ground, water, tunnels, vegetation);

  const tri = (geo.index?.count ?? 0) / 3;
  return {
    group,
    model,
    grids,
    segments,
    vegetation,
    scatter,

    stats: {
      vertices: (geo.attributes['position'] as THREE.BufferAttribute).count,
      triangles: tri,
      hills: model.hills.length,
      roadSegments: model.segs.length,
      pads: model.pads.length,
      tunnels: model.tunnels.length,
      trees: scatter.trees.length,
      rocks: scatter.rocks.length,
      grass: scatter.grass.length,
    },
  };
}

function frame() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

// --- Tunnels ---------------------------------------------------------------

function buildTunnels(model: TerrainModel) {
  const group = new THREE.Group();
  group.name = "Tunnels";
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x6a6560,
    roughness: 0.98,
    metalness: 0,
    side: THREE.DoubleSide,
    flatShading: true,
  });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x4b4744, roughness: 1 });

  for (const t of model.tunnels) {
    const curve = new THREE.CatmullRomCurve3(
      t.pts.map(([x, z]) => new THREE.Vector3(x, t.floor + t.radius * 0.75, z)),
    );
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 120, t.radius, 14, false),
      wallMat,
    );
    tube.name = "TunnelShell";
    group.add(tube);

    // walkable floor strip inside the tube
    const pts = curve.getSpacedPoints(120);
    const positions: number[] = [];
    const w = t.radius * 0.8;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[Math.min(pts.length - 1, i + 1)]!;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l;
      const nz = dx / l;
      positions.push(p.x + nx * w, t.floor, p.z + nz * w, p.x - nx * w, t.floor, p.z - nz * w);
    }
    const idx: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    fg.setIndex(idx);
    fg.computeVertexNormals();
    const floor = new THREE.Mesh(fg, floorMat);
    floor.name = "TunnelFloor";
    group.add(floor);
  }
  return group;
}

// --- Vegetation mesh building (instanced for performance) ---

function colorGeometry(geo: THREE.BufferGeometry, hex: number) {
  const col = new THREE.Color(hex);
  const pos = geo.attributes['position'] as THREE.BufferAttribute;
  const count = pos.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = col.r;
    arr[i * 3 + 1] = col.g;
    arr[i * 3 + 2] = col.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

function buildTreeGeometry() {
  const trunk = colorGeometry(
    new THREE.CylinderGeometry(0.32, 0.55, 3.4, 6).translate(0, 1.7, 0),
    0x6b4a2b,
  );
  const foliage = colorGeometry(
    new THREE.ConeGeometry(2.1, 4.6, 8).translate(0, 5.4, 0),
    0x2f5d2a,
  );
  const top = colorGeometry(
    new THREE.ConeGeometry(1.5, 3.2, 8).translate(0, 7.3, 0),
    0x3a7032,
  );
  return mergeGeometries([trunk, foliage, top], false)!;
}

function buildGrassGeometry() {
  const makeBlade = (rot: number) => {
    const g = new THREE.PlaneGeometry(0.55, 1.4).translate(0, 0.7, 0);
    g.rotateY(rot);
    const pos = g.attributes['position'] as THREE.BufferAttribute;
    const count = pos.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const y = pos.getY(i);
      const t = THREE.MathUtils.clamp(y / 1.4, 0, 1);
      // darker near the ground, lighter at the tip
      colors[i * 3] = 0.18 + t * 0.16;
      colors[i * 3 + 1] = 0.32 + t * 0.24;
      colors[i * 3 + 2] = 0.12 + t * 0.08;
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return g;
  };
  return mergeGeometries([makeBlade(0), makeBlade(Math.PI / 2)], false)!;
}

/**
 * Instances an arbitrary loaded GLB object at every placement, keeping the
 * exact position / rotation / scale of the props it replaces.
 */
function instanceTemplate(
  template: THREE.Object3D,
  placements: Placement[],
  name: string,
  /** height in metres of the procedural prop being replaced, so the new asset
   *  lands at exactly the same size */
  baseHeight: number,
) {
  const group = new THREE.Group();
  group.name = name;
  template.updateMatrixWorld(true);

  // normalise the template so its base sits on y=0 and it is ~1 unit tall,
  // letting the existing per-placement scale drive the final size.
  const box = new THREE.Box3().setFromObject(template);
  const size = new THREE.Vector3();
  box.getSize(size);
  const norm = size.y > 1e-4 ? 1 / size.y : 1;
  const offset = new THREE.Vector3(
    -(box.min.x + box.max.x) / 2,
    -box.min.y,
    -(box.min.z + box.max.z) / 2,
  );

  const dummy = new THREE.Object3D();
  template.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry.clone();
    geo.applyMatrix4(m.matrixWorld);
    geo.translate(offset.x, offset.y, offset.z);
    geo.scale(norm, norm, norm);
    const mat = Array.isArray(m.material)
      ? (m.material[0] as THREE.Material)
      : (m.material as THREE.Material);
    const inst = new THREE.InstancedMesh(geo, mat, placements.length);
    placements.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(p.s * baseHeight);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    group.add(inst);
  });
  return group;
}

export function buildVegetation(scatter: Scatter, templates: VegTemplates = {}) {
  const group = new THREE.Group();
  group.name = "Vegetation";

  const dummy = new THREE.Object3D();

  // Trees
  if (scatter.trees.length) {
    if (templates.trees) {
      group.add(instanceTemplate(templates.trees, scatter.trees, "Trees", 8.6));
    } else {
      const geo = buildTreeGeometry();
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.92,
        metalness: 0,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, scatter.trees.length);
      mesh.name = "Trees";
      scatter.trees.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(p.s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }

  // Rocks
  if (scatter.rocks.length) {
    if (templates.rocks) {
      group.add(instanceTemplate(templates.rocks, scatter.rocks, "Rocks", 2));
    } else {
      const geo = new THREE.IcosahedronGeometry(1, 0);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x8a8a86,
        roughness: 0.95,
        metalness: 0.05,
        flatShading: true,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, scatter.rocks.length);
      mesh.name = "Rocks";
      scatter.rocks.forEach((p, i) => {
        dummy.position.set(p.x, p.y - p.s * 0.2, p.z);
        dummy.rotation.set(p.rot * 0.4, p.rot, p.rot * 0.3);
        dummy.scale.set(p.s * 0.9, p.s, p.s * 1.1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }

  // Grass tufts
  if (scatter.grass.length) {
    if (templates.grass) {
      group.add(instanceTemplate(templates.grass, scatter.grass, "Grass", 1.4));
    } else {
      const geo = buildGrassGeometry();
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.9,
        metalness: 0,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, scatter.grass.length);
      mesh.name = "Grass";
      scatter.grass.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(p.s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }

  return group;
}

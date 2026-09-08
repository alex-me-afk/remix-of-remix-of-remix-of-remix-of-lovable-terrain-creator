// Helpers that prepare the scene graph for a clean, engine-friendly GLB export.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Replaces every InstancedMesh with a single merged mesh (one draw call, no
 * glTF extension required). Use this for engines that don't understand
 * EXT_mesh_gpu_instancing; the instanced path stays smaller but needs support.
 */
export function bakeInstancesForExport(root: THREE.Object3D) {
  const clone = root.clone(true);
  const doomed: THREE.InstancedMesh[] = [];

  clone.traverse((o) => {
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh) doomed.push(inst);
  });

  for (const inst of doomed) {
    const parent = inst.parent;
    if (!parent) continue;
    const m = new THREE.Matrix4();
    const geos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, m);
      const g = inst.geometry.clone();
      g.applyMatrix4(m);
      geos.push(g);
    }
    inst.removeFromParent();
    if (!geos.length) continue;
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, inst.material as THREE.Material);
    mesh.name = inst.name || "MergedInstances";
    parent.add(mesh);
  }
  return clone;
}

/** Strips viewer-only helpers and non-exportable material features. */
export function cleanForExport(root: THREE.Object3D) {
  root.traverse((o) => {
    o.castShadow = false;
    o.receiveShadow = false;
    o.frustumCulled = true;
  });
  return root;
}

export function countExportMeshes(root: THREE.Object3D) {
  let meshes = 0;
  let triangles = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
    if (!m.isMesh) return;
    meshes++;
    const g = m.geometry;
    const tris = (g.index ? g.index.count : (g.attributes['position']?.count ?? 0)) / 3;
    triangles += tris * (m.isInstancedMesh ? (m.count ?? 1) : 1);
  });
  return { meshes, triangles: Math.round(triangles) };
}

// --- export budget estimate -------------------------------------------------

export type ExportBudget = {
  drawCalls: number;
  meshes: number;
  instances: number;
  triangles: number;
  vertices: number;
  /** unique geometry bytes actually written to the file */
  geometryBytes: number;
  /** encoded texture bytes in the file (approximate) */
  textureBytes: number;
  /** total estimated .glb size */
  fileBytes: number;
  /** GPU memory once loaded (geometry + uncompressed textures + mips) */
  vramBytes: number;
  textures: { name: string; size: string; vram: number }[];
};

function geoBytes(g: THREE.BufferGeometry) {
  let b = 0;
  for (const key of Object.keys(g.attributes)) {
    const a = g.attributes[key] as THREE.BufferAttribute;
    b += a.count * a.itemSize * (a.array as ArrayLike<number> & { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
  }
  if (g.index) b += g.index.count * (g.index.array as Uint32Array).BYTES_PER_ELEMENT;
  return b;
}

function texSize(t: THREE.Texture) {
  const img = t.image as { width?: number; height?: number } | undefined;
  return { w: img?.width ?? 0, h: img?.height ?? 0 };
}

/**
 * Rough but honest estimate of what the exported .glb will cost on disk and in
 * GPU memory. Texture encoding is approximated (PNG-ish noisy content), so the
 * file size lands within roughly ±25%.
 */
export function estimateExportBudget(root: THREE.Object3D, merged: boolean): ExportBudget {
  let meshes = 0;
  let instances = 0;
  let triangles = 0;
  let vertices = 0;
  let geometryBytes = 0;
  let drawCalls = 0;

  const seenGeo = new Set<THREE.BufferGeometry>();
  const seenTex = new Map<THREE.Texture, { name: string; w: number; h: number }>();

  root.traverse((o) => {
    const m = o as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
    if (!m.isMesh) return;
    const count = m.isInstancedMesh ? (m.count ?? 1) : 1;
    const g = m.geometry;
    const vcount = g.attributes['position']?.count ?? 0;
    const tcount = (g.index ? g.index.count : vcount) / 3;

    meshes++;
    drawCalls++; // instanced or merged, both are a single draw call
    instances += count;
    triangles += tcount * count;
    vertices += vcount * (merged ? count : 1);

    if (!seenGeo.has(g)) {
      seenGeo.add(g);
      geometryBytes += geoBytes(g) * (merged ? count : 1);
    }
    if (m.isInstancedMesh && !merged) geometryBytes += count * 40; // TRS per instance

    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      const std = mat as THREE.MeshStandardMaterial;
      for (const slot of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap"] as const) {
        const t = std[slot] as THREE.Texture | null | undefined;
        if (!t || seenTex.has(t)) continue;
        const { w, h } = texSize(t);
        if (w && h) seenTex.set(t, { name: `${m.name || "mesh"} · ${slot}`, w, h });
      }
    }
  });

  let textureBytes = 0;
  let texVram = 0;
  const textures: ExportBudget["textures"] = [];
  for (const [, info] of seenTex) {
    const px = info.w * info.h;
    const vram = px * 4 * 1.34; // RGBA8 + mipmaps
    textureBytes += px * 1.1; // ~1.1 bytes/px encoded for noisy PNG content
    texVram += vram;
    textures.push({ name: info.name, size: `${info.w}×${info.h}`, vram });
  }

  return {
    drawCalls,
    meshes,
    instances,
    triangles: Math.round(triangles),
    vertices,
    geometryBytes,
    textureBytes,
    fileBytes: geometryBytes + textureBytes + 64 * 1024,
    vramBytes: geometryBytes + texVram,
    textures: textures.sort((a, b) => b.vram - a.vram),
  };
}

export function formatBytes(b: number) {
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

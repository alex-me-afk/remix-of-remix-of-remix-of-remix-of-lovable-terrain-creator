import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildIsland, buildVegetation, maxFloatGap, snapScatter, type BuildResult, type VegKind, type VegTemplates } from "@/lib/terrain/build";
import { loadBuildingTemplates, type BuildingTemplates } from "@/lib/terrain/buildings";
import { bakeInstancesForExport, cleanForExport, countExportMeshes } from "@/lib/terrain/exportUtils";

import { HALF, WORLD, PLAYER_EYE, WATER_LEVEL } from "@/lib/terrain/model";
import { createFirstPerson, type FirstPerson } from "@/lib/terrain/firstPerson";

const SKY_ZENITH = new THREE.Color(0x5c9dff);
const SKY_HORIZON = new THREE.Color(0xcfe8ff);
const FOG_COLOR = new THREE.Color(0xcfe8ff);

type Stats = BuildResult["stats"];

const KINDS: { key: VegKind; label: string }[] = [
  { key: "trees", label: "Trees" },
  { key: "rocks", label: "Rocks" },
  { key: "grass", label: "Grass" },
];

/** Removes and frees every vegetation group still attached anywhere in the scene. */
function disposeVegetation(...roots: (THREE.Object3D | null | undefined)[]) {
  const doomed: THREE.Object3D[] = [];
  for (const root of roots) {
    if (!root) continue;
    root.traverse((o) => {
      if (o.name === "Vegetation") doomed.push(o);
    });
  }
  for (const g of doomed) {
    g.removeFromParent();
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) m.geometry.dispose();
    });
  }
}

export function TerrainViewer() {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const resultRef = useRef<BuildResult | null>(null);
  const vegRef = useRef<THREE.Group | null>(null);
  const fpRef = useRef<FirstPerson | null>(null);
  const templatesRef = useRef<VegTemplates>({});
  const buildingsRef = useRef<BuildingTemplates>({});
  const bGroupRef = useRef<THREE.Group | null>(null);
  const orbitPose = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);

  const [seed, setSeed] = useState(1337);
  const [status, setStatus] = useState("Booting renderer…");
  const [busy, setBusy] = useState(true);
  const [stats, setStats] = useState<Stats | null>(null);
  const [showVeg, setShowVeg] = useState(true);
  const [showBuildings, setShowBuildings] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [replaced, setReplaced] = useState<Record<string, string>>({});
  /** merge instances into single meshes instead of using EXT_mesh_gpu_instancing */
  const [bakedExport, setBakedExport] = useState(false);


  useEffect(() => {
    const mount = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = SKY_HORIZON.clone();
    scene.fog = new THREE.Fog(FOG_COLOR, 1200, 4200);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, mount.clientWidth / mount.clientHeight, 0.1, 12000);
    camera.position.set(1100, 720, 1100);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.maxDistance = 4200;
    controls.target.set(0, 30, 0);
    controlsRef.current = controls;

    // --- sky dome -----------------------------------------------------------
    const skyGeo = new THREE.SphereGeometry(5000, 32, 32);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenith: { value: SKY_ZENITH },
        horizon: { value: SKY_HORIZON },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 zenith;
        uniform vec3 horizon;
        varying vec3 vWorldPos;
        void main() {
          vec3 up = normalize(vWorldPos);
          float t = clamp(up.y * 0.55 + 0.45, 0.0, 1.0);
          vec3 col = mix(horizon, zenith, t);
          // soft horizon haze
          col = mix(col, horizon, smoothstep(0.02, -0.08, up.y));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.name = "SkyDome_ViewerOnly";
    scene.add(sky);

    // --- lighting -----------------------------------------------------------
    const sun = new THREE.DirectionalLight(0xfff6e8, 2.4);
    sun.position.set(720, 980, 380);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0xbfe4ff, 0x5c4a3a, 0.85));

    const clock = new THREE.Clock();
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, clock.getDelta());
      if (fpRef.current) fpRef.current.update(dt);
      else controls.update();
      renderer.render(scene, camera);
    };
    loop();

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      fpRef.current?.dispose();
      controls.dispose();
      renderer.dispose();
      skyGeo.dispose();
      skyMat.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  const generate = useCallback(
    async (s: number) => {
      const scene = sceneRef.current;
      if (!scene) return;
      setBusy(true);
      try {
        const prev = resultRef.current;
        if (prev) {
          scene.remove(prev.group);
          prev.group.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.geometry) m.geometry.dispose();
            const mat = m.material as THREE.MeshStandardMaterial | undefined;
            if (mat) {
              mat.map?.dispose();
              mat.normalMap?.dispose();
              mat.dispose();
            }
          });
        }
        if (!Object.keys(buildingsRef.current).length) {
          buildingsRef.current = await loadBuildingTemplates(setStatus);
        }
        const res = await buildIsland(
          s,
          { templates: templatesRef.current, buildings: buildingsRef.current },
          setStatus,
        );
        scene.add(res.group);
        resultRef.current = res;
        setStats(res.stats);

        vegRef.current = res.vegetation;
        res.vegetation.visible = showVeg;
        bGroupRef.current = res.buildings;
        res.buildings.visible = showBuildings;
        setStatus("Ready");
      } catch (e) {
        console.error(e);
        setStatus(`Failed: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [showVeg, showBuildings],
  );

  useEffect(() => {
    void generate(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (vegRef.current) vegRef.current.visible = showVeg;
  }, [showVeg]);

  useEffect(() => {
    if (bGroupRef.current) bGroupRef.current.visible = showBuildings;
  }, [showBuildings]);

  useEffect(() => {
    const res = resultRef.current;
    if (!res) return;
    res.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.name === "Terrain") (m.material as THREE.MeshStandardMaterial).wireframe = wireframe;
    });
  }, [wireframe, stats]);

  // --- play mode -----------------------------------------------------------

  const stopPlaying = useCallback(() => {
    fpRef.current?.dispose();
    fpRef.current = null;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const pose = orbitPose.current;
    if (camera && controls && pose) {
      camera.position.copy(pose.pos);
      controls.target.copy(pose.target);
      camera.rotation.set(0, 0, 0);
    }
    if (controls) controls.enabled = true;
    setPlaying(false);
    setStatus("Ready");
  }, []);

  const startPlaying = useCallback(() => {
    const res = resultRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const renderer = rendererRef.current;
    if (!res || !camera || !controls || !renderer) return;
    orbitPose.current = { pos: camera.position.clone(), target: controls.target.clone() };
    controls.enabled = false;
    const fp = createFirstPerson(camera, renderer.domElement, res.model, res.grids);
    // drop the player on a random build pad
    const pad = res.model.pads[Math.floor(Math.random() * res.model.pads.length)];
    fp.spawn(pad?.x ?? 0, pad?.z ?? 0);
    fpRef.current = fp;
    setPlaying(true);
    setStatus("Walking · WASD move · Shift run · Space jump · Esc exit");
    void renderer.domElement.requestPointerLock();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape" && fpRef.current) stopPlaying();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stopPlaying]);

  // --- asset replacement ---------------------------------------------------

  const replaceKind = useCallback(async (kind: VegKind, file: File) => {
    const res = resultRef.current;
    const scene = sceneRef.current;
    if (!res || !scene) return;
    setBusy(true);
    setStatus(`Loading ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      const loader = new GLTFLoader();
      const gltf = await loader.parseAsync(buf, "");
      templatesRef.current = { ...templatesRef.current, [kind]: gltf.scene };

      // rebuild vegetation in place: same count, same positions, same sizes
      disposeVegetation(res.group, scene);
      const veg = buildVegetation(res.scatter, templatesRef.current);
      veg.visible = showVeg;
      res.group.add(veg);
      res.vegetation = veg;
      vegRef.current = veg;
      setReplaced((r) => ({ ...r, [kind]: file.name }));
      setStatus(`Replaced ${kind} with ${file.name}`);
    } catch (e) {
      console.error(e);
      setStatus(`Import failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [showVeg]);

  const resetKind = useCallback((kind: VegKind) => {
    const res = resultRef.current;
    if (!res) return;
    const next = { ...templatesRef.current };
    delete next[kind];
    templatesRef.current = next;
    disposeVegetation(res.group, sceneRef.current);
    const veg = buildVegetation(res.scatter, next);
    veg.visible = showVeg;
    res.group.add(veg);
    res.vegetation = veg;
    vegRef.current = veg;
    setReplaced((r) => {
      const c = { ...r };
      delete c[kind];
      return c;
    });
  }, [showVeg]);

  const exportGlb = useCallback(() => {
    const res = resultRef.current;
    if (!res) return;
    setBusy(true);

    // hard guarantee: nothing may sit above the exported ground triangles
    snapScatter(res.scatter, res.grids, res.segments);
    disposeVegetation(res.group, sceneRef.current);
    const veg = buildVegetation(res.scatter, templatesRef.current);
    veg.visible = showVeg;
    res.group.add(veg);
    res.vegetation = veg;
    vegRef.current = veg;
    const gap = maxFloatGap(res.scatter, res.grids, res.segments);

    const source = bakedExport ? bakeInstancesForExport(res.group) : res.group;
    cleanForExport(source);
    const counts = countExportMeshes(source);
    setStatus(`Exporting GLB · ${counts.meshes} meshes · ${counts.triangles.toLocaleString()} tris…`);

    const exporter = new GLTFExporter();
    exporter.parse(
      source,
      (out) => {
        const blob = new Blob([out as ArrayBuffer], { type: "model/gltf-binary" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `br-island-${seed}${bakedExport ? "-merged" : ""}.glb`;
        a.click();
        URL.revokeObjectURL(url);
        setStatus(
          `Exported · ${counts.meshes} meshes · ${counts.triangles.toLocaleString()} tris · ` +
            `max float gap ${gap.toFixed(3)} m`,
        );
        setBusy(false);
      },
      (err) => {
        console.error(err);
        setStatus("Export failed");
        setBusy(false);
      },
      { binary: true, maxTextureSize: 4096 },
    );
  }, [seed, bakedExport, showVeg]);


  return (
    <div className="relative h-screen w-full">
      <div ref={mountRef} className="h-full w-full" />

      {playing && (
        <>
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-foreground/70" />
          <div className="pointer-events-auto absolute right-4 top-4 flex flex-col items-end gap-2">
            <button
              onClick={stopPlaying}
              className="rounded-md bg-card/90 px-3 py-1.5 text-sm font-medium text-foreground backdrop-blur-md"
            >
              Exit walk mode (Esc)
            </button>
            <p className="rounded-md bg-card/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-md">
              Eye height {PLAYER_EYE} m · click to look around
            </p>
          </div>
        </>
      )}

      {!playing && (
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4 sm:p-6">
          <header className="pointer-events-auto w-fit rounded-xl border border-border/60 bg-card/85 px-4 py-3 backdrop-blur-md">
            <h1 className="font-display text-lg tracking-[0.18em] text-foreground uppercase">
              BR Island Generator
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {WORLD} × {WORLD} m · 3 regions (hills · mesa plateau · sunken basin) · underground
              tunnels · road network · GLB export
            </p>
          </header>

          <div className="pointer-events-auto flex flex-wrap items-end gap-3">
            <div className="rounded-xl border border-border/60 bg-card/85 p-4 backdrop-blur-md">
              <label className="block text-[10px] font-medium tracking-[0.2em] text-muted-foreground uppercase">
                Seed
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value) || 0)}
                  className="w-28 rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-ring"
                />
                <button
                  disabled={busy}
                  onClick={() => void generate(seed)}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
                >
                  Generate
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    const s = Math.floor(Math.random() * 99999);
                    setSeed(s);
                    void generate(s);
                  }}
                  className="rounded-md border border-input px-3 py-1.5 text-sm text-foreground transition hover:bg-accent disabled:opacity-50"
                >
                  Random
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={showVeg} onChange={(e) => setShowVeg(e.target.checked)} />
                  Vegetation
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />
                  Wireframe
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={showBuildings}
                    onChange={(e) => setShowBuildings(e.target.checked)}
                  />
                  Buildings
                </label>
              </div>
              <button
                disabled={busy}
                onClick={startPlaying}
                className="mt-3 w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold tracking-wide text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
              >
                ▶ Play · drop in as a 1.8 m player
              </button>
              <label className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={bakedExport}
                  onChange={(e) => setBakedExport(e.target.checked)}
                />
                <span>
                  Merge instances on export
                  <span className="block text-[11px] opacity-80">
                    Off = GPU instancing (1 mesh + transforms, smallest file). On = one merged mesh per
                    prop type for engines without EXT_mesh_gpu_instancing.
                  </span>
                </span>
              </label>
              <button
                disabled={busy}
                onClick={exportGlb}
                className="mt-2 w-full rounded-md bg-accent px-3 py-2 text-sm font-semibold tracking-wide text-accent-foreground transition hover:bg-accent/80 disabled:opacity-50"
              >
                Export .GLB
              </button>

            </div>

            <div className="rounded-xl border border-border/60 bg-card/85 p-4 text-xs backdrop-blur-md">
              <p className="text-[10px] font-medium tracking-[0.2em] text-muted-foreground uppercase">
                Replace props with your own GLB
              </p>
              <div className="mt-2 space-y-2">
                {KINDS.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-14 text-foreground">{label}</span>
                    <label className="cursor-pointer rounded-md border border-input px-2 py-1 text-foreground transition hover:bg-accent">
                      Choose .glb
                      <input
                        type="file"
                        accept=".glb,.gltf,model/gltf-binary"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void replaceKind(key, f);
                        }}
                      />
                    </label>
                    {replaced[key] && (
                      <>
                        <span className="max-w-[110px] truncate text-muted-foreground">{replaced[key]}</span>
                        <button
                          onClick={() => resetKind(key)}
                          className="rounded-md px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                        >
                          reset
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-2 max-w-[260px] text-[11px] text-muted-foreground">
                Every instance keeps its exact position, rotation and height — only the model swaps.
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-card/85 px-4 py-3 text-xs text-muted-foreground backdrop-blur-md">
              <p className={busy ? "text-accent-foreground" : "text-foreground"}>{status}</p>
              {stats && (
                <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1">
                  <li>Vertices: {stats.vertices.toLocaleString()}</li>
                  <li>Triangles: {stats.triangles.toLocaleString()}</li>
                  <li>Hills: {stats.hills}</li>
                  <li>Road segments: {stats.roadSegments}</li>
                  <li>Tunnels: {stats.tunnels}</li>
                  <li>Trees: {stats.trees.toLocaleString()}</li>
                  <li>Rocks: {stats.rocks.toLocaleString()}</li>
                  <li>Grass tufts: {stats.grass.toLocaleString()}</li>
                  <li>Buildings: {stats.buildings}</li>
                  <li>Map radius: {HALF} m</li>
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

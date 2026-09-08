import { createFileRoute } from "@tanstack/react-router";
import { ClientOnly } from "@tanstack/react-router";
import { TerrainViewer } from "@/components/TerrainViewer";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BR Island Generator — 500×500 Battle Royale Terrain + GLB Export" },
      {
        name: "description",
        content:
          "Generate a 500×500 unit circular battle-royale island with a 100-unit water ring, walkable textured hills, flat build pads and a full road network, then export it as GLB.",
      },
      { property: "og:title", content: "BR Island Generator — Terrain + GLB Export" },
      {
        property: "og:description",
        content:
          "Procedural 500×500 BR map: water ring, walkable hills, baked photoreal textures, road network, one-click GLB export.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main className="h-screen w-full bg-background">
      <ClientOnly
        fallback={
          <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
            Loading terrain engine…
          </div>
        }
      >
        <TerrainViewer />
      </ClientOnly>
    </main>
  );
}

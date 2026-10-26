import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["replicad-opencascadejs", "@salusoft89/planegcs"] },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});

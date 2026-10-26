import { defineConfig } from "vite";

export default defineConfig({
  worker: { format: "es" },
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  build: { target: "es2022" },
});

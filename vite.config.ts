import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { execSync } from "node:child_process";

// versão (commit) dos módulos da galkeel-calculadora usados pela análise integrada (rastreabilidade)
const calcVersion = (() => {
  try { return execSync("git -C vendor/galkeel-calculadora rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { return "?"; }
})();

export default defineConfig({
  plugins: [preact()],
  define: { __GALKEEL_CALC_VERSION__: JSON.stringify(calcVersion) },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["replicad-opencascadejs", "@salusoft89/planegcs"] },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});

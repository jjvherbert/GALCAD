import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

// versão (commit) dos módulos da galkeel-calculadora usados pela análise integrada (rastreabilidade)
const calcVersion = (() => {
  try { return execSync("git -C vendor/galkeel-calculadora rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { return "?"; }
})();

// sem o submódulo (privado, ex. no CI público): módulos vazios e a análise Galkeel desligada na app
const hasCalc = existsSync("vendor/galkeel-calculadora/assets/iso12215-5-pressure.js");
const noCalc = {
  name: "galkeel-calc-missing",
  enforce: "pre" as const,
  resolveId: (id: string) => (!hasCalc && id.includes("vendor/galkeel-calculadora/") ? "\0galkeel-calc-missing" : null),
  load: (id: string) => (id === "\0galkeel-calc-missing" ? "export default ''" : null),
};

export default defineConfig({
  plugins: [noCalc, preact()],
  define: { __GALKEEL_CALC_VERSION__: JSON.stringify(calcVersion) },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["replicad-opencascadejs", "@salusoft89/planegcs"] },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});

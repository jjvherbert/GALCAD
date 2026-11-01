// Utilitários partilhados pelas suites e2e.
// `npx` não existe como executável em Windows (é `npx.cmd`) e um spawn por `shell` deixaria o vite
// órfão no kill(); por isso arrancamos o binário do vite diretamente com o node atual.
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

// o `exports` do vite não expõe bin/; só o package.json é resolúvel
const VITE = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");

function startPreview(port) {
  const server = spawn(process.execPath, [VITE, "preview", "--port", String(port), "--strictPort"], { stdio: "ignore" });
  server.on("error", (e) => { console.error(`vite preview não arrancou: ${e.message}`); process.exitCode = 1; });
  return server;
}

// solver disponível no PATH? (`which` não existe fora do Git Bash em Windows)
const has = (cmd) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;

module.exports = { startPreview, has };

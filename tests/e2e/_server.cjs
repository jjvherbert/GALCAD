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

// Solvers incluídos na app desktop (desktop/solvers/<plataforma>, fora do Git): se existirem, entram à frente no
// PATH deste processo, para o `has` os ver e o agente (cad-runner) arrancado pelas suites os herdar. Assim uma
// corrida local usa sempre o Gmsh/CalculiX reais; no CI não existem e o cálculo continua a ser saltado.
const fs = require("node:fs");
const plat = { win32: "win", darwin: "mac", linux: "linux" }[process.platform];
const bundled = path.join(__dirname, "../../desktop/solvers", plat ?? "-");
const extra = ["gmsh", "calculix"].map((d) => path.join(bundled, d)).filter((d) => fs.existsSync(d));
if (extra.length) process.env.PATH = [...extra, process.env.PATH].join(path.delimiter);

// solver disponível no PATH? (`which` não existe fora do Git Bash em Windows)
const has = (cmd) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;

// Agente local (cad-runner --serve) com um token conhecido. Se a porta já estiver ocupada (ex.: um agente órfão de
// uma corrida interrompida, com outro token), o pedido da app levaria 401 «token errado» sem pista; falha já aqui.
const net = require("node:net");
const portFree = (port) => new Promise((ok) => {
  const s = net.createServer().once("error", () => ok(false)).once("listening", () => s.close(() => ok(true)));
  s.listen(port, "127.0.0.1");
});
async function startAgent(port, token) {
  if (!(await portFree(port))) throw new Error(`porta ${port} do agente já ocupada (agente órfão de outra corrida?)`);
  return spawn(process.execPath, [path.join(__dirname, "../../public/cad-runner.mjs"), "--serve", "--port", String(port)], { stdio: "ignore", env: { ...process.env, CAD_TOKEN: token } });
}

module.exports = { startPreview, has, startAgent };

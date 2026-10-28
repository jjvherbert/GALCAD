// GALCAD para Windows (e Linux/macOS): a mesma aplicação web numa janela Electron, com o agente
// de simulação a correr dentro da app e os solvers instalados com ela — o utilizador não instala
// nada à parte nem copia tokens.
//
// - Servidor estático em 127.0.0.1 (porta livre) para a aplicação construída (dist/): o WASM, os
//   workers e os módulos ES precisam de http, não de file://.
// - Agente (`dist/cad-runner.mjs`, o mesmo da versão web) em 127.0.0.1 noutra porta, com um token
//   novo a cada arranque, passado à página pelo preload (window.cadDesktop).
// - Solvers em `resources/solvers` (CalculiX, Gmsh, XFOIL; code_aster opcional): o agente
//   recebe-os por CAD_CCX, CAD_GMSH, CAD_XFOIL, CAD_ASTER e corre-os como programas separados.
const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

const root = path.join(__dirname, "..", "dist");
const solvers = app.isPackaged ? path.join(process.resourcesPath, "solvers") : path.join(__dirname, "solvers", process.platform === "win32" ? "win" : "host");

/** Caminhos dos solvers incluídos (só os que existem; os outros o agente procura no PATH). */
function solverEnv() {
  const exe = process.platform === "win32" ? ".exe" : "";
  const env = {};
  const set = (key, rel) => { const p = path.join(solvers, rel); if (!process.env[key] && fs.existsSync(p)) env[key] = p; };
  set("CAD_CCX", `calculix/ccx${exe}`);
  set("CAD_GMSH", `gmsh/gmsh${exe}`);
  set("CAD_XFOIL", `xfoil/xfoil${exe}`);
  // code_aster (opcional): ambiente conda instalado à parte pela app na pasta do utilizador
  const aster = path.join(app.getPath("userData"), "code_aster", process.platform === "win32" ? "Scripts/run_aster.bat" : "bin/run_aster");
  if (!process.env.CAD_ASTER && fs.existsSync(aster)) env.CAD_ASTER = aster;
  return env;
}

/** Servidor estático da aplicação (só 127.0.0.1, sem sair de dist/). */
function serveStatic() {
  return new Promise((ok) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      if (url.pathname === "/" || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
      res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port }));
  });
}

async function startAgent() {
  Object.assign(process.env, solverEnv());
  const mod = await import(pathToFileURL(path.join(root, "cad-runner.mjs")).href);
  const token = crypto.randomBytes(16).toString("hex");
  const { server } = mod.serve(0, token);
  await new Promise((ok) => (server.listening ? ok() : server.once("listening", ok)));
  return { url: `http://127.0.0.1:${server.address().port}`, token, tools: mod.tools() };
}

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  let agent = null;
  try { agent = await startAgent(); } catch (e) { dialog.showErrorBox("GALCAD", `O agente de simulação não arrancou: ${e.message}\nA modelação funciona; as simulações não.`); }
  const site = await serveStatic();
  const win = new BrowserWindow({
    width: 1440, height: 900, title: "GALCAD", backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: [`--cad-agent=${agent ? `${agent.url}|${agent.token}` : ""}`, `--cad-version=${app.getVersion()}`],
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "GALCAD", submenu: [
      { label: "Solvers incluídos", click: () => dialog.showMessageBox(win, { title: "Solvers", message: Object.entries(agent?.tools ?? {}).map(([k, t]) => `${k}: ${t ? t.path : "não encontrado"}`).join("\n") || "Agente parado" }) },
      { label: "Pasta de dados", click: () => shell.openPath(app.getPath("userData")) },
      { type: "separator" }, { role: "reload", label: "Recarregar" }, { role: "toggleDevTools", label: "Ferramentas de programador" }, { type: "separator" }, { role: "quit", label: "Sair" },
    ] },
    { label: "Editar", submenu: [{ role: "undo", label: "Anular" }, { role: "redo", label: "Refazer" }, { type: "separator" }, { role: "cut", label: "Cortar" }, { role: "copy", label: "Copiar" }, { role: "paste", label: "Colar" }, { role: "selectAll", label: "Selecionar tudo" }] },
    { label: "Ver", submenu: [{ role: "resetZoom", label: "Tamanho real" }, { role: "zoomIn", label: "Ampliar" }, { role: "zoomOut", label: "Reduzir" }, { type: "separator" }, { role: "togglefullscreen", label: "Ecrã inteiro" }] },
  ]));
  // ligações externas no browser do sistema; a janela só navega na própria aplicação
  const own = `http://127.0.0.1:${site.port}`;
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(own)) { e.preventDefault(); shell.openExternal(url); } });
  await win.loadURL(`${own}/`);
});

app.on("second-instance", () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
app.on("window-all-closed", () => app.quit());

// GALCAD para Windows (e Linux/macOS): a mesma aplicação web numa janela Electron, com o agente
// de simulação a correr dentro da app e os solvers instalados com ela — o utilizador não instala
// nada à parte nem copia tokens.
//
// - Servidor estático em 127.0.0.1 (porta livre) para a aplicação construída (dist/): o WASM, os
//   workers e os módulos ES precisam de http, não de file://.
// - Agente (`dist/cad-runner.mjs`, o mesmo da versão web) num processo à parte (utilityProcess,
//   `agent-host.cjs`) em 127.0.0.1 noutra porta, com um token novo a cada arranque, passado à página
//   pelo preload (window.cadDesktop). Um solver ou pedido encravado não congela a janela.
// - Solvers em `resources/solvers` (CalculiX, Gmsh, XFOIL, SU2, OpenFOAM, code_aster, OpenRadioss):
//   o agente recebe-os por CAD_CCX, CAD_GMSH, CAD_XFOIL, CAD_SU2, CAD_FOAM_DIR, CAD_ASTER,
//   CAD_RADIOSS_DIR e corre-os como programas separados.
// - `GALCAD.exe --galcad-setup` (chamado pelo instalador): reloca o ambiente do code_aster para a
//   pasta de instalação e sai.
const { app, BrowserWindow, Menu, shell, dialog, utilityProcess } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
  set("CAD_SU2", `su2/SU2_CFD${exe}`);
  set("CAD_ASTER", process.platform === "win32" ? "code_aster/run_aster.cmd" : "code_aster/bin/run_aster");
  const rad = path.join(solvers, "openradioss");
  if (!process.env.CAD_RADIOSS_DIR && fs.existsSync(path.join(rad, "exec"))) env.CAD_RADIOSS_DIR = rad;
  const foam = path.join(solvers, "openfoam");
  if (!process.env.CAD_FOAM_DIR && fs.existsSync(foam)) {
    const d = fs.readdirSync(foam).find((x) => x.startsWith("OpenFOAM-"));
    if (d) env.CAD_FOAM_DIR = path.join(foam, d);
  }
  return env;
}

const relocateAster = () => require("./relocate.cjs").relocateAster(path.join(solvers, "code_aster"));

const setupMode = process.argv.includes("--galcad-setup");
if (setupMode) {
  // passo do instalador: sem janela
  let code = 0;
  try { const r = relocateAster(); console.log(`code_aster: ${r.changed} ficheiro(s) relocado(s)`); } catch (e) { console.error(e); code = 1; }
  app.exit(code);
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

/** Processo do agente (utilityProcess); morto ao sair da aplicação. */
let agentProc = null;

/** Arranca o agente num processo à parte e espera que esteja à escuta (no máximo 30 s). */
function startAgent() {
  try { relocateAster(); } catch (e) { console.error("code_aster: relocação falhou", e); }
  const token = crypto.randomBytes(16).toString("hex");
  const child = utilityProcess.fork(path.join(__dirname, "agent-host.cjs"), [], {
    env: { ...process.env, ...solverEnv(), GALCAD_AGENT_TOKEN: token, GALCAD_AGENT_MODULE: path.join(root, "cad-runner.mjs") },
    serviceName: "GALCAD agente",
  });
  agentProc = child;
  return new Promise((ok, fail) => {
    let ready = false;
    const timer = setTimeout(() => { child.kill(); fail(new Error("o agente não arrancou em 30 s")); }, 30_000);
    child.once("message", (m) => {
      clearTimeout(timer);
      if (m?.error) { child.kill(); fail(new Error(m.error)); return; }
      ready = true;
      ok({ url: `http://127.0.0.1:${m.port}`, token, tools: m.tools });
    });
    child.once("exit", (code) => {
      agentProc = null;
      if (!ready) { clearTimeout(timer); fail(new Error(`o processo do agente terminou ao arrancar (código ${code})`)); }
      else if (!quitting) console.error(`agente de simulação terminou (código ${code}); os cálculos ficam indisponíveis até reiniciar a GALCAD`);
    });
  });
}

// ao sair, o fim do agente é esperado: não o reportar como falha
let quitting = false;
app.on("before-quit", () => { quitting = true; agentProc?.kill(); });

if (!setupMode && !app.requestSingleInstanceLock()) app.quit();

/** Ecrã de arranque com a marca Galkeel enquanto o agente e os solvers arrancam. */
function splashWindow() {
  const logo = fs.readFileSync(path.join(__dirname, "brand", "splash-logo.png")).toString("base64");
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;font-family:Montserrat,"Segoe UI",sans-serif;background:#0a2464;color:#fff;overflow:hidden;-webkit-user-select:none}
    .c{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
    img{width:120px;height:auto;filter:brightness(0) invert(1);animation:in .7s cubic-bezier(.2,.8,.2,1) both}
    h1{margin:0;font-size:26px;letter-spacing:.12em;font-weight:700;animation:in .7s .12s both}
    p{margin:0;font-size:12px;color:#bccde1;animation:in .7s .24s both}
    .bar{width:180px;height:3px;background:rgba(255,255,255,.15);border-radius:2px;overflow:hidden;margin-top:8px}
    .bar i{display:block;width:40%;height:100%;background:#018a8a;animation:run 1.1s ease-in-out infinite}
    @keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @keyframes run{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
  </style><div class="c"><img src="data:image/png;base64,${logo}"><h1>GALCAD</h1><p>A iniciar o agente de simulação e os solvers…</p><div class="bar"><i></i></div></div>`;
  const w = new BrowserWindow({ width: 420, height: 300, frame: false, resizable: false, show: false, backgroundColor: "#0a2464", center: true, alwaysOnTop: true, skipTaskbar: true, webPreferences: { sandbox: true } });
  // `w.shownAt` fica definido quando o ecrã de arranque aparece; a janela principal espera por ele (no máx. 3 s)
  w.shown = new Promise((ok) => { w.once("ready-to-show", () => { w.show(); w.shownAt = Date.now(); global.galcadSplash = "shown"; ok(); }); setTimeout(ok, 3000); });
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return w;
}

if (!setupMode) app.whenReady().then(async () => {
  const splash = splashWindow();
  let agent = null;
  try { agent = await startAgent(); } catch (e) { dialog.showErrorBox("GALCAD", `O agente de simulação não arrancou: ${e.message}\nA modelação funciona; as simulações não.`); }
  const site = await serveStatic();
  const webPreferences = {
    preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true,
    additionalArguments: [`--cad-agent=${agent ? `${agent.url}|${agent.token}` : ""}`, `--cad-version=${app.getVersion()}`],
  };
  const win = new BrowserWindow({
    width: 1440, height: 900, title: "GALCAD", backgroundColor: "#ffffff", show: false,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences,
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
  // um desenho em janela própria (`?drawing=<id>`) abre como outra janela da aplicação, com as mesmas regras
  const guard = (contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(`${own}/`)) return { action: "allow", overrideBrowserWindowOptions: { width: 1280, height: 860, title: "GALCAD — Desenho", backgroundColor: "#ffffff", icon: path.join(__dirname, "build", "icon.png"), autoHideMenuBar: true, webPreferences } };
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (e, url) => { if (!url.startsWith(own)) { e.preventDefault(); shell.openExternal(url); } });
    contents.on("did-create-window", (child) => guard(child.webContents));
  };
  guard(win.webContents);
  // a janela principal aparece já desenhada (sem ecrã branco) e o splash fecha
  win.once("ready-to-show", async () => {
    // o ecrã de arranque mostra-se sempre primeiro e fica pelo menos meio segundo (a marca à vista)
    await splash.shown;
    const wait = splash.shownAt ? Math.max(0, 500 - (Date.now() - splash.shownAt)) : 0;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    win.maximize(); win.show(); if (!splash.isDestroyed()) splash.close();
  });
  await win.loadURL(`${own}/`);
});

app.on("second-instance", () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
app.on("window-all-closed", () => app.quit());

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { plugins, modelDefs as models } from "../core/registry.js";

// --- Worker de geometria (pedido/resposta por id) ---
const worker = new Worker(new URL("../core/worker.js", import.meta.url), { type: "module" });
let seq = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  pending.delete(data.id);
  data.ok ? p.resolve(data) : p.reject(new Error(data.error));
};
const call = (msg) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  worker.postMessage({ ...msg, id });
});

// --- Cena 3D (Z para cima, como em CAD) ---
const view = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1e5);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
scene.add(sun);
const group = new THREE.Group();
scene.add(group);

function resize() {
  const { clientWidth: w, clientHeight: h } = view;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);
const dark = matchMedia("(prefers-color-scheme: dark)");
const setBg = () => scene.background = new THREE.Color(dark.matches ? 0x11151c : 0xf4f5f7);
dark.addEventListener("change", setBg); setBg();
renderer.setAnimationLoop(() => { controls.update(); sun.position.copy(camera.position); renderer.render(scene, camera); });

function showMesh({ mesh, edges }, refit) {
  group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  group.clear();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(mesh.vertices, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.normals, 3));
  g.setIndex(mesh.triangles);
  group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x8fb3d9, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })));
  const eg = new THREE.BufferGeometry();
  eg.setAttribute("position", new THREE.Float32BufferAttribute(edges, 3));
  group.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x1c2330 })));
  if (models[modelKey].waterline) group.add(waterline());
  if (refit) fit();
}

// Plano translúcido da linha de água (z = 0), um pouco maior que o casco.
function waterline() {
  const w = new THREE.Mesh(
    new THREE.PlaneGeometry(values.L * 1.3, values.B * 2.2),
    new THREE.MeshBasicMaterial({ color: 0x2a7fd4, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
  );
  w.position.set(values.L / 2, 0, 0);
  return w;
}

function fit() {
  const box = new THREE.Box3().setFromObject(group);
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length() || 1;
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(0.9, -1.3, 0.25).normalize().multiplyScalar(r * 1.4));
  camera.near = r / 1000; camera.far = r * 100; camera.updateProjectionMatrix();
}

// --- Painel ---
const $ = (id) => document.getElementById(id);
const status = (msg, err = false) => { $("status").textContent = msg; $("status").className = err ? "err" : ""; };
const fmt = (v, d = 2) => v.toLocaleString("pt-PT", { maximumFractionDigits: d, minimumFractionDigits: d });
let modelKey = "base/placa";
let values = {};

for (const p of plugins) {
  const og = Object.assign(document.createElement("optgroup"), { label: p.name });
  for (const k of Object.keys(p.models)) og.append(new Option(p.models[k].label, `${p.id}/${k}`));
  $("model").append(og);
}
$("model").onchange = (e) => selectModel(e.target.value);

function selectModel(key) {
  modelKey = key;
  const m = models[key];
  values = Object.fromEntries(Object.entries(m.params).map(([k, p]) => [k, p.value]));
  $("params").replaceChildren(...Object.entries(m.params).map(([k, p]) => {
    const l = document.createElement("label");
    l.className = "param";
    l.innerHTML = `<span>${p.label} <output>${p.value} ${p.unitless ? "" : m.units}</output></span>`;
    const input = Object.assign(document.createElement("input"), { type: "range", min: p.min, max: p.max, step: p.step, value: p.value });
    input.oninput = () => { values[k] = +input.value; l.querySelector("output").textContent = `${input.value} ${p.unitless ? "" : m.units}`; schedule(false); };
    l.append(input);
    return l;
  }));
  schedule(true);
}

// Reconstrução com debounce; ignora resultados desatualizados.
let timer, buildSeq = 0;
function schedule(refit) {
  clearTimeout(timer);
  timer = setTimeout(() => rebuild(refit), 120);
}
async function rebuild(refit) {
  const my = ++buildSeq;
  status("A reconstruir…");
  const t0 = performance.now();
  try {
    const res = await call({ type: "build", model: modelKey, params: values });
    if (my !== buildSeq) return;
    showMesh(res, refit);
    renderInfo(res.info);
    status(`Reconstruído em ${Math.round(performance.now() - t0)} ms`);
  } catch (e) {
    if (my === buildSeq) status(`Erro: ${e.message}`, true);
  }
}

// Painel de resultados genérico: cada construtor devolve { title, rows: [[rótulo, valor]], note? }.
function renderInfo(info) {
  const box = $("info");
  box.replaceChildren();
  if (!info) return;
  const h = Object.assign(document.createElement("h1"), { textContent: info.title });
  const table = document.createElement("table");
  for (const [label, value] of info.rows) table.insertRow().append(...[label, value].map((t) => Object.assign(document.createElement("td"), { textContent: t })));
  box.append(h, table);
  if (info.note) box.append(Object.assign(document.createElement("p"), { className: "note", textContent: info.note }));
}

async function exportAs(format) {
  status(`A exportar ${format.toUpperCase()}…`);
  try {
    const { blob } = await call({ type: "export", format });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${modelKey.replace("/", "-")}.${format}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    status(`${format.toUpperCase()} exportado (${fmt(blob.size / 1024, 0)} kB, em mm)`);
  } catch (e) { status(`Erro: ${e.message}`, true); }
}
$("exp-step").onclick = () => exportAs("step");
$("exp-stl").onclick = () => exportAs("stl");

selectModel(modelKey);

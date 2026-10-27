// Visualizador 3D (Three.js): corpo, arestas, esboços, geometria de referência, seleção e
// navegação ao estilo do SolidWorks.
//
// Rato:   meio = rodar · Ctrl+meio = deslocar · Shift+meio = zoom · Alt+meio = rolar
//         roda = zoom no cursor · duplo clique no meio = ajustar · clique no meio sobre a peça = centro de rotação
//         esquerdo = selecionar (Ctrl/Shift soma) · arrastar no vazio = caixa (→ janela, ← cruzamento)
//         direito = menu de contexto · arrastar com o direito = gestos
import * as THREE from "three";
import type { MeshData } from "../kernel/mesh.ts";
import type { RebuildResponse } from "../kernel/protocol.ts";
import type { Frame } from "../kernel/frame.ts";
import type { CadDocument, PlaneRef, StdPlane, Vec3 } from "../doc/types.ts";
import { sampleEntity, allEntities } from "../sketch/geometry.ts";
import type { Analysis, Pick, PickKind } from "./store.ts";
import type { GestureDir, Settings } from "./settings.ts";

const STD: Record<StdPlane, Frame> = {
  XY: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
  XZ: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] },
  YZ: { o: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
};

/** Orientações padrão (Z para cima): direção da câmara para o alvo invertida, e vetor "para cima". */
export const VIEWS = {
  front: { dir: [0, -1, 0], up: [0, 0, 1], label: "Frente", key: "Ctrl+1" },
  back: { dir: [0, 1, 0], up: [0, 0, 1], label: "Trás", key: "Ctrl+2" },
  left: { dir: [-1, 0, 0], up: [0, 0, 1], label: "Esquerda", key: "Ctrl+3" },
  right: { dir: [1, 0, 0], up: [0, 0, 1], label: "Direita", key: "Ctrl+4" },
  top: { dir: [0, 0, 1], up: [0, 1, 0], label: "Topo", key: "Ctrl+5" },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0], label: "Baixo", key: "Ctrl+6" },
  iso: { dir: [1, -1, 1], up: [0, 0, 1], label: "Isométrica", key: "Ctrl+7" },
} satisfies Record<string, { dir: Vec3; up: Vec3; label: string; key: string }>;
export type ViewName = keyof typeof VIEWS;

interface Theme { bg: number; body: number; sheet: number; curve: number; edge: number; hover: number; sel: number; plane: number; sketch: number; axis: number; feat: number }
const themes: Record<"light" | "dark", Theme> = {
  light: { bg: 0xf3f4f6, body: 0xb9c7d6, sheet: 0xe5c07b, curve: 0xdb2777, edge: 0x1f2937, hover: 0xf59e0b, sel: 0x2563eb, plane: 0x5b8def, sketch: 0x1d4ed8, axis: 0x9ca3af, feat: 0x7dd3fc },
  dark: { bg: 0x14181f, body: 0x7f93a8, sheet: 0xb08d3a, curve: 0xf472b6, edge: 0x0b0e13, hover: 0xf59e0b, sel: 0x60a5fa, plane: 0x5b8def, sketch: 0x93c5fd, axis: 0x6b7280, feat: 0x0ea5e9 },
};

/**
 * Linhas de realce (highlight lines): luzes lineares paralelas ao eixo `e`, empilhadas na direção `s`
 * num plano acima do modelo. Em cada ponto, a reta que passa por ele segundo a normal corta o plano
 * das luzes; a coordenada desse ponto em `s` dá a risca. Ao contrário da zebra, não depende da vista
 * e é sensível ao sinal da curvatura (descontinuidades G1/G2 aparecem como quebras ou cotovelos).
 */
/** Cores das classes de continuidade: folga, G0, G1, G2, G3. */
export const CONTINUITY_COLORS: Record<-1 | 0 | 1 | 2 | 3, number> = { [-1]: 0xdc2626, 0: 0x6b7280, 1: 0xeab308, 2: 0x16a34a, 3: 0x2563eb };

function highlightMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    uniforms: { e: { value: new THREE.Vector3(1, 0, 0) }, sdir: { value: new THREE.Vector3(0, 1, 0) }, h: { value: 100 }, w: { value: 10 } },
    vertexShader: `
      varying vec3 vPos; varying vec3 vN;
      void main() { vPos = (modelMatrix * vec4(position, 1.0)).xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0); }`,
    fragmentShader: `
      uniform vec3 e; uniform vec3 sdir; uniform float h; uniform float w;
      varying vec3 vPos; varying vec3 vN;
      void main() {
        vec3 n = normalize(vN);
        vec3 k = normalize(cross(e, sdir));
        float nk = dot(n, k);
        if (abs(nk) < 1e-3) { gl_FragColor = vec4(0.55, 0.55, 0.6, 1.0); return; }
        float lam = (h - dot(vPos, k)) / nk;
        float sig = dot(vPos + lam * n, sdir) / w;
        float f = abs(fract(sig) - 0.5);
        float line = 1.0 - smoothstep(0.03, 0.08, f);
        float shade = 0.75 + 0.25 * abs(nk);
        gl_FragColor = vec4(mix(vec3(shade), vec3(0.05, 0.1, 0.35), line), 1.0);
      }`,
  });
}

/** Textura matcap às riscas: com a normal em coordenadas de vista dá as riscas de zebra (reflexo de luzes em tubo). */
function zebraTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  for (let y = 0; y < 256; y += 10) { g.fillStyle = (y / 10) % 2 ? "#111" : "#f5f5f5"; g.fillRect(0, y, 256, 10); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Mapa de cores divergente (azul → branco → vermelho) para t ∈ [−1, 1]. */
export function divergingColor(t: number, out: THREE.Color): THREE.Color {
  const x = Math.max(-1, Math.min(1, t));
  return x < 0 ? out.setRGB(1 + x * 0.85, 1 + x * 0.6, 1) : out.setRGB(1, 1 - x * 0.6, 1 - x * 0.85);
}

/** Escala robusta: percentil 95 de |v| (os picos nas arestas não esmagam o resto). */
export function robustScale(values: ArrayLike<number>): number {
  const a = Array.from(values, Math.abs).filter((x) => x > 0).sort((p, q) => p - q);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : 0;
}

type Hit =
  | { kind: "face"; index: number; point: THREE.Vector3 }
  | { kind: "edge"; index: number; point: THREE.Vector3 }
  | { kind: "plane"; ref: PlaneRef; label: string; point: THREE.Vector3 }
  | { kind: "region"; index: number; point: THREE.Vector3 };

interface CamState { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number; size: number }

/** Rede de controlo de uma superfície de forma livre (polos linha a linha, u maior). */
export interface PoleNet { nu: number; nv: number; poles: number[] }

type Drag = {
  button: number;
  mode: "rotate" | "pan" | "zoom" | "roll" | "box" | "gesture" | "pending" | "pole";
  pole?: { k: number; start: THREE.Vector3; plane: THREE.Plane; delta: THREE.Vector3 };
  start: [number, number];
  last: [number, number];
  path: [number, number][];
  moved: boolean;
  shift: boolean;
  ctrl: boolean;
};

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  /** Ponto para onde a câmara olha (e, por defeito, centro de rotação). */
  readonly target = new THREE.Vector3();
  private pivot: THREE.Vector3 | null = null;
  private pivotMarker: THREE.Mesh;
  private bodyGroup = new THREE.Group();
  private refGroup = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private mesh: MeshData | null = null;
  private faceMesh: THREE.Mesh | null = null;
  private edgeLines: THREE.LineSegments | null = null;
  private faceOfTri: Int32Array = new Int32Array(0);
  private faceVerts: [number, number][] = [];
  private planeMeshes: { mesh: THREE.Mesh; ref: PlaneRef; label: string }[] = [];
  private regionGroup = new THREE.Group();
  private regionMeshes: { mesh: THREE.Mesh; sketch: string; sig: string[]; seed: [number, number] }[] = [];
  private hover: Hit | null = null;
  private selected = new Set<string>();
  private featureHighlight: string | null = null;
  private theme: Theme = themes.light;
  private ray = new THREE.Raycaster();
  private accept: PickKind[] | null = null;
  private drag: Drag | null = null;
  private lastMiddleUp = 0;
  private history: CamState[] = [];
  private boxEl: HTMLDivElement;
  private gestureEl: HTMLDivElement;
  private size = 200;
  private el: HTMLElement;
  private lastResult: RebuildResponse | null = null;
  private analysis: Analysis | null = null;
  private overlayGroup = new THREE.Group();
  private zebraMat: THREE.MeshMatcapMaterial | null = null;
  private highlightMat: THREE.ShaderMaterial | null = null;
  private analysisGroup = new THREE.Group();
  private poleGroup = new THREE.Group();
  private poleNet: PoleNet | null = null;
  private poleSel: number = -1;
  /** Restrição do arrasto de polos: livre (no plano do ecrã) ou ao longo de um eixo. */
  poleAxis: "free" | "X" | "Y" | "Z" = "free";
  onPoleSelect: (i: number, j: number) => void = () => {};
  onPoleMoved: (i: number, j: number, d: Vec3) => void = () => {};
  private shadedMat: THREE.Material | null = null;
  settings: Settings;

  onPick: (p: Pick, additive: boolean, at: [number, number]) => void = () => {};
  onEmptyClick: () => void = () => {};
  onHover: (h: { kind: "face" | "edge" | "plane"; type: string; name: string } | null) => void = () => {};
  onContextMenu: (at: [number, number], pick: Pick | null) => void = () => {};
  onGesture: (dir: GestureDir) => void = () => {};
  onBoxSelect: (picks: Pick[], additive: boolean) => void = () => {};
  onDoubleClick: (pick: Pick) => void = () => {};
  onGestureTrack: (dir: GestureDir | null, at: [number, number] | null) => void = () => {};

  constructor(el: HTMLElement, settings: Settings) {
    this.el = el;
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    el.appendChild(this.renderer.domElement);
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(1, -1, 1).multiplyScalar(1000);
    this.camera.lookAt(this.target);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 1.8));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    this.camera.add(key);
    key.position.set(0.5, 1, 1);
    this.pivotMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf97316, depthTest: false }));
    this.pivotMarker.visible = false;
    this.pivotMarker.renderOrder = 10;
    this.scene.add(this.camera, this.bodyGroup, this.refGroup, this.sketchGroup, this.regionGroup, this.pivotMarker);
    this.boxEl = Object.assign(document.createElement("div"), { className: "box-select" });
    this.gestureEl = Object.assign(document.createElement("div"), { className: "gesture-trail" });
    el.append(this.boxEl, this.gestureEl);
    new ResizeObserver(() => this.resize()).observe(el);
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const setTheme = () => { this.theme = themes[dark.matches ? "dark" : "light"]; this.scene.background = new THREE.Color(this.theme.bg); this.recolor(); };
    dark.addEventListener("change", setTheme);
    setTheme();
    this.resize();
    const cv = this.renderer.domElement;
    cv.addEventListener("pointerdown", (e) => this.onDown(e));
    cv.addEventListener("pointermove", (e) => this.onMove(e));
    cv.addEventListener("pointerup", (e) => this.onUp(e));
    cv.addEventListener("pointerleave", () => { if (!this.drag) this.setHover(null); });
    cv.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("dblclick", (e) => this.onDblClick(e));
    cv.addEventListener("auxclick", (e) => e.preventDefault());
    this.renderer.setAnimationLoop(() => this.renderer.render(this.scene, this.camera));
  }

  private resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h);
    const a = w / h;
    this.camera.left = -this.size * a; this.camera.right = this.size * a;
    this.camera.top = this.size; this.camera.bottom = -this.size;
    this.camera.updateProjectionMatrix();
    this.publish();
  }

  /** Estado da vista em atributos do elemento (útil para testes e depuração). */
  private publish() {
    const d = this.viewDir();
    this.el.dataset.viewDir = d.toArray().map((v) => v.toFixed(3)).join(",");
    this.el.dataset.zoom = this.camera.zoom.toFixed(4);
  }

  /** Tipos de entidade selecionáveis (null = todos). */
  setAccept(kinds: PickKind[] | null) { this.accept = kinds; }

  setSelected(keys: string[]) { this.selected = new Set(keys); this.recolor(); }

  /** Realça as faces criadas por uma feature (ao passar o rato na árvore). */
  setFeatureHighlight(fid: string | null) { if (fid !== this.featureHighlight) { this.featureHighlight = fid; this.recolor(); } }

  // --- conteúdo ----------------------------------------------------------------

  update(result: RebuildResponse | null, doc: CadDocument, opts: { hideSketch?: string; showPlanes: boolean }) {
    this.lastResult = result;
    this.setMesh(result?.mesh ?? null);
    this.setReferences(result, doc, opts.showPlanes || this.settings.showPlanes);
    this.setSketches(result, doc, opts.hideSketch);
    this.applyDisplayStyle();
  }

  private disposeGroup(g: THREE.Group) {
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
    g.clear();
  }

  private setMesh(mesh: MeshData | null) {
    this.disposeGroup(this.bodyGroup);
    this.mesh = mesh;
    this.faceMesh = null;
    this.edgeLines = null;
    if (!mesh) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.vertices.length), 3));
    g.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
    // triângulo → face e intervalo de vértices de cada face (para colorir)
    this.faceOfTri = new Int32Array(mesh.triangles.length / 3);
    this.faceVerts = mesh.faces.map((f, i) => {
      let lo = Infinity, hi = -1;
      for (let k = f.start; k < f.start + f.count; k++) { const v = mesh.triangles[k]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
      for (let t = f.start / 3; t < (f.start + f.count) / 3; t++) this.faceOfTri[t] = i;
      return [lo, hi];
    });
    this.shadedMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.faceMesh = new THREE.Mesh(g, this.faceMaterial());
    const eg = new THREE.BufferGeometry();
    eg.setAttribute("position", new THREE.BufferAttribute(mesh.lines, 3));
    eg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.lines.length), 3));
    this.edgeLines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.bodyGroup.add(this.faceMesh, this.edgeLines);
    this.recolor();
  }

  /** Malhas sobrepostas a vermelho (ex.: volumes de interferência), por cima do modelo. */
  setOverlay(meshes: MeshData[]) {
    this.disposeGroup(this.overlayGroup);
    if (!this.overlayGroup.parent) this.scene.add(this.overlayGroup);
    for (const m of meshes) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(m.vertices, 3));
      g.setIndex(new THREE.BufferAttribute(m.triangles, 1));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.6, depthTest: false, side: THREE.DoubleSide }));
      mesh.renderOrder = 6;
      this.overlayGroup.add(mesh);
    }
    this.el.dataset.overlay = String(meshes.length);
  }

  /** Mostra as regiões escolhíveis de um esboço (contornos selecionados), por cima do modelo. */
  setRegions(sketch: string | null, view: RebuildResponse["sketches"][string] | null) {
    this.disposeGroup(this.regionGroup);
    this.regionMeshes = [];
    if (!sketch || !view) return;
    const f = view.frame;
    for (const r of view.regionList) {
      const pos = new Float32Array((r.tris.length / 2) * 3);
      for (let i = 0, j = 0; i < r.tris.length; i += 2, j += 3) {
        const x = r.tris[i], y = r.tris[i + 1];
        pos[j] = f.o[0] + f.x[0] * x + f.y[0] * y;
        pos[j + 1] = f.o[1] + f.x[1] * x + f.y[1] * y;
        pos[j + 2] = f.o[2] + f.x[2] * x + f.y[2] * y;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x9333ea, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
      mesh.renderOrder = 5;
      this.regionGroup.add(mesh);
      this.regionMeshes.push({ mesh, sketch, sig: r.sig, seed: r.seed });
    }
    this.recolor();
  }

  private zebra() {
    this.zebraMat ??= new THREE.MeshMatcapMaterial({ matcap: zebraTexture(), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    return this.zebraMat;
  }

  /** Mostra (ou esconde) a rede de controlo da forma livre em edição e o polo selecionado. */
  setPoleNet(net: PoleNet | null, sel: [number, number] | null) {
    this.poleNet = net;
    this.poleSel = net && sel ? sel[0] * net.nv + sel[1] : -1;
    this.drawPoles();
  }

  private drawPoles(preview?: { k: number; p: THREE.Vector3 }) {
    this.disposeGroup(this.poleGroup);
    if (!this.poleGroup.parent) this.scene.add(this.poleGroup);
    const net = this.poleNet;
    this.el.dataset.poles = net ? String(net.nu * net.nv) : "";
    if (!net) return;
    const pos = new Float32Array(net.poles);
    if (preview) pos.set([preview.p.x, preview.p.y, preview.p.z], preview.k * 3);
    const col = new Float32Array(pos.length);
    const c = new THREE.Color();
    for (let k = 0; k < pos.length / 3; k++) { c.set(k === this.poleSel || k === preview?.k ? 0xdc2626 : 0x7c3aed); col.set([c.r, c.g, c.b], k * 3); }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    pg.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(pg, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false }));
    pts.renderOrder = 9;
    const seg: number[] = [];
    const at = (i: number, j: number) => [pos[(i * net.nv + j) * 3], pos[(i * net.nv + j) * 3 + 1], pos[(i * net.nv + j) * 3 + 2]];
    for (let i = 0; i < net.nu; i++) for (let j = 0; j < net.nv; j++) {
      if (i + 1 < net.nu) seg.push(...at(i, j), ...at(i + 1, j));
      if (j + 1 < net.nv) seg.push(...at(i, j), ...at(i, j + 1));
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(seg), 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.7, depthTest: false }));
    lines.renderOrder = 8;
    this.poleGroup.add(lines, pts);
  }

  /** Índice do polo sob o cursor (a menos de 9 px), ou −1. */
  private poleAt(ev: { clientX: number; clientY: number }): number {
    const net = this.poleNet;
    if (!net) return -1;
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    let best = -1, bestD = 9;
    for (let k = 0; k < net.poles.length / 3; k++) {
      v.set(net.poles[k * 3], net.poles[k * 3 + 1], net.poles[k * 3 + 2]).project(this.camera);
      const d = Math.hypot(((v.x + 1) / 2) * r.width - (ev.clientX - r.left), ((1 - v.y) / 2) * r.height - (ev.clientY - r.top));
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  /** Material das faces conforme a análise (zebra, linhas de realce ou sombreado com cores). */
  private faceMaterial(): THREE.Material {
    const a = this.analysis;
    if (a?.kind === "zebra") return this.zebra();
    if (a?.kind === "highlight") {
      this.highlightMat ??= highlightMaterial();
      const u = this.highlightMat.uniforms;
      const axes = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] } as const;
      const e = axes[a.axis];
      // luzes acima do modelo: plano perpendicular ao eixo "mais vertical" que não é o das luzes
      const up = a.axis === "Z" ? axes.Y : axes.Z;
      const sdir = new THREE.Vector3(...e).cross(new THREE.Vector3(...up)).normalize();
      u.e.value.set(...e);
      u.sdir.value.copy(sdir);
      const k = new THREE.Vector3(...e).cross(sdir);
      u.h.value = this.size * 1.5 * k.dot(new THREE.Vector3(...up));
      u.w.value = a.spacing;
      return this.highlightMat;
    }
    return this.shadedMat!;
  }

  /** Análise de superfície: zebra/realce (materiais), inclinação e curvatura (cores), pentes (linhas). */
  setAnalysis(a: Analysis | null) {
    this.analysis = a;
    if (this.faceMesh && this.shadedMat) this.faceMesh.material = this.faceMaterial();
    this.el.dataset.analysis = a?.kind ?? "";
    this.disposeGroup(this.analysisGroup);
    if (!this.analysisGroup.parent) this.scene.add(this.analysisGroup);
    if (a?.kind === "combs" && a.data) {
      const add = (arr: Float32Array, color: number) => {
        if (!arr.length) return;
        const g = new THREE.BufferGeometry();
        // as cerdas são desenhadas com o ganho escolhido na interface (a partir da base de cada cerda)
        const pos = arr.slice();
        if (a.gain !== 1 && arr === a.data!.quills) for (let i = 0; i < pos.length; i += 6) for (let k = 0; k < 3; k++) pos[i + 3 + k] = pos[i + k] + (pos[i + 3 + k] - pos[i + k]) * a.gain;
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
        l.renderOrder = 7;
        this.analysisGroup.add(l);
      };
      add(a.data.quills, 0x7c3aed);
      if (a.gain === 1) add(a.data.envelope, 0xdb2777);
      this.el.dataset.combs = String(a.data.quills.length / 6);
    }
    this.recolor();
  }

  /** Estilo de visualização: sombreado com arestas, sombreado, ou arestas (fio de arame). */
  setDisplayStyle(style: Settings["displayStyle"]) { this.settings.displayStyle = style; this.applyDisplayStyle(); }

  private applyDisplayStyle() {
    const style = this.settings.displayStyle;
    if (this.faceMesh) {
      const m = this.faceMesh.material as THREE.MeshStandardMaterial;
      m.transparent = style === "wireframe";
      m.opacity = style === "wireframe" ? 0.06 : 1;
      m.depthWrite = style !== "wireframe";
      m.needsUpdate = true;
    }
    if (this.edgeLines) {
      this.edgeLines.visible = style !== "shaded";
      (this.edgeLines.material as THREE.LineBasicMaterial).depthTest = style !== "wireframe";
    }
  }

  private planeQuad(f: Frame, size: number, color: number, opacity: number) {
    const geo = new THREE.PlaneGeometry(size, size);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
    const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.z));
    m.quaternion.setFromRotationMatrix(basis);
    m.position.set(...f.o);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity * 4) }));
    m.add(edges);
    return m;
  }

  private setReferences(result: RebuildResponse | null, doc: CadDocument, showStd: boolean) {
    this.disposeGroup(this.refGroup);
    this.planeMeshes = [];
    const s = this.modelSize(result) * 0.6;
    if (showStd) {
      for (const n of ["XY", "XZ", "YZ"] as StdPlane[]) {
        const m = this.planeQuad(STD[n], s, this.theme.plane, 0.05);
        this.refGroup.add(m);
        this.planeMeshes.push({ mesh: m, ref: { kind: "std", name: n }, label: `Plano ${n}` });
      }
    }
    const visible = (id: string) => { const f = doc.features.find((x) => x.id === id); return f && !f.suppressed; };
    for (const [id, f] of Object.entries(result?.planes ?? {})) {
      if (!visible(id)) continue;
      const m = this.planeQuad(f, s * 0.8, 0x22a06b, 0.08);
      this.refGroup.add(m);
      this.planeMeshes.push({ mesh: m, ref: { kind: "datum", feature: id }, label: doc.features.find((x) => x.id === id)?.name ?? id });
    }
    for (const [id, a] of Object.entries(result?.axes ?? {})) {
      if (!visible(id)) continue;
      const p0 = new THREE.Vector3(...a.o).addScaledVector(new THREE.Vector3(...a.d), -s / 2);
      const p1 = new THREE.Vector3(...a.o).addScaledVector(new THREE.Vector3(...a.d), s / 2);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p0, p1]), new THREE.LineDashedMaterial({ color: 0x22a06b, dashSize: s / 40, gapSize: s / 80 }));
      line.computeLineDistances();
      this.refGroup.add(line);
    }
    for (const [, f] of Object.entries(result?.csys ?? {})) {
      const h = new THREE.AxesHelper(s / 4);
      const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.z));
      h.quaternion.setFromRotationMatrix(basis);
      h.position.set(...f.o);
      this.refGroup.add(h);
    }
    this.refGroup.add(new THREE.AxesHelper(s / 6));
  }

  private setSketches(result: RebuildResponse | null, doc: CadDocument, hide?: string) {
    this.disposeGroup(this.sketchGroup);
    if (!result) return;
    for (const [id, sv] of Object.entries(result.sketches)) {
      if (id === hide) continue;
      const f = doc.features.find((x) => x.id === id);
      if (!f || f.suppressed) continue;
      // esconder esboços já consumidos por features (como no SolidWorks)
      const used = doc.features.some((x) => JSON.stringify(x).includes(`"${id}"`) && x.id !== id);
      if (used) continue;
      const ents = allEntities({ entities: sv.entities });
      const pts: THREE.Vector3[] = [];
      for (const [eid, e] of Object.entries(sv.entities)) {
        if (e.type === "point") continue;
        const poly = sampleEntity(ents, eid);
        for (let i = 0; i < poly.length - 1; i++) {
          for (const p of [poly[i], poly[i + 1]]) {
            const v = sv.frame;
            pts.push(new THREE.Vector3(v.o[0] + v.x[0] * p[0] + v.y[0] * p[1], v.o[1] + v.x[1] * p[0] + v.y[1] * p[1], v.o[2] + v.x[2] * p[0] + v.y[2] * p[1]));
          }
        }
      }
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      this.sketchGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: this.theme.sketch })));
    }
  }

  private modelSize(result: RebuildResponse | null) {
    const m = result?.mass;
    if (!m) return 200;
    const d = Math.hypot(m.bbox.max[0] - m.bbox.min[0], m.bbox.max[1] - m.bbox.min[1], m.bbox.max[2] - m.bbox.min[2]);
    return Math.max(50, d * 1.2);
  }

  // --- cores e seleção ---------------------------------------------------------------

  private keyOf(h: Hit): string {
    if (h.kind === "face") return `face:${this.mesh!.faces[h.index].name}`;
    if (h.kind === "edge") return `edge:${this.mesh!.edges[h.index].name}`;
    if (h.kind === "region") return `region:${this.regionMeshes[h.index].sig.join("+")}`;
    return `plane:${JSON.stringify(h.ref)}`;
  }

  private recolor() {
    const hk = this.hover ? this.keyOf(this.hover) : "";
    for (const r of this.regionMeshes) {
      const k = `region:${r.sig.join("+")}`;
      const m = r.mesh.material as THREE.MeshBasicMaterial;
      m.color.set(this.selected.has(k) ? this.theme.sel : k === hk ? this.theme.hover : 0x9333ea);
      m.opacity = this.selected.has(k) || k === hk ? 0.55 : 0.22;
    }
    for (const p of this.planeMeshes) {
      const k = `plane:${JSON.stringify(p.ref)}`;
      const hoverKey = this.hover ? this.keyOf(this.hover) : "";
      (p.mesh.material as THREE.MeshBasicMaterial).color.set(this.selected.has(k) ? this.theme.sel : k === hoverKey ? this.theme.hover : p.ref.kind === "std" ? this.theme.plane : 0x22a06b);
    }
    if (!this.mesh || !this.faceMesh || !this.edgeLines) return;
    const col = this.faceMesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const c = new THREE.Color();
    const hoverKey = this.hover ? this.keyOf(this.hover) : "";
    // "@c2" realça o componente c2 da montagem (nomes "c2|…" e "c2/…|…")
    const fhComp = this.featureHighlight?.startsWith("@") ? this.featureHighlight.slice(1) : null;
    const fh = this.featureHighlight && !fhComp ? `${this.featureHighlight}:` : null;
    const a = this.analysis;
    const nrm = this.mesh.normals;
    const dir = a?.kind === "draft" ? { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[a.dir] : null;
    const sinT = a?.kind === "draft" ? Math.sin((a.angle * Math.PI) / 180) : 0;
    const curv = a?.kind === "curvature" && a.data && a.data.values.length === this.mesh.vertices.length / 3 ? a.data.values : null;
    const scale = (curv && robustScale(curv)) || 1;
    this.mesh.faces.forEach((f, i) => {
      const k = `face:${f.name}`;
      const [lo, hi] = this.faceVerts[i];
      const inComp = fhComp && (f.name.startsWith(`${fhComp}|`) || f.name.startsWith(`${fhComp}/`));
      const flat = this.selected.has(k) ? this.theme.sel : k === hoverKey ? this.theme.hover : (fh && f.name.startsWith(fh)) || inComp ? this.theme.feat : null;
      if (flat === null && (dir || curv)) {
        for (let v = lo; v <= hi; v++) {
          if (dir) {
            const d = nrm[v * 3] * dir[0] + nrm[v * 3 + 1] * dir[1] + nrm[v * 3 + 2] * dir[2];
            c.set(d >= sinT ? 0x22c55e : d <= -sinT ? 0xef4444 : 0xfacc15);
          } else divergingColor(curv![v] / scale, c);
          col.setXYZ(v, c.r, c.g, c.b);
        }
        return;
      }
      c.set(flat ?? (f.body ? this.theme.sheet : this.theme.body));
      for (let v = lo; v <= hi; v++) col.setXYZ(v, c.r, c.g, c.b);
    });
    col.needsUpdate = true;
    const ecol = this.edgeLines.geometry.getAttribute("color") as THREE.BufferAttribute;
    const dev = a?.kind === "deviation" && a.data ? new Map(a.data.edges.map((x) => [x.name, x.deg])) : null;
    const cont = a?.kind === "continuity" && a.data ? new Map(a.data.edges.map((x) => [x.name, x.cls])) : null;
    this.mesh.edges.forEach((e) => {
      const k = `edge:${e.name}`;
      const d = dev?.get(e.name);
      const cl = cont?.get(e.name);
      const base = cl !== undefined ? CONTINUITY_COLORS[cl]
        : d === undefined ? (e.curve ? this.theme.curve : this.theme.edge) : d <= 0.5 ? 0x16a34a : d <= 10 ? 0xf59e0b : 0x6b7280;
      c.set(this.selected.has(k) ? this.theme.sel : k === hoverKey ? this.theme.hover : base);
      for (let v = e.start; v < e.start + e.count; v++) ecol.setXYZ(v, c.r, c.g, c.b);
    });
    ecol.needsUpdate = true;
  }

  private setHover(h: Hit | null) {
    const same = (a: Hit | null, b: Hit | null) => (a && b ? this.keyOf(a) === this.keyOf(b) : a === b);
    if (same(h, this.hover)) return;
    this.hover = h;
    this.recolor();
    if (!h) this.onHover(null);
    else if (h.kind === "face") { const f = this.mesh!.faces[h.index]; this.onHover({ kind: "face", type: f.type, name: f.name }); }
    else if (h.kind === "edge") { const e = this.mesh!.edges[h.index]; this.onHover({ kind: "edge", type: e.type, name: e.name }); }
    else if (h.kind === "region") this.onHover({ kind: "plane", type: "region", name: `Região: ${this.regionMeshes[h.index].sig.join(" + ")}` });
    else this.onHover({ kind: "plane", type: "plane", name: h.label });
  }

  private local(ev: { clientX: number; clientY: number }): [number, number] {
    const r = this.renderer.domElement.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  private worldPerPx() {
    return (this.camera.top - this.camera.bottom) / this.camera.zoom / (this.el.clientHeight || 1);
  }

  private hitTest(ev: { clientX: number; clientY: number }, accept = this.accept): Hit | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const ok = (k: PickKind) => !accept || accept.includes(k);
    const wpp = this.worldPerPx();
    this.ray.params.Line = { threshold: wpp * 6 };
    if (ok("region") && this.regionMeshes.length) {
      const rh = this.ray.intersectObjects(this.regionMeshes.map((r) => r.mesh), false)[0];
      if (rh) return { kind: "region", index: this.regionMeshes.findIndex((r) => r.mesh === rh.object), point: rh.point };
      if (accept?.length === 1) return null;
    }
    let faceHit: THREE.Intersection | undefined;
    if (this.faceMesh) faceHit = this.ray.intersectObject(this.faceMesh)[0];
    if (this.edgeLines && this.edgeLines.visible !== false && ok("edge")) {
      const eh = this.ray.intersectObject(this.edgeLines)[0];
      if (eh && (!faceHit || eh.distance <= faceHit.distance + wpp * 8 || this.settings.displayStyle === "wireframe") && eh.index !== undefined) {
        const vi = eh.index;
        const idx = this.mesh!.edges.findIndex((e) => vi >= e.start && vi < e.start + e.count);
        if (idx >= 0) return { kind: "edge", index: idx, point: eh.point };
      }
    }
    if (faceHit && faceHit.faceIndex != null && ok("face")) return { kind: "face", index: this.faceOfTri[faceHit.faceIndex], point: faceHit.point };
    if (faceHit) return null;
    if (ok("plane")) {
      const ph = this.ray.intersectObjects(this.planeMeshes.map((p) => p.mesh), false)[0];
      if (ph) { const p = this.planeMeshes.find((x) => x.mesh === ph.object)!; return { kind: "plane", ref: p.ref, label: p.label, point: ph.point }; }
    }
    return null;
  }

  private toPick(h: Hit): Pick {
    if (h.kind === "face") { const f = this.mesh!.faces[h.index]; return { kind: "face", name: f.name, type: f.type, hint: { c: f.center, n: f.normal }, body: f.body, point: [h.point.x, h.point.y, h.point.z] }; }
    if (h.kind === "edge") { const e = this.mesh!.edges[h.index]; return { kind: "edge", name: e.name, type: e.type, hint: { c: e.mid, n: e.dir } }; }
    if (h.kind === "region") { const r = this.regionMeshes[h.index]; return { kind: "region", sketch: r.sketch, sig: r.sig, seed: r.seed }; }
    return { kind: "plane", ref: h.ref, label: h.label };
  }

  /** Elemento (face/aresta/plano) sob um ponto do ecrã, sem filtro. */
  pickAt(clientX: number, clientY: number): Pick | null {
    const h = this.hitTest({ clientX, clientY }, null);
    return h ? this.toPick(h) : null;
  }

  // --- rato ------------------------------------------------------------------------

  private onDown(e: PointerEvent) {
    const p = this.local(e);
    this.renderer.domElement.setPointerCapture(e.pointerId);
    let mode: Drag["mode"] = "pending";
    const pk = e.button === 0 ? this.poleAt(e) : -1;
    if (pk >= 0 && this.poleNet) {
      const n = this.poleNet.poles;
      const start = new THREE.Vector3(n[pk * 3], n[pk * 3 + 1], n[pk * 3 + 2]);
      const normal = new THREE.Vector3();
      this.camera.getWorldDirection(normal);
      this.drag = { button: 0, mode: "pole", start: p, last: p, path: [p], moved: false, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey,
        pole: { k: pk, start, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, start), delta: new THREE.Vector3() } };
      return;
    }
    if (e.button === 1) mode = e.ctrlKey ? "pan" : e.shiftKey ? "zoom" : e.altKey ? "roll" : "rotate";
    else if (e.button === 2) mode = "gesture";
    else if (e.button === 0) mode = this.hitTest(e) ? "pending" : "box";
    this.drag = { button: e.button, mode, start: p, last: p, path: [p], moved: false, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    if (e.button === 1) {
      e.preventDefault();
      if (mode === "rotate" && !this.pivot) this.pivot = this.target.clone();
    }
  }

  private onMove(e: PointerEvent) {
    const p = this.local(e);
    const d = this.drag;
    if (!d) { this.setHover(this.hitTest(e)); return; }
    const dx = p[0] - d.last[0], dy = p[1] - d.last[1];
    if (!d.moved && Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) > 4) {
      d.moved = true;
      if (d.mode === "rotate" || d.mode === "pan" || d.mode === "zoom" || d.mode === "roll") this.pushHistory();
    }
    d.last = p;
    if (!d.moved) return;
    switch (d.mode) {
      case "rotate": this.rotateBy(dx * 0.5, dy * 0.5, this.pivot ?? this.target); break;
      case "pan": this.panBy(dx, dy); break;
      case "zoom": this.zoomAt(Math.exp(dy * 0.01), d.start); break;
      case "roll": this.roll(dx * 0.5); break;
      case "box": this.drawBox(d.start, p); break;
      case "pole": {
        const pl = d.pole!;
        const r = this.renderer.domElement.getBoundingClientRect();
        this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
        const hit = new THREE.Vector3();
        if (!this.ray.ray.intersectPlane(pl.plane, hit)) break;
        const delta = hit.sub(pl.start);
        if (this.poleAxis !== "free") {
          const ax = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) }[this.poleAxis];
          delta.copy(ax.multiplyScalar(delta.dot(ax)));
        }
        pl.delta.copy(delta);
        this.drawPoles({ k: pl.k, p: pl.start.clone().add(delta) });
        break;
      }
      case "gesture": {
        d.path.push(p);
        this.drawGesture(d.path);
        this.onGestureTrack(this.gestureDir(d.start, p), [e.clientX, e.clientY]);
        break;
      }
    }
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const p = this.local(e);
    if (d.button === 1) {
      const now = performance.now();
      if (!d.moved) {
        if (now - this.lastMiddleUp < 350) { this.fit(this.lastResult); this.lastMiddleUp = 0; return; }
        this.lastMiddleUp = now;
        // clique no meio sobre a geometria: centro de rotação nesse ponto
        const h = this.hitTest(e, null);
        this.setPivot(h ? h.point : null);
      }
      this.publish();
      return;
    }
    if (d.button === 2) {
      this.gestureEl.replaceChildren();
      this.onGestureTrack(null, null);
      const dir = this.gestureDir(d.start, p);
      if (d.moved && dir) this.onGesture(dir);
      else {
        const h = this.hitTest(e, null);
        this.onContextMenu([e.clientX, e.clientY], h ? this.toPick(h) : null);
      }
      return;
    }
    if (d.button !== 0) return;
    if (d.mode === "pole" && d.pole && this.poleNet) {
      const nv = this.poleNet.nv;
      const i = Math.floor(d.pole.k / nv), j = d.pole.k % nv;
      const r3 = (x: number) => Math.round(x * 1000) / 1000;
      if (d.moved) this.onPoleMoved(i, j, [r3(d.pole.delta.x), r3(d.pole.delta.y), r3(d.pole.delta.z)]);
      else this.onPoleSelect(i, j);
      return;
    }
    if (d.mode === "box") {
      this.boxEl.style.display = "none";
      if (d.moved) { this.onBoxSelect(this.boxSelect(d.start, p), d.ctrl || d.shift); return; }
      this.onEmptyClick();
      return;
    }
    if (d.moved) return;
    const h = this.hitTest(e);
    if (!h) { this.onEmptyClick(); return; }
    this.onPick(this.toPick(h), e.ctrlKey || e.shiftKey || e.metaKey, [e.clientX, e.clientY]);
  }

  private onDblClick(e: MouseEvent) {
    if (e.button !== 0) return;
    const h = this.hitTest(e, null);
    if (h) this.onDoubleClick(this.toPick(h));
  }

  private wheelAt = 0;
  private onWheel(e: WheelEvent) {
    e.preventDefault();
    // uma sequência de roda conta como uma só mudança de vista no histórico
    if (performance.now() - this.wheelAt > 500) this.pushHistory();
    this.wheelAt = performance.now();
    // SolidWorks: roda para a frente (deltaY < 0) afasta; "reverseWheel" inverte
    let f = Math.exp(-e.deltaY * 0.0015);
    if (this.settings.reverseWheel) f = 1 / f;
    this.zoomAt(f, this.local(e));
  }

  private gestureDir(a: [number, number], b: [number, number]): GestureDir | null {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (Math.hypot(dx, dy) < 40) return null;
    const ang = (Math.atan2(-dy, dx) * 180) / Math.PI; // 0 = direita, 90 = cima
    const dirs: GestureDir[] = ["right", "upRight", "up", "upLeft", "left", "downLeft", "down", "downRight"];
    return dirs[((Math.round(ang / 45) % 8) + 8) % 8];
  }

  private drawBox(a: [number, number], b: [number, number]) {
    const s = this.boxEl.style;
    s.display = "block";
    s.left = `${Math.min(a[0], b[0])}px`; s.top = `${Math.min(a[1], b[1])}px`;
    s.width = `${Math.abs(b[0] - a[0])}px`; s.height = `${Math.abs(b[1] - a[1])}px`;
    // → janela (contínua): só o que está totalmente dentro; ← cruzamento (tracejada): o que toca
    this.boxEl.classList.toggle("crossing", b[0] < a[0]);
  }

  private drawGesture(path: [number, number][]) {
    const svg = `<svg width="100%" height="100%"><polyline points="${path.map((p) => p.join(",")).join(" ")}" /></svg>`;
    this.gestureEl.innerHTML = svg;
  }

  /** Seleção por caixa: arestas (e faces, se o filtro as aceitar) dentro da caixa ou que a cruzam. */
  boxSelect(a: [number, number], b: [number, number]): Pick[] {
    if (!this.mesh) return [];
    const crossing = b[0] < a[0];
    const [x0, x1, y0, y1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    const w = this.el.clientWidth, h = this.el.clientHeight;
    const v = new THREE.Vector3();
    const inside = (arr: Float32Array, i: number) => {
      v.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]).project(this.camera);
      const sx = ((v.x + 1) / 2) * w, sy = ((1 - v.y) / 2) * h;
      return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
    };
    const test = (arr: Float32Array, idx: Iterable<number>) => {
      let any = false, all = true;
      for (const i of idx) { const ins = inside(arr, i); any ||= ins; all &&= ins; if (crossing && any) return true; }
      return crossing ? any : all;
    };
    const out: Pick[] = [];
    const wantFaces = this.accept?.includes("face") && !this.accept.includes("edge");
    const wantEdges = !this.accept || this.accept.includes("edge");
    if (wantEdges) this.mesh.edges.forEach((e, i) => {
      const idx = Array.from({ length: e.count }, (_, k) => e.start + k);
      if (test(this.mesh!.lines, idx)) out.push(this.toPick({ kind: "edge", index: i, point: new THREE.Vector3() }));
    });
    if (wantFaces) this.mesh.faces.forEach((f, i) => {
      const [lo, hi] = this.faceVerts[i];
      if (test(this.mesh!.vertices, Array.from({ length: hi - lo + 1 }, (_, k) => lo + k))) out.push(this.toPick({ kind: "face", index: i, point: new THREE.Vector3() }));
    });
    return out;
  }

  // --- câmara ------------------------------------------------------------------------

  private viewDir(): THREE.Vector3 { return this.camera.position.clone().sub(this.target).normalize(); }

  private save(): CamState {
    return { pos: this.camera.position.clone(), target: this.target.clone(), up: this.camera.up.clone(), zoom: this.camera.zoom, size: this.size };
  }
  private restore(s: CamState) {
    this.camera.position.copy(s.pos); this.target.copy(s.target); this.camera.up.copy(s.up); this.camera.zoom = s.zoom; this.size = s.size;
    this.camera.lookAt(this.target);
    this.resize();
  }
  private pushHistory() { this.history.push(this.save()); if (this.history.length > 30) this.history.shift(); }

  /** Vista anterior (como Ctrl+Shift+Z no SolidWorks). */
  previousView() { const s = this.history.pop(); if (s) this.restore(s); }

  setPivot(p: THREE.Vector3 | null) {
    this.pivot = p ? p.clone() : null;
    this.pivotMarker.visible = !!p;
    if (p) { this.pivotMarker.position.copy(p); this.pivotMarker.scale.setScalar(this.worldPerPx() * 4); }
  }

  /** Rodar (graus) em torno dos eixos do ecrã, centrado num ponto. */
  rotateBy(degX: number, degY: number, aboutPoint: THREE.Vector3 = this.pivot ?? this.target) {
    const cam = this.camera;
    const about = aboutPoint.clone(); // pode ser o próprio target, que também é rodado
    const up = cam.up.clone().normalize();
    const back = this.viewDir();
    const right = up.clone().cross(back).normalize();
    const screenUp = back.clone().cross(right).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(screenUp, (-degX * Math.PI) / 180)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, (-degY * Math.PI) / 180));
    const rot = (v: THREE.Vector3) => v.sub(about).applyQuaternion(q).add(about);
    rot(cam.position); rot(this.target);
    cam.up.copy(screenUp.applyQuaternion(q));
    cam.lookAt(this.target);
    if (this.pivotMarker.visible) this.pivotMarker.scale.setScalar(this.worldPerPx() * 4);
    this.publish();
  }

  /** Rolar a vista (graus) em torno da direção de visão. */
  roll(deg: number) {
    this.camera.up.applyAxisAngle(this.viewDir(), (deg * Math.PI) / 180);
    this.camera.lookAt(this.target);
    this.publish();
  }

  /** Deslocar a vista em pixels. */
  panBy(dx: number, dy: number) {
    const wpp = this.worldPerPx();
    const back = this.viewDir();
    const right = this.camera.up.clone().cross(back).normalize();
    const up = back.clone().cross(right).normalize();
    const delta = right.multiplyScalar(-dx * wpp).add(up.multiplyScalar(dy * wpp));
    this.camera.position.add(delta);
    this.target.add(delta);
    this.publish();
  }

  /** Zoom por um fator (> 1 afasta, < 1 aproxima), mantendo fixo o ponto sob o cursor. */
  zoomAt(factor: number, at?: [number, number]) {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    const p = at ?? [w / 2, h / 2];
    const before = this.screenToWorld(p);
    this.camera.zoom = Math.min(1e4, Math.max(1e-3, this.camera.zoom / factor));
    this.camera.updateProjectionMatrix();
    const after = this.screenToWorld(p);
    const delta = before.sub(after);
    this.camera.position.add(delta);
    this.target.add(delta);
    this.publish();
  }

  private screenToWorld(p: [number, number]): THREE.Vector3 {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    return new THREE.Vector3((p[0] / w) * 2 - 1, -(p[1] / h) * 2 + 1, 0).unproject(this.camera);
  }

  fit(result: RebuildResponse | null = this.lastResult, record = true) {
    if (record) this.pushHistory();
    const m = result?.mass;
    const c = m ? new THREE.Vector3((m.bbox.min[0] + m.bbox.max[0]) / 2, (m.bbox.min[1] + m.bbox.max[1]) / 2, (m.bbox.min[2] + m.bbox.max[2]) / 2) : new THREE.Vector3();
    this.size = this.modelSize(result) * 0.6;
    const dir = this.viewDir();
    this.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, this.size * 20);
    this.camera.zoom = 1;
    this.camera.lookAt(this.target);
    this.setPivot(null);
    this.resize();
  }

  view(name: ViewName, result: RebuildResponse | null = this.lastResult) {
    this.pushHistory();
    const v = VIEWS[name];
    this.camera.up.set(...v.up);
    this.camera.position.copy(this.target).add(new THREE.Vector3(...v.dir).normalize().multiplyScalar(1000));
    this.camera.lookAt(this.target);
    this.fit(result, false);
  }

  /** Olhar perpendicularmente a um plano (Ctrl+8, "Normal a"). */
  normalTo(o: Vec3, n: Vec3, up?: Vec3) {
    this.pushHistory();
    const nn = new THREE.Vector3(...n).normalize();
    // "para cima" do ecrã: o eixo dado, ou o Z global projetado (ou Y, se a normal for vertical)
    let u = up ? new THREE.Vector3(...up) : new THREE.Vector3(0, 0, 1);
    if (Math.abs(u.dot(nn)) > 0.99) u = new THREE.Vector3(0, 1, 0);
    u.sub(nn.clone().multiplyScalar(u.dot(nn))).normalize();
    const dist = this.camera.position.distanceTo(this.target) || 1000;
    this.target.set(...o);
    this.camera.up.copy(u);
    this.camera.position.copy(this.target).addScaledVector(nn, dist);
    this.camera.lookAt(this.target);
    this.publish();
  }

  /** Converte um ponto 3D em pixels do canvas (para sobreposições). */
  project(p: Vec3): [number, number] {
    const v = new THREE.Vector3(...p).project(this.camera);
    const r = this.renderer.domElement;
    return [((v.x + 1) / 2) * r.clientWidth, ((1 - v.y) / 2) * r.clientHeight];
  }

  screenshot(): string { return this.renderer.domElement.toDataURL("image/png"); }
}

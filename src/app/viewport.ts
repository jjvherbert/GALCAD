// Visualizador 3D (Three.js): corpo, arestas, esboços, geometria de referência, seleção e
// navegação ao estilo do SolidWorks.
//
// Rato:   meio = rodar · Ctrl+meio = deslocar · Shift+meio = zoom · Alt+meio = rolar
//         roda = zoom no cursor · duplo clique no meio = ajustar · clique no meio sobre a peça = centro de rotação
//         esquerdo = selecionar (Ctrl/Shift soma) · arrastar no vazio = caixa (→ janela, ← cruzamento)
//         direito = menu de contexto · arrastar com o direito = gestos
import * as THREE from "three";
import { type ResultView, layerShown } from "../sim/result.ts";
import type { MeshData } from "../kernel/mesh.ts";
import type { RebuildResponse } from "../kernel/protocol.ts";
import type { CadDocument, PlaneRef, Vec3 } from "../doc/types.ts";
import type { Analysis, Pick, PickKind } from "./store.ts";
import type { GestureDir, Settings } from "./settings.ts";
import { onThemeChange, resolvedTheme } from "./theme.ts";
import { VIEWS, type ViewName } from "./viewport-views.ts";
import { CONTINUITY_COLORS, type Theme, divergingColor, highlightMaterial, robustScale, themes, zebraTexture } from "./viewport-style.ts";
import { type SimView, buildSimLayers } from "./viewport-sim.ts";
import { type PlaneMesh, buildReferences, buildSketches, modelSize } from "./viewport-scene.ts";
import { type PoleNet, drawPoleNet, poleAt } from "./viewport-poles.ts";
import { type PmiItem, type PmiLabel, buildPmiLabels, placePmiLabels } from "./viewport-pmi.ts";

export type { PoleNet } from "./viewport-poles.ts";

type Hit =
  | { kind: "face"; index: number; point: THREE.Vector3 }
  | { kind: "edge"; index: number; point: THREE.Vector3 }
  | { kind: "plane"; ref: PlaneRef; label: string; point: THREE.Vector3 }
  | { kind: "region"; index: number; point: THREE.Vector3 };

interface CamState { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number; size: number }

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
  private planeMeshes: PlaneMesh[] = [];
  private regionGroup = new THREE.Group();
  private regionMeshes: { mesh: THREE.Mesh; sketch: string; sig: string[]; seed: [number, number] }[] = [];
  private hover: Hit | null = null;
  private selected = new Set<string>();
  private featureHighlight: string | null = null;
  private conditionFaces: Map<string, number> | null = null;
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
    const setTheme = () => { this.theme = themes[resolvedTheme()]; this.scene.background = new THREE.Color(this.theme.bg); this.recolor(); };
    onThemeChange(setTheme);
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
    this.pmiSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.pmiSvg.setAttribute("class", "pmi-leaders");
    this.pmiEl = Object.assign(document.createElement("div"), { className: "pmi-layer" });
    el.append(this.pmiSvg, this.pmiEl);
    this.renderer.setAnimationLoop(() => { this.stepAnim(); this.stepFlash(); this.renderer.render(this.scene, this.camera); this.placePmi(); });
  }

  // --- PMI 3D ------------------------------------------------------------------------

  private pmiEl: HTMLDivElement;
  private pmiSvg: SVGSVGElement;
  private pmiLabels: PmiLabel[] = [];
  /** Chamado ao clicar num rótulo PMI (id do item). */
  onPmiClick: ((id: string) => void) | null = null;

  /**
   * Rótulos PMI no 3D: o texto do item (quadro de tolerância, cota, referência) afastado da face pela
   * normal, com linha de chamada até ao ponto de ancoragem. Acompanham a câmara a cada imagem.
   */
  setPmi(items: PmiItem[] | null) {
    this.pmiEl.replaceChildren();
    this.pmiSvg.replaceChildren();
    this.pmiLabels = [];
    this.el.dataset.pmi = items ? String(items.length) : "";
    if (!items) return;
    const L = Math.max(4, modelSize(this.lastResult) * 0.18);
    this.pmiLabels = buildPmiLabels(items, this.pmiEl, this.pmiSvg, L, (id) => this.onPmiClick?.(id));
    // posicionar já: sem isto os rótulos novos ficam uma imagem no canto (0,0) até à próxima frame
    this.placePmi();
  }

  private placePmi() {
    placePmiLabels(this.pmiLabels, this.camera, this.renderer.domElement);
  }

  /** Orientação atual da câmara (direção de visão, do alvo para a câmara, e "para cima"). */
  cameraView(): { dir: Vec3; up: Vec3 } {
    return { dir: this.viewDir().toArray() as Vec3, up: this.camera.up.toArray() as Vec3 };
  }

  /** Repõe uma orientação guardada (vista de modelo) e enquadra o modelo. */
  setCameraView(dir: Vec3, up: Vec3) {
    this.pushHistory();
    this.smooth(() => {
      this.camera.up.set(...up);
      this.camera.position.copy(this.target).add(new THREE.Vector3(...dir).normalize().multiplyScalar(1000));
      this.camera.lookAt(this.target);
      this.fitNow(this.lastResult, false);
    });
  }

  private resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.updateProj();
    // a meio de uma transição a câmara está num estado intermédio; os atributos já têm o final
    if (!this.anim) this.publish();
  }

  private updateProj() {
    const a = (this.el.clientWidth || 1) / (this.el.clientHeight || 1);
    this.camera.left = -this.size * a; this.camera.right = this.size * a;
    this.camera.top = this.size; this.camera.bottom = -this.size;
    this.camera.updateProjectionMatrix();
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
  private flashPending: string | null = null;
  private flash: { prefix: string; t0: number } | null = null;
  /** Realce que se desvanece nas faces de uma feature acabada de confirmar. */
  flashFeature(fid: string) { this.flashPending = fid; }
  private previewFeature: string | null = null;
  /** Feature em edição: as faces que ela cria ficam amarelas (pré-visualização, como no SolidWorks). */
  setPreviewFeature(fid: string | null) { if (fid !== this.previewFeature) { this.previewFeature = fid; this.recolor(); } }
  private extHover = "";
  /** Realce vindo de fora do 3D (ex.: botão de um plano no painel); chave como `plane:{...}`. */
  setHoverKey(k: string | null) { if ((k ?? "") !== this.extHover) { this.extHover = k ?? ""; this.recolor(); } }
  setFeatureHighlight(fid: string | null) { if (fid !== this.featureHighlight) { this.featureHighlight = fid; this.recolor(); } }
  /** Cores das faces com condições de simulação (espaços FEM/CFD): o modelo mostra onde estão os apoios e as cargas. */
  setConditionFaces(m: Map<string, number> | null) {
    const same = m && this.conditionFaces && m.size === this.conditionFaces.size && [...m].every(([k, v]) => this.conditionFaces!.get(k) === v);
    if (same || (!m && !this.conditionFaces)) return;
    this.conditionFaces = m && m.size ? m : null;
    this.recolor();
  }

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
      if (!m.userData?.shared) m.geometry?.dispose();
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

  private simGroup = new THREE.Group();

  /**
   * Resultados de simulação em camadas (superfície da malha FEM; patches e cortes CFD): cores do campo
   * escolhido na paleta sequencial, com a mesma escala em todas as camadas visíveis, e deformada
   * ampliada. O corpo fica escondido enquanto se mostram resultados FEM; nos CFD fica em arame.
   */
  setSimResult(r: ResultView | null, view: SimView) {
    this.disposeGroup(this.simGroup);
    if (!this.simGroup.parent) this.scene.add(this.simGroup);
    const fem = !!r?.modes.length || r?.layers.some((l) => l.displacements) === true;
    if (this.faceMesh) this.faceMesh.visible = !r;
    if (this.edgeLines) this.edgeLines.visible = r ? !fem : this.settings.displayStyle !== "shaded";
    this.el.dataset.sim = r ? "1" : "";
    this.el.dataset.simLayers = r ? r.layers.filter((l) => layerShown(l, view.hidden)).map((l) => l.name).join("|") : "";
    if (!r) return;
    const { dmax, k } = buildSimLayers(this.simGroup, r, view, this.size, fem ? this.edgeLines : null);
    this.el.dataset.simScale = dmax > 0 ? k.toPrecision(3) : "";
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
    drawPoleNet(this.poleGroup, this.poleNet, this.poleSel, this.camera, this.renderer.domElement, this.el.dataset, preview);
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
      u.h.value = this.size * 0.8 * k.dot(new THREE.Vector3(...up));
      u.w.value = a.spacing;
      return this.highlightMat;
    }
    return this.shadedMat!;
  }

  /** Análise de superfície: zebra/realce (materiais), inclinação e curvatura (cores), pentes (linhas). */
  setAnalysis(a: Analysis | null) {
    this.analysis = a;
    // linhas de realce: normais exatas do núcleo (as da malha são médias dos triângulos)
    if (this.faceMesh && this.mesh) {
      const exact = a?.kind === "highlight" && a.normals && a.normals.length === this.mesh.normals.length ? a.normals : null;
      this.faceMesh.geometry.setAttribute("normal", new THREE.BufferAttribute(exact ?? this.mesh.normals, 3));
      this.el.dataset.exactNormals = exact ? "1" : "";
    }
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

  /** Definições novas (o store substitui o objeto a cada alteração; nunca o mutar aqui). Os planos aplicam-se no próximo `update`. */
  setSettings(settings: Settings) {
    const restyle = settings.displayStyle !== this.settings.displayStyle;
    this.settings = settings;
    if (restyle) this.applyDisplayStyle();
  }

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

  private setReferences(result: RebuildResponse | null, doc: CadDocument, showStd: boolean) {
    this.disposeGroup(this.refGroup);
    this.planeMeshes = buildReferences(this.refGroup, result, doc, showStd, this.theme.plane);
  }

  private setSketches(result: RebuildResponse | null, doc: CadDocument, hide?: string) {
    this.disposeGroup(this.sketchGroup);
    buildSketches(this.sketchGroup, result, doc, this.theme.sketch, hide);
  }

  // --- cores e seleção ---------------------------------------------------------------

  private keyOf(h: Hit): string {
    if (h.kind === "face") return `face:${this.mesh!.faces[h.index].name}`;
    if (h.kind === "edge") return `edge:${this.mesh!.edges[h.index].name}`;
    if (h.kind === "region") return `region:${this.regionMeshes[h.index].sig.join("+")}`;
    return `plane:${JSON.stringify(h.ref)}`;
  }

  private recolor() {
    const hk = this.hover ? this.keyOf(this.hover) : this.extHover;
    for (const r of this.regionMeshes) {
      const k = `region:${r.sig.join("+")}`;
      const m = r.mesh.material as THREE.MeshBasicMaterial;
      m.color.set(this.selected.has(k) ? this.theme.sel : k === hk ? this.theme.hover : 0x9333ea);
      m.opacity = this.selected.has(k) || k === hk ? 0.55 : 0.22;
    }
    for (const p of this.planeMeshes) {
      const k = `plane:${JSON.stringify(p.ref)}`;
      const hoverKey = this.hover ? this.keyOf(this.hover) : this.extHover;
      (p.mesh.material as THREE.MeshBasicMaterial).color.set(this.selected.has(k) ? this.theme.sel : k === hoverKey ? this.theme.hover : p.ref.kind === "std" ? this.theme.plane : 0x22a06b);
    }
    if (!this.mesh || !this.faceMesh || !this.edgeLines) return;
    const col = this.faceMesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const c = new THREE.Color();
    const hoverKey = this.hover ? this.keyOf(this.hover) : this.extHover;
    // "@c2" realça o componente c2 da montagem (nomes "c2|…" e "c2/…|…")
    const fhComp = this.featureHighlight?.startsWith("@") ? this.featureHighlight.slice(1) : null;
    const fh = this.featureHighlight && !fhComp ? `${this.featureHighlight}:` : null;
    const pv = this.previewFeature ? `${this.previewFeature}:` : null;
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
      const flat = this.selected.has(k) ? this.theme.sel : k === hoverKey ? this.theme.hover : (fh && f.name.startsWith(fh)) || inComp ? this.theme.feat : pv && f.name.startsWith(pv) ? this.theme.preview : this.conditionFaces?.get(f.name) ?? null;
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
      if (flat === null && this.flash && this.flashK > 0 && f.name.startsWith(this.flash.prefix)) c.lerp(this.flashColor.set(this.theme.preview), this.flashK);
      for (let v = lo; v <= hi; v++) col.setXYZ(v, c.r, c.g, c.b);
    });
    col.needsUpdate = true;
    this.el.dataset.previewFaces = String(pv ? this.mesh.faces.filter((f) => f.name.startsWith(pv)).length : 0);
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
    this.finishAnim();
    const p = this.local(e);
    this.renderer.domElement.setPointerCapture(e.pointerId);
    let mode: Drag["mode"] = "pending";
    const pk = e.button === 0 ? poleAt(this.poleNet, this.camera, this.renderer.domElement, e) : -1;
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
    if (h) {
      const pick = this.toPick(h);
      this.el.dataset.lastDblClick = pick.kind === "face" || pick.kind === "edge" ? `${pick.kind}:${pick.name}` : pick.kind;
      this.onDoubleClick(pick);
    }
  }

  private wheelAt = 0;
  private onWheel(e: WheelEvent) {
    this.finishAnim();
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
  previousView() { const s = this.history.pop(); if (s) this.smooth(() => this.restore(s)); }

  setPivot(p: THREE.Vector3 | null) {
    this.pivot = p ? p.clone() : null;
    this.pivotMarker.visible = !!p;
    if (p) { this.pivotMarker.position.copy(p); this.pivotMarker.scale.setScalar(this.worldPerPx() * 4); }
  }

  /** Rodar (graus) em torno dos eixos do ecrã, centrado num ponto. */
  rotateBy(degX: number, degY: number, aboutPoint: THREE.Vector3 = this.pivot ?? this.target) {
    this.finishAnim();
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
    this.finishAnim();
    this.camera.up.applyAxisAngle(this.viewDir(), (deg * Math.PI) / 180);
    this.camera.lookAt(this.target);
    this.publish();
  }

  /** Deslocar a vista em pixels. */
  panBy(dx: number, dy: number) {
    this.finishAnim();
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
    this.finishAnim();
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
    this.smooth(() => this.fitNow(result, false));
  }

  private fitNow(result: RebuildResponse | null, record: boolean) {
    if (record) this.pushHistory();
    const m = result?.mass;
    const c = m ? new THREE.Vector3((m.bbox.min[0] + m.bbox.max[0]) / 2, (m.bbox.min[1] + m.bbox.max[1]) / 2, (m.bbox.min[2] + m.bbox.max[2]) / 2) : new THREE.Vector3();
    this.size = modelSize(result) * 0.6;
    const dir = this.viewDir();
    this.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, this.size * 20);
    this.camera.zoom = 1;
    this.camera.lookAt(this.target);
    this.setPivot(null);
    this.resize();
  }

  /** `instant`: sem transição (primeiro enquadramento ao abrir). */
  view(name: ViewName, result: RebuildResponse | null = this.lastResult, instant = false) {
    this.pushHistory();
    const was = this.animate;
    if (instant) this.animate = false;
    this.smooth(() => {
      const v = VIEWS[name];
      this.camera.up.set(...v.up);
      this.camera.position.copy(this.target).add(new THREE.Vector3(...v.dir).normalize().multiplyScalar(1000));
      this.camera.lookAt(this.target);
      this.fitNow(result, false);
    });
    this.animate = was;
  }

  /** Olhar perpendicularmente a um plano (Ctrl+8, "Normal a"). */
  normalTo(o: Vec3, n: Vec3, up?: Vec3) {
    this.pushHistory();
    this.smooth(() => {
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
    });
  }

  // --- esboço sobre o modelo -------------------------------------------------------------

  private sketchBase: CamState | null = null;

  /**
   * Alinha a câmara com o editor do esboço: normal ao plano (x para a direita, y para cima, z para
   * o observador) e com a escala e a posição do editor (px = tx + u·k, py = ty − v·k, em píxeis do
   * canvas do esboço), para o modelo se ver por trás do esboço transparente. A primeira chamada
   * guarda a vista anterior (para `leaveSketchView`) e, se `animated`, desliza até lá.
   */
  setSketchCamera(frame: { o: Vec3; x: Vec3; y: Vec3; z: Vec3 }, k: number, tx: number, ty: number, canvas: HTMLElement, animated: boolean) {
    const base = !this.sketchBase;
    if (base) this.sketchBase = this.save();
    const apply = () => {
      const r = canvas.getBoundingClientRect(), vr = this.el.getBoundingClientRect();
      const W = this.el.clientWidth || 1, H = this.el.clientHeight || 1;
      const uc = (W / 2 - (r.left - vr.left) - tx) / k, vc = (ty - (H / 2 - (r.top - vr.top))) / k;
      const target = new THREE.Vector3(...frame.o).addScaledVector(new THREE.Vector3(...frame.x), uc).addScaledVector(new THREE.Vector3(...frame.y), vc);
      this.target.copy(target);
      this.camera.up.set(...frame.y);
      this.camera.position.copy(target).addScaledVector(new THREE.Vector3(...frame.z).normalize(), this.size * 20);
      this.camera.zoom = Math.min(1e4, Math.max(1e-3, (2 * k * this.size) / H));
      this.camera.lookAt(target);
      this.updateProj();
      this.publish();
    };
    if (base && animated) this.smooth(apply, 420);
    else { this.finishAnim(); apply(); this.camera.updateMatrixWorld(true); }
  }

  /** Sai do esboço: a vista volta (com transição) à que havia antes de o abrir. */
  leaveSketchView() {
    const b = this.sketchBase;
    this.sketchBase = null;
    if (b) this.smooth(() => this.restore(b));
  }

  // --- transições da câmara (como o SolidWorks: as mudanças de vista deslizam) ---------

  /** Transições animadas das vistas; desligadas com prefers-reduced-motion. */
  animate = typeof matchMedia === "function" ? !matchMedia("(prefers-reduced-motion: reduce)").matches : true;
  private smoothing = false;
  private anim: { t0: number; ms: number; a: CamState; b: CamState; qa: THREE.Quaternion; qb: THREE.Quaternion } | null = null;

  /**
   * Aplica uma mudança de câmara e anima do estado atual para o final (rotação por slerp, centro,
   * distância e zoom interpolados). Os atributos de teste ficam já no estado final.
   */
  private smooth(change: () => void, ms = 380) {
    if (this.smoothing) { change(); return; }
    const a = this.save(); // a transição seguinte parte de onde a câmara está agora…
    this.finishAnim(); // …mas a mudança calcula-se a partir do estado final da anterior (ex.: Ctrl+5 e logo F)
    this.el.dataset.animating = "";
    this.smoothing = true;
    try { change(); } finally { this.smoothing = false; }
    const b = this.save();
    const moved = a.pos.distanceTo(b.pos) + a.target.distanceTo(b.target) + a.up.distanceTo(b.up) + Math.abs(a.zoom - b.zoom) + Math.abs(a.size - b.size) > 1e-6;
    if (!this.animate || !moved) return;
    const qb = this.camera.quaternion.clone();
    this.camera.position.copy(a.pos); this.camera.up.copy(a.up); this.camera.lookAt(a.target);
    const qa = this.camera.quaternion.clone();
    this.anim = { t0: performance.now(), ms, a, b, qa, qb };
    this.el.dataset.animating = "1";
    this.stepAnim();
  }

  private flashK = 0;
  private flashColor = new THREE.Color();
  private stepFlash() {
    if (this.flashPending && this.mesh) {
      const prefix = `${this.flashPending}:`;
      this.flashPending = null;
      if (this.animate && this.mesh.faces.some((f) => f.name.startsWith(prefix))) this.flash = { prefix, t0: performance.now() };
    }
    if (!this.flash) return;
    const k = 1 - (performance.now() - this.flash.t0) / 900;
    if (k <= 0) { this.flash = null; this.flashK = 0; this.recolor(); return; }
    this.flashK = k * k;
    this.recolor();
  }

  private stepAnim() {
    const an = this.anim;
    if (!an) return;
    const t = Math.min(1, (performance.now() - an.t0) / an.ms);
    if (t >= 1) { this.finishAnim(); return; }
    const u = 1 - Math.pow(1 - t, 3); // desaceleração suave no fim
    const q = an.qa.clone().slerp(an.qb, u);
    const target = an.a.target.clone().lerp(an.b.target, u);
    const dist = THREE.MathUtils.lerp(an.a.pos.distanceTo(an.a.target), an.b.pos.distanceTo(an.b.target), u);
    this.target.copy(target);
    this.camera.quaternion.copy(q);
    this.camera.position.copy(target).add(new THREE.Vector3(0, 0, 1).applyQuaternion(q).multiplyScalar(dist));
    this.camera.up.set(0, 1, 0).applyQuaternion(q);
    this.camera.zoom = Math.exp(THREE.MathUtils.lerp(Math.log(an.a.zoom), Math.log(an.b.zoom), u));
    this.size = THREE.MathUtils.lerp(an.a.size, an.b.size, u);
    this.updateProj();
  }

  /** Salta para o fim da transição em curso (qualquer gesto do utilizador). */
  finishAnim() {
    const an = this.anim;
    if (!an) return;
    this.anim = null;
    this.el.dataset.animating = "";
    const s = an.b;
    this.camera.position.copy(s.pos); this.target.copy(s.target); this.camera.up.copy(s.up); this.camera.zoom = s.zoom; this.size = s.size;
    this.camera.lookAt(this.target);
    this.updateProj();
    this.camera.updateMatrixWorld(true); // a seleção por raio usa já a câmara final
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

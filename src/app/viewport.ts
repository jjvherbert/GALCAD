// Visualizador 3D (Three.js): corpo, arestas, esboços, geometria de referência, seleção e
// navegação ao estilo do SolidWorks.
//
// Rato:   meio = rodar · Ctrl+meio = deslocar · Shift+meio = zoom · Alt+meio = rolar
//         roda = zoom no cursor · duplo clique no meio = ajustar · clique no meio sobre a peça = centro de rotação
//         esquerdo = selecionar (Ctrl/Shift soma) · arrastar no vazio = caixa (→ janela, ← cruzamento)
//         direito = menu de contexto · arrastar com o direito = gestos
import * as THREE from "three";
import type { ResultView } from "../sim/result.ts";
import type { MeshData } from "../kernel/mesh.ts";
import type { RebuildResponse } from "../kernel/protocol.ts";
import type { CadDocument, Vec3 } from "../doc/types.ts";
import type { Analysis, Pick, PickKind } from "./store.ts";
import type { GestureDir, Settings } from "./settings.ts";
import { onThemeChange, resolvedTheme } from "./theme.ts";
import type { ViewName } from "./viewport-views.ts";
import { type Theme, themes } from "./viewport-style.ts";
import type { SimView } from "./viewport-sim.ts";
import type { PlaneMesh } from "./viewport-scene.ts";
import type { PoleNet } from "./viewport-poles.ts";
import type { PmiItem, PmiLabel } from "./viewport-pmi.ts";
import * as select from "./viewport-select.ts";
import type { Hit, RegionMesh } from "./viewport-select.ts";
import type { CamAnim, CamState } from "./viewport-camera.ts";
import * as colors from "./viewport-colors.ts";
import * as content from "./viewport-content.ts";
import * as mouse from "./viewport-mouse.ts";
import * as nav from "./viewport-nav.ts";
import * as layers from "./viewport-layers.ts";
import * as hover from "./viewport-hover.ts";
import { type SeedLabel, buildSeedMarks, placeSeedLabels } from "./viewport-seeds.ts";
import type { SeedPreview } from "../kernel/sim-fem.ts";
import { mouseHostOf } from "./viewport-host.ts";

export type { PoleNet } from "./viewport-poles.ts";


export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  /** Ponto para onde a câmara olha (e, por defeito, centro de rotação). */
  readonly target = new THREE.Vector3();
  pivot: THREE.Vector3 | null = null;
  pivotMarker: THREE.Mesh;
  private bodyGroup = new THREE.Group();
  refGroup = new THREE.Group();
  sketchGroup = new THREE.Group();
  mesh: MeshData | null = null;
  faceMesh: THREE.Mesh | null = null;
  edgeLines: THREE.LineSegments | null = null;
  private faceOfTri: Int32Array = new Int32Array(0);
  faceVerts: [number, number][] = [];
  planeMeshes: PlaneMesh[] = [];
  private regionGroup = new THREE.Group();
  regionMeshes: RegionMesh[] = [];
  hover: Hit | null = null;
  selected = new Set<string>();
  featureHighlight: string | null = null;
  conditionFaces: Map<string, number> | null = null;
  theme: Theme = themes.light;
  ray = new THREE.Raycaster();
  private accept: PickKind[] | null = null;
  private mouse = mouse.newMouseState();
  private mouseHost = mouseHostOf(this);
  history: CamState[] = [];
  boxEl: HTMLDivElement;
  gestureEl: HTMLDivElement;
  size = 200;
  el: HTMLElement;
  lastResult: RebuildResponse | null = null;
  analysis: Analysis | null = null;
  private overlayGroup = new THREE.Group();
  private analysisGroup = new THREE.Group();
  poleGroup = new THREE.Group();
  poleNet: PoleNet | null = null;
  poleSel: number = -1;
  /** Restrição do arrasto de polos: livre (no plano do ecrã) ou ao longo de um eixo. */
  poleAxis: "free" | "X" | "Y" | "Z" = "free";
  onPoleSelect: (i: number, j: number) => void = () => {};
  onPoleMoved: (i: number, j: number, d: Vec3) => void = () => {};
  mats: content.FaceMats = { shaded: null, zebra: null, highlight: null };
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
    cv.addEventListener("pointerleave", () => { if (!this.mouse.drag) this.setHover(null); });
    cv.addEventListener("wheel", (e) => { if (e.shiftKey && this.onSeedWheel?.(e.deltaY < 0 ? 1 : -1)) e.preventDefault(); else this.onWheel(e); }, { passive: false });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("dblclick", (e) => this.onDblClick(e));
    cv.addEventListener("auxclick", (e) => e.preventDefault());
    this.pmiSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.pmiSvg.setAttribute("class", "pmi-leaders");
    this.pmiEl = Object.assign(document.createElement("div"), { className: "pmi-layer" });
    this.seedEl = Object.assign(document.createElement("div"), { className: "pmi-layer seed-layer" });
    el.append(this.pmiSvg, this.pmiEl, this.seedEl);
    this.renderer.setAnimationLoop(() => {
      this.stepAnim(); this.stepFlash(); this.renderer.render(this.scene, this.camera); this.placePmi();
      placeSeedLabels(this.seedLabels, this.camera, this.renderer.domElement);
    });
  }

  // --- seeds da malha ----------------------------------------------------------------

  private seedGroup = new THREE.Group();
  private seedEl: HTMLDivElement;
  private seedLabels: SeedLabel[] = [];
  /** Shift+roda no 3D: devolve true se consumiu o evento (há uma seed ativa a editar). */
  onSeedWheel: ((step: 1 | -1) => boolean) | null = null;

  /** Nós de cada aresta (pré-visualização sem Gmsh); null apaga. */
  setSeedMarks(p: SeedPreview | null) {
    this.disposeGroup(this.seedGroup);
    if (!this.seedGroup.parent) this.scene.add(this.seedGroup);
    const r = buildSeedMarks(this.seedGroup, this.seedEl, p);
    this.seedLabels = r.labels;
    this.el.dataset.seeds = p ? String(r.nodes) : "";
  }

  // --- PMI 3D ------------------------------------------------------------------------

  pmiEl: HTMLDivElement;
  pmiSvg: SVGSVGElement;
  pmiLabels: PmiLabel[] = [];
  /** Chamado ao clicar num rótulo PMI (id do item). */
  onPmiClick: ((id: string) => void) | null = null;

  /**
   * Rótulos PMI no 3D: o texto do item (quadro de tolerância, cota, referência) afastado da face pela
   * normal, com linha de chamada até ao ponto de ancoragem. Acompanham a câmara a cada imagem.
   */
  setPmi(items: PmiItem[] | null) { layers.setPmi(this, items); }
  private placePmi() { layers.placePmi(this); }

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

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.updateProj();
    // a meio de uma transição a câmara está num estado intermédio; os atributos já têm o final
    if (!this.anim) this.publish();
  }

  updateProj() {
    const a = (this.el.clientWidth || 1) / (this.el.clientHeight || 1);
    this.camera.left = -this.size * a; this.camera.right = this.size * a;
    this.camera.top = this.size; this.camera.bottom = -this.size;
    this.camera.updateProjectionMatrix();
  }

  /** Estado da vista em atributos do elemento (útil para testes e depuração). */
  publish() {
    const d = this.viewDir();
    this.el.dataset.viewDir = d.toArray().map((v) => v.toFixed(3)).join(",");
    this.el.dataset.zoom = this.camera.zoom.toFixed(4);
  }

  /** Tipos de entidade selecionáveis (null = todos). */
  setAccept(kinds: PickKind[] | null) { this.accept = kinds; }

  setSelected(keys: string[]) { this.selected = new Set(keys); this.recolor(); }

  flash: colors.Flash = { pending: null, on: null, k: 0 };
  /** Realce que se desvanece nas faces de uma feature acabada de confirmar. */
  flashFeature(fid: string) { this.flash.pending = fid; }
  previewFeature: string | null = null;
  /** Feature em edição: as faces que ela cria ficam amarelas (pré-visualização, como no SolidWorks). */
  setPreviewFeature(fid: string | null) { if (fid !== this.previewFeature) { this.previewFeature = fid; this.recolor(); } }
  extHover = "";
  /** Realce vindo de fora do 3D (ex.: botão de um plano no painel); chave como `plane:{...}`. */
  setHoverKey(k: string | null) { if ((k ?? "") !== this.extHover) { this.extHover = k ?? ""; this.recolor(); } }
  /** Realça as faces criadas por uma feature (ao passar o rato na árvore). */
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

  disposeGroup(g: THREE.Group) {
    content.disposeGroup(g);
  }

  private setMesh(mesh: MeshData | null) {
    this.disposeGroup(this.bodyGroup);
    this.mesh = mesh;
    this.faceMesh = null;
    this.edgeLines = null;
    if (!mesh) return;
    ({ faceMesh: this.faceMesh, edgeLines: this.edgeLines, faceOfTri: this.faceOfTri, faceVerts: this.faceVerts } = content.buildBody(this.bodyGroup, mesh, this.mats, this.analysis, this.size));
    this.recolor();
  }

  /** Malhas sobrepostas a vermelho (ex.: volumes de interferência), por cima do modelo. */
  setOverlay(meshes: MeshData[]) {
    this.disposeGroup(this.overlayGroup);
    if (!this.overlayGroup.parent) this.scene.add(this.overlayGroup);
    content.buildOverlay(this.overlayGroup, meshes);
    this.el.dataset.overlay = String(meshes.length);
  }

  /** Mostra as regiões escolhíveis de um esboço (contornos selecionados), por cima do modelo. */
  setRegions(sketch: string | null, view: RebuildResponse["sketches"][string] | null) {
    this.disposeGroup(this.regionGroup);
    this.regionMeshes = [];
    if (!sketch || !view) return;
    this.regionMeshes = content.buildRegions(this.regionGroup, sketch, view);
    this.recolor();
  }

  simGroup = new THREE.Group();

  /**
   * Resultados de simulação em camadas (superfície da malha FEM; patches e cortes CFD): cores do campo
   * escolhido na paleta sequencial, com a mesma escala em todas as camadas visíveis, e deformada
   * ampliada. O corpo fica escondido enquanto se mostram resultados FEM; nos CFD fica em arame.
   */
  setSimResult(r: ResultView | null, view: SimView) { layers.setSimResult(this, r, view); }

  /** Mostra (ou esconde) a rede de controlo da forma livre em edição e o polo selecionado. */
  setPoleNet(net: PoleNet | null, sel: [number, number] | null) {
    this.poleNet = net;
    this.poleSel = net && sel ? sel[0] * net.nv + sel[1] : -1;
    this.drawPoles();
  }

  drawPoles(preview?: { k: number; p: THREE.Vector3 }) { layers.drawPoles(this, preview); }

  /** Análise de superfície: zebra/realce (materiais), inclinação e curvatura (cores), pentes (linhas). */
  setAnalysis(a: Analysis | null) {
    this.analysis = a;
    content.applyAnalysis({ mesh: this.mesh, faceMesh: this.faceMesh, mats: this.mats, size: this.size, scene: this.scene, analysisGroup: this.analysisGroup }, a, this.el.dataset);
    this.recolor();
  }

  /** Definições novas (o store substitui o objeto a cada alteração; nunca o mutar aqui). Os planos aplicam-se no próximo `update`. */
  setSettings(settings: Settings) {
    const restyle = settings.displayStyle !== this.settings.displayStyle;
    this.settings = settings;
    if (restyle) this.applyDisplayStyle();
  }

  private applyDisplayStyle() { layers.applyDisplayStyle(this); }
  private setReferences(result: RebuildResponse | null, doc: CadDocument, showStd: boolean) { layers.setReferences(this, result, doc, showStd); }
  private setSketches(result: RebuildResponse | null, doc: CadDocument, hide?: string) { layers.setSketches(this, result, doc, hide); }

  // --- cores e seleção ---------------------------------------------------------------

  keyOf(h: Hit): string { return select.keyOf(h, this.mesh, this.regionMeshes); }
  recolor() { hover.recolor(this); }
  setHover(h: Hit | null) { hover.setHover(this, h); }

  local(ev: { clientX: number; clientY: number }): [number, number] {
    const r = this.renderer.domElement.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  worldPerPx() {
    return (this.camera.top - this.camera.bottom) / this.camera.zoom / (this.el.clientHeight || 1);
  }

  hitTest(ev: { clientX: number; clientY: number }, accept = this.accept): Hit | null {
    return select.hitTest(this.ray, this.camera, this.renderer.domElement, ev, accept, { mesh: this.mesh, faceMesh: this.faceMesh, edgeLines: this.edgeLines, faceOfTri: this.faceOfTri, regionMeshes: this.regionMeshes, planeMeshes: this.planeMeshes }, this.worldPerPx(), this.settings.displayStyle === "wireframe");
  }

  toPick(h: Hit): Pick {
    return select.toPick(h, this.mesh, this.regionMeshes);
  }

  /** Elemento (face/aresta/plano) sob um ponto do ecrã, sem filtro. */
  pickAt(clientX: number, clientY: number): Pick | null {
    const h = this.hitTest({ clientX, clientY }, null);
    return h ? this.toPick(h) : null;
  }

  // --- rato ------------------------------------------------------------------------

  private onDown(e: PointerEvent) { mouse.onDown(this.mouseHost, this.mouse, e); }
  private onMove(e: PointerEvent) { mouse.onMove(this.mouseHost, this.mouse, e); }
  private onUp(e: PointerEvent) { mouse.onUp(this.mouseHost, this.mouse, e); }
  private onDblClick(e: MouseEvent) { mouse.onDblClick(this.mouseHost, e); }
  private onWheel(e: WheelEvent) { mouse.onWheel(this.mouseHost, this.mouse, e); }

  /** Seleção por caixa: arestas (e faces, se o filtro as aceitar) dentro da caixa ou que a cruzam. */
  boxSelect(a: [number, number], b: [number, number]): Pick[] {
    return select.boxSelect(a, b, this.mesh, this.faceVerts, this.camera, this.el.clientWidth, this.el.clientHeight, this.accept, (h) => this.toPick(h));
  }

  // --- câmara (lógica em viewport-nav.ts) -----------------------------------------------

  private viewDir(): THREE.Vector3 { return nav.viewDir(this); }
  pushHistory() { nav.pushHistory(this); }

  /** Vista anterior (como Ctrl+Shift+Z no SolidWorks). */
  previousView() { nav.previousView(this); }
  setPivot(p: THREE.Vector3 | null) { nav.setPivot(this, p); }
  /** Rodar (graus) em torno dos eixos do ecrã, centrado num ponto. */
  rotateBy(degX: number, degY: number, aboutPoint: THREE.Vector3 = this.pivot ?? this.target) { nav.rotateBy(this, degX, degY, aboutPoint); }
  /** Rolar a vista (graus) em torno da direção de visão. */
  roll(deg: number) { nav.roll(this, deg); }
  /** Deslocar a vista em pixels. */
  panBy(dx: number, dy: number) { nav.panBy(this, dx, dy); }
  /** Zoom por um fator (> 1 afasta, < 1 aproxima), mantendo fixo o ponto sob o cursor. */
  zoomAt(factor: number, at?: [number, number]) { nav.zoomAt(this, factor, at); }
  fit(result: RebuildResponse | null = this.lastResult, record = true) { nav.fit(this, result, record); }
  private fitNow(result: RebuildResponse | null, record: boolean) { nav.fitNow(this, result, record); }
  /** `instant`: sem transição (primeiro enquadramento ao abrir). */
  view(name: ViewName, result: RebuildResponse | null = this.lastResult, instant = false) { nav.view(this, name, result, instant); }
  /** Olhar perpendicularmente a um plano (Ctrl+8, "Normal a"). */
  normalTo(o: Vec3, n: Vec3, up?: Vec3) { nav.normalTo(this, o, n, up); }

  // --- esboço sobre o modelo -------------------------------------------------------------

  sketchBase: CamState | null = null;

  /**
   * Alinha a câmara com o editor do esboço: normal ao plano (x para a direita, y para cima, z para
   * o observador) e com a escala e a posição do editor (px = tx + u·k, py = ty − v·k, em píxeis do
   * canvas do esboço), para o modelo se ver por trás do esboço transparente. A primeira chamada
   * guarda a vista anterior (para `leaveSketchView`) e, se `animated`, desliza até lá.
   */
  setSketchCamera(frame: { o: Vec3; x: Vec3; y: Vec3; z: Vec3 }, k: number, tx: number, ty: number, canvas: HTMLElement, animated: boolean) { nav.setSketchCamera(this, frame, k, tx, ty, canvas, animated); }
  /** Sai do esboço: a vista volta (com transição) à que havia antes de o abrir. */
  leaveSketchView() { nav.leaveSketchView(this); }

  // --- transições da câmara (como o SolidWorks: as mudanças de vista deslizam) ---------

  /** Transições animadas das vistas; desligadas com prefers-reduced-motion. */
  animate = typeof matchMedia === "function" ? !matchMedia("(prefers-reduced-motion: reduce)").matches : true;
  smoothing = false;
  anim: CamAnim | null = null;

  /** Aplica uma mudança de câmara e anima do estado atual para o final. */
  private smooth(change: () => void, ms = 380) { nav.smooth(this, change, ms); }
  private stepFlash() { if (colors.stepFlash(this.flash, this.mesh, this.animate)) this.recolor(); }
  private stepAnim() { nav.stepAnim(this); }
  /** Salta para o fim da transição em curso (qualquer gesto do utilizador). */
  finishAnim() { nav.finishAnim(this); }

  /** Converte um ponto 3D em pixels do canvas (para sobreposições). */
  project(p: Vec3): [number, number] {
    const v = new THREE.Vector3(...p).project(this.camera);
    const r = this.renderer.domElement;
    return [((v.x + 1) / 2) * r.clientWidth, ((1 - v.y) / 2) * r.clientHeight];
  }

  screenshot(): string { return this.renderer.domElement.toDataURL("image/png"); }
}

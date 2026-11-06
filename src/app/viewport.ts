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
import type { CadDocument, Vec3 } from "../doc/types.ts";
import type { Analysis, Pick, PickKind } from "./store.ts";
import type { GestureDir, Settings } from "./settings.ts";
import { onThemeChange, resolvedTheme } from "./theme.ts";
import { VIEWS, type ViewName } from "./viewport-views.ts";
import { type Theme, themes } from "./viewport-style.ts";
import { type SimView, buildSimLayers } from "./viewport-sim.ts";
import { type PlaneMesh, buildReferences, buildSketches, modelSize } from "./viewport-scene.ts";
import { type PoleNet, drawPoleNet, poleAt } from "./viewport-poles.ts";
import { type PmiItem, type PmiLabel, buildPmiLabels, placePmiLabels } from "./viewport-pmi.ts";
import * as select from "./viewport-select.ts";
import type { Hit, RegionMesh } from "./viewport-select.ts";
import * as cam from "./viewport-camera.ts";
import type { CamAnim, CamState } from "./viewport-camera.ts";
import * as colors from "./viewport-colors.ts";
import * as content from "./viewport-content.ts";

export type { PoleNet } from "./viewport-poles.ts";


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
  private regionMeshes: RegionMesh[] = [];
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
  private analysisGroup = new THREE.Group();
  private poleGroup = new THREE.Group();
  private poleNet: PoleNet | null = null;
  private poleSel: number = -1;
  /** Restrição do arrasto de polos: livre (no plano do ecrã) ou ao longo de um eixo. */
  poleAxis: "free" | "X" | "Y" | "Z" = "free";
  onPoleSelect: (i: number, j: number) => void = () => {};
  onPoleMoved: (i: number, j: number, d: Vec3) => void = () => {};
  private mats: content.FaceMats = { shaded: null, zebra: null, highlight: null };
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

  private flash: colors.Flash = { pending: null, on: null, k: 0 };
  /** Realce que se desvanece nas faces de uma feature acabada de confirmar. */
  flashFeature(fid: string) { this.flash.pending = fid; }
  private previewFeature: string | null = null;
  /** Feature em edição: as faces que ela cria ficam amarelas (pré-visualização, como no SolidWorks). */
  setPreviewFeature(fid: string | null) { if (fid !== this.previewFeature) { this.previewFeature = fid; this.recolor(); } }
  private extHover = "";
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

  private disposeGroup(g: THREE.Group) {
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
    return select.keyOf(h, this.mesh, this.regionMeshes);
  }

  private recolor() {
    colors.recolor({
      mesh: this.mesh, faceMesh: this.faceMesh, edgeLines: this.edgeLines, faceVerts: this.faceVerts,
      planeMeshes: this.planeMeshes, regionMeshes: this.regionMeshes, theme: this.theme, selected: this.selected,
      hoverKey: this.hover ? this.keyOf(this.hover) : this.extHover, featureHighlight: this.featureHighlight,
      previewFeature: this.previewFeature, conditionFaces: this.conditionFaces, analysis: this.analysis, flash: this.flash,
    }, this.el.dataset);
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
    return select.hitTest(this.ray, this.camera, this.renderer.domElement, ev, accept, { mesh: this.mesh, faceMesh: this.faceMesh, edgeLines: this.edgeLines, faceOfTri: this.faceOfTri, regionMeshes: this.regionMeshes, planeMeshes: this.planeMeshes }, this.worldPerPx(), this.settings.displayStyle === "wireframe");
  }

  private toPick(h: Hit): Pick {
    return select.toPick(h, this.mesh, this.regionMeshes);
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
      case "box": cam.drawBox(this.boxEl, d.start, p); break;
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
        cam.drawGesture(this.gestureEl, d.path);
        this.onGestureTrack(cam.gestureDir(d.start, p), [e.clientX, e.clientY]);
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
      const dir = cam.gestureDir(d.start, p);
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

  /** Seleção por caixa: arestas (e faces, se o filtro as aceitar) dentro da caixa ou que a cruzam. */
  boxSelect(a: [number, number], b: [number, number]): Pick[] {
    return select.boxSelect(a, b, this.mesh, this.faceVerts, this.camera, this.el.clientWidth, this.el.clientHeight, this.accept, (h) => this.toPick(h));
  }

  // --- câmara ------------------------------------------------------------------------

  private viewDir(): THREE.Vector3 { return cam.viewDirOf(this.camera, this.target); }

  private save(): CamState { return cam.saveCam(this.camera, this.target, this.size); }
  private restore(s: CamState) { this.size = cam.applyCam(this.camera, this.target, s); this.resize(); }
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
    cam.rotateCam(this.camera, this.target, aboutPoint, degX, degY);
    if (this.pivotMarker.visible) this.pivotMarker.scale.setScalar(this.worldPerPx() * 4);
    this.publish();
  }

  /** Rolar a vista (graus) em torno da direção de visão. */
  roll(deg: number) {
    this.finishAnim();
    cam.rollCam(this.camera, this.target, deg);
    this.publish();
  }

  /** Deslocar a vista em pixels. */
  panBy(dx: number, dy: number) {
    this.finishAnim();
    cam.panCam(this.camera, this.target, dx, dy, this.worldPerPx());
    this.publish();
  }

  /** Zoom por um fator (> 1 afasta, < 1 aproxima), mantendo fixo o ponto sob o cursor. */
  zoomAt(factor: number, at?: [number, number]) {
    this.finishAnim();
    const w = this.el.clientWidth, h = this.el.clientHeight;
    cam.zoomCam(this.camera, this.target, factor, at ?? [w / 2, h / 2], w, h);
    this.publish();
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
  private anim: CamAnim | null = null;

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

  private stepFlash() { if (colors.stepFlash(this.flash, this.mesh, this.animate)) this.recolor(); }

  private stepAnim() {
    const an = this.anim;
    if (!an) return;
    const size = cam.stepCam(an, this.camera, this.target);
    if (size === null) { this.finishAnim(); return; }
    this.size = size;
    this.updateProj();
  }

  /** Salta para o fim da transição em curso (qualquer gesto do utilizador). */
  finishAnim() {
    const an = this.anim;
    if (!an) return;
    this.anim = null;
    this.el.dataset.animating = "";
    this.size = cam.applyCam(this.camera, this.target, an.b);
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

// Visualizador 3D (Three.js): corpo, arestas, esboços, geometria de referência e seleção.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MeshData } from "../kernel/mesh.ts";
import type { RebuildResponse } from "../kernel/protocol.ts";
import type { Frame } from "../kernel/frame.ts";
import type { CadDocument, PlaneRef, StdPlane, Vec3 } from "../doc/types.ts";
import { sampleEntity, allEntities } from "../sketch/geometry.ts";
import type { Pick, PickKind } from "./store.ts";

const STD: Record<StdPlane, Frame> = {
  XY: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
  XZ: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] },
  YZ: { o: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
};

interface Theme { bg: number; body: number; edge: number; hover: number; sel: number; plane: number; sketch: number; axis: number }
const themes: Record<"light" | "dark", Theme> = {
  light: { bg: 0xf3f4f6, body: 0xb9c7d6, edge: 0x1f2937, hover: 0xf59e0b, sel: 0x2563eb, plane: 0x5b8def, sketch: 0x1d4ed8, axis: 0x9ca3af },
  dark: { bg: 0x14181f, body: 0x7f93a8, edge: 0x0b0e13, hover: 0xf59e0b, sel: 0x60a5fa, plane: 0x5b8def, sketch: 0x93c5fd, axis: 0x6b7280 },
};

type Hit =
  | { kind: "face"; index: number }
  | { kind: "edge"; index: number }
  | { kind: "plane"; ref: PlaneRef; label: string };

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  private bodyGroup = new THREE.Group();
  private refGroup = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private mesh: MeshData | null = null;
  private faceMesh: THREE.Mesh | null = null;
  private edgeLines: THREE.LineSegments | null = null;
  private faceOfTri: Int32Array = new Int32Array(0);
  private faceVerts: [number, number][] = [];
  private planeMeshes: { mesh: THREE.Mesh; ref: PlaneRef; label: string }[] = [];
  private hover: Hit | null = null;
  private selected = new Set<string>();
  private theme: Theme = themes.light;
  private ray = new THREE.Raycaster();
  private accept: PickKind[] | null = null;
  private downAt: [number, number] | null = null;
  onPick: (p: Pick, additive: boolean) => void = () => {};
  onEmptyClick: () => void = () => {};
  /** Passagem do rato: tipo de elemento, tipo geométrico e nome topológico (ou rótulo, para planos). */
  onHover: (h: { kind: "face" | "edge" | "plane"; type: string; name: string } | null) => void = () => {};
  private size = 200;
  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    el.appendChild(this.renderer.domElement);
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(1, -1.2, 0.9).multiplyScalar(300);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 1.8));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    this.camera.add(key);
    key.position.set(0.5, 1, 1);
    this.scene.add(this.camera, this.bodyGroup, this.refGroup, this.sketchGroup);
    new ResizeObserver(() => this.resize()).observe(el);
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const setTheme = () => { this.theme = themes[dark.matches ? "dark" : "light"]; this.scene.background = new THREE.Color(this.theme.bg); this.recolor(); };
    dark.addEventListener("change", setTheme);
    setTheme();
    this.resize();
    const cv = this.renderer.domElement;
    cv.addEventListener("pointermove", (e) => this.onMove(e));
    cv.addEventListener("pointerdown", (e) => { this.downAt = [e.clientX, e.clientY]; });
    cv.addEventListener("pointerup", (e) => this.onUp(e));
    cv.addEventListener("pointerleave", () => this.setHover(null));
    this.renderer.setAnimationLoop(() => this.renderer.render(this.scene, this.camera));
  }

  private resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h);
    const a = w / h;
    this.camera.left = -this.size * a; this.camera.right = this.size * a;
    this.camera.top = this.size; this.camera.bottom = -this.size;
    this.camera.updateProjectionMatrix();
  }

  /** Tipos de entidade selecionáveis (null = todos). */
  setAccept(kinds: PickKind[] | null) { this.accept = kinds; }

  setSelected(keys: string[]) { this.selected = new Set(keys); this.recolor(); }

  // --- conteúdo ----------------------------------------------------------------

  update(result: RebuildResponse | null, doc: CadDocument, opts: { hideSketch?: string; showPlanes: boolean }) {
    this.setMesh(result?.mesh ?? null);
    this.setReferences(result, doc, opts.showPlanes);
    this.setSketches(result, doc, opts.hideSketch);
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
    this.faceMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    const eg = new THREE.BufferGeometry();
    eg.setAttribute("position", new THREE.BufferAttribute(mesh.lines, 3));
    eg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.lines.length), 3));
    this.edgeLines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.bodyGroup.add(this.faceMesh, this.edgeLines);
    this.recolor();
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
    // origem
    this.refGroup.add(new THREE.AxesHelper(s / 6));
  }

  private setSketches(result: RebuildResponse | null, doc: CadDocument, hide?: string) {
    this.disposeGroup(this.sketchGroup);
    if (!result) return;
    for (const [id, sv] of Object.entries(result.sketches)) {
      if (id === hide) continue;
      const f = doc.features.find((x) => x.id === id);
      if (!f || f.suppressed) continue;
      // esconder esboços já consumidos por features (como no SolidWorks), exceto o selecionado
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
    return `plane:${JSON.stringify(h.ref)}`;
  }

  private recolor() {
    if (!this.mesh || !this.faceMesh || !this.edgeLines) {
      for (const p of this.planeMeshes) (p.mesh.material as THREE.MeshBasicMaterial).color.set(this.selected.has(`plane:${JSON.stringify(p.ref)}`) ? this.theme.sel : p.ref.kind === "std" ? this.theme.plane : 0x22a06b);
      return;
    }
    const col = this.faceMesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const c = new THREE.Color();
    const hoverKey = this.hover ? this.keyOf(this.hover) : "";
    this.mesh.faces.forEach((f, i) => {
      const k = `face:${f.name}`;
      c.set(this.selected.has(k) ? this.theme.sel : k === hoverKey ? this.theme.hover : this.theme.body);
      const [lo, hi] = this.faceVerts[i];
      for (let v = lo; v <= hi; v++) col.setXYZ(v, c.r, c.g, c.b);
    });
    col.needsUpdate = true;
    const ecol = this.edgeLines.geometry.getAttribute("color") as THREE.BufferAttribute;
    this.mesh.edges.forEach((e) => {
      const k = `edge:${e.name}`;
      c.set(this.selected.has(k) ? this.theme.sel : k === hoverKey ? this.theme.hover : this.theme.edge);
      for (let v = e.start; v < e.start + e.count; v++) ecol.setXYZ(v, c.r, c.g, c.b);
    });
    ecol.needsUpdate = true;
    const mat = this.edgeLines.material as THREE.LineBasicMaterial;
    mat.needsUpdate = true;
    for (const p of this.planeMeshes) {
      const k = `plane:${JSON.stringify(p.ref)}`;
      (p.mesh.material as THREE.MeshBasicMaterial).color.set(this.selected.has(k) ? this.theme.sel : k === hoverKey ? this.theme.hover : p.ref.kind === "std" ? this.theme.plane : 0x22a06b);
    }
  }

  private setHover(h: Hit | null) {
    const same = (a: Hit | null, b: Hit | null) => (a && b ? this.keyOf(a) === this.keyOf(b) : a === b);
    if (same(h, this.hover)) return;
    this.hover = h;
    this.recolor();
    if (!h) this.onHover(null);
    else if (h.kind === "face") { const f = this.mesh!.faces[h.index]; this.onHover({ kind: "face", type: f.type, name: f.name }); }
    else if (h.kind === "edge") { const e = this.mesh!.edges[h.index]; this.onHover({ kind: "edge", type: e.type, name: e.name }); }
    else this.onHover({ kind: "plane", type: "plane", name: h.label });
  }

  private hitTest(ev: PointerEvent): Hit | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const ok = (k: PickKind) => !this.accept || this.accept.includes(k);
    // tolerância das arestas: ~6 px
    const worldPerPx = (this.camera.top - this.camera.bottom) / this.camera.zoom / r.height;
    this.ray.params.Line = { threshold: worldPerPx * 6 };
    let faceHit: THREE.Intersection | undefined;
    if (this.faceMesh) faceHit = this.ray.intersectObject(this.faceMesh)[0];
    if (this.edgeLines && ok("edge")) {
      const eh = this.ray.intersectObject(this.edgeLines)[0];
      if (eh && (!faceHit || eh.distance <= faceHit.distance + worldPerPx * 8) && eh.index !== undefined) {
        const vi = eh.index;
        const idx = this.mesh!.edges.findIndex((e) => vi >= e.start && vi < e.start + e.count);
        if (idx >= 0) return { kind: "edge", index: idx };
      }
    }
    if (faceHit && faceHit.faceIndex != null && ok("face")) return { kind: "face", index: this.faceOfTri[faceHit.faceIndex] };
    if (faceHit) return null;
    if (ok("plane")) {
      const ph = this.ray.intersectObjects(this.planeMeshes.map((p) => p.mesh), false)[0];
      if (ph) { const p = this.planeMeshes.find((x) => x.mesh === ph.object)!; return { kind: "plane", ref: p.ref, label: p.label }; }
    }
    return null;
  }

  private onMove(e: PointerEvent) {
    if (e.buttons) return;
    this.setHover(this.hitTest(e));
  }

  private onUp(e: PointerEvent) {
    if (!this.downAt || Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > 4 || e.button !== 0) return;
    const h = this.hitTest(e);
    if (!h) { this.onEmptyClick(); return; }
    const additive = e.ctrlKey || e.shiftKey || e.metaKey;
    if (h.kind === "face") {
      const f = this.mesh!.faces[h.index];
      this.onPick({ kind: "face", name: f.name, type: f.type, hint: { c: f.center, n: f.normal } }, additive);
    } else if (h.kind === "edge") {
      const ed = this.mesh!.edges[h.index];
      this.onPick({ kind: "edge", name: ed.name, type: ed.type, hint: { c: ed.mid, n: ed.dir } }, additive);
    } else {
      this.onPick({ kind: "plane", ref: h.ref, label: h.label }, additive);
    }
  }

  // --- câmara ----------------------------------------------------------------

  fit(result: RebuildResponse | null) {
    const m = result?.mass;
    const c = m ? new THREE.Vector3((m.bbox.min[0] + m.bbox.max[0]) / 2, (m.bbox.min[1] + m.bbox.max[1]) / 2, (m.bbox.min[2] + m.bbox.max[2]) / 2) : new THREE.Vector3();
    this.size = this.modelSize(result) * 0.6;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, this.size * 10);
    this.camera.zoom = 1;
    this.resize();
    this.controls.update();
  }

  view(name: "iso" | "front" | "top" | "right" | "back" | "bottom" | "left", result: RebuildResponse | null) {
    const d: Record<string, Vec3> = { iso: [1, -1.2, 0.9], front: [0, -1, 0], back: [0, 1, 0], top: [0, 0, 1], bottom: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0] };
    const v = d[name];
    this.camera.up.set(0, 0, 1);
    if (name === "top" || name === "bottom") this.camera.up.set(0, 1, 0);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(...v).normalize().multiplyScalar(1000));
    this.fit(result);
  }

  /** Olhar perpendicularmente a um plano (para esboçar). */
  normalTo(f: Frame) {
    this.camera.up.set(...f.y);
    this.camera.position.copy(new THREE.Vector3(...f.o)).add(new THREE.Vector3(...f.z).multiplyScalar(1000));
    this.controls.target.set(...f.o);
    this.controls.update();
  }

  /** Converte um ponto 3D em pixels do canvas (para sobreposições). */
  project(p: Vec3): [number, number] {
    const v = new THREE.Vector3(...p).project(this.camera);
    const r = this.renderer.domElement;
    return [((v.x + 1) / 2) * r.clientWidth, ((1 - v.y) / 2) * r.clientHeight];
  }

  screenshot(): string { return this.renderer.domElement.toDataURL("image/png"); }
}

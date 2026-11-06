// Geometria de referência do visualizador: planos (padrão e de referência), eixos, referenciais e
// esboços visíveis, construídos num grupo three.js.
import * as THREE from "three";
import type { RebuildResponse } from "../kernel/protocol.ts";
import type { Frame } from "../kernel/frame.ts";
import type { CadDocument, PlaneRef, StdPlane } from "../doc/types.ts";
import { sampleEntity, allEntities } from "../sketch/geometry.ts";
import { STD } from "./viewport-views.ts";

/** Plano escolhível no 3D (malha, referência e nome a mostrar). */
export interface PlaneMesh { mesh: THREE.Mesh; ref: PlaneRef; label: string }

export function planeQuad(f: Frame, size: number, color: number, opacity: number) {
  const geo = new THREE.PlaneGeometry(size, size);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
  const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.z));
  m.quaternion.setFromRotationMatrix(basis);
  m.position.set(...f.o);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity * 4) }));
  m.add(edges);
  return m;
}

/** Planos, eixos e referenciais no grupo (já vazio); devolve os planos escolhíveis. */
export function buildReferences(group: THREE.Group, result: RebuildResponse | null, doc: CadDocument, showStd: boolean, planeColor: number): PlaneMesh[] {
  const planeMeshes: PlaneMesh[] = [];
  const s = modelSize(result) * 0.6;
  if (showStd) {
    for (const n of ["XY", "XZ", "YZ"] as StdPlane[]) {
      const m = planeQuad(STD[n], s, planeColor, 0.05);
      group.add(m);
      planeMeshes.push({ mesh: m, ref: { kind: "std", name: n }, label: `Plano ${n}` });
    }
  }
  const visible = (id: string) => { const f = doc.features.find((x) => x.id === id); return f && !f.suppressed; };
  for (const [id, f] of Object.entries(result?.planes ?? {})) {
    if (!visible(id)) continue;
    const m = planeQuad(f, s * 0.8, 0x22a06b, 0.08);
    group.add(m);
    planeMeshes.push({ mesh: m, ref: { kind: "datum", feature: id }, label: doc.features.find((x) => x.id === id)?.name ?? id });
  }
  for (const [id, a] of Object.entries(result?.axes ?? {})) {
    if (!visible(id)) continue;
    const p0 = new THREE.Vector3(...a.o).addScaledVector(new THREE.Vector3(...a.d), -s / 2);
    const p1 = new THREE.Vector3(...a.o).addScaledVector(new THREE.Vector3(...a.d), s / 2);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p0, p1]), new THREE.LineDashedMaterial({ color: 0x22a06b, dashSize: s / 40, gapSize: s / 80 }));
    line.computeLineDistances();
    group.add(line);
  }
  for (const [, f] of Object.entries(result?.csys ?? {})) {
    const h = new THREE.AxesHelper(s / 4);
    const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.z));
    h.quaternion.setFromRotationMatrix(basis);
    h.position.set(...f.o);
    group.add(h);
  }
  group.add(new THREE.AxesHelper(s / 6));
  return planeMeshes;
}

/** Esboços visíveis (não suprimidos nem consumidos por features) como linhas no grupo (já vazio). */
export function buildSketches(group: THREE.Group, result: RebuildResponse | null, doc: CadDocument, color: number, hide?: string) {
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
    group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })));
  }
}

/** Dimensão característica do modelo (diagonal da caixa envolvente com folga; 200 sem modelo). */
export function modelSize(result: RebuildResponse | null) {
  const m = result?.mass;
  if (!m) return 200;
  const d = Math.hypot(m.bbox.max[0] - m.bbox.min[0], m.bbox.max[1] - m.bbox.min[1], m.bbox.max[2] - m.bbox.min[2]);
  return Math.max(50, d * 1.2);
}

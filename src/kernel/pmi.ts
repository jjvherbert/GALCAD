// PMI no núcleo: resolve as faces pelo nome topológico, mede o valor nominal das cotas no modelo
// (distância entre planos paralelos, diâmetro/raio de cilindros, ângulo entre planos), valida cada
// item contra a geometria real (ISO 1101/5459/286, ver doc/pmi.ts) e dá o ponto de ancoragem no 3D.
import type { Vec3 } from "../doc/types.ts";
import { type PmiItem, checkPmi, pmiText } from "../doc/pmi.ts";
import { type Ctx, type StepReport, faces as resolveFaces } from "./context.ts";
import { T, type TopoDS_Shape, explore, faceProps, normalOnFace, oc, sampleEdge, v3 } from "./occ.ts";

export interface PmiState {
  id: string;
  text: string;
  /** Valor medido (mm; graus nos ângulos), nas cotas. */
  nominal?: number;
  /** Ponto na peça a que o rótulo se liga e direção para o afastar (normal da face). */
  anchor: Vec3;
  normal: Vec3;
  /** Faces resolvidas (nomes) e erros de validação. */
  faces: string[];
  errors: string[];
  /**
   * Geometria das cotas para as projetar nos desenhos: distância entre planos (ponto da 1.ª face,
   * normal e distância com sinal até à 2.ª) ou eixo e raio de uma face de revolução.
   */
  geom?: { kind: "distance"; p: Vec3; n: Vec3; d: number } | { kind: "axis"; o: Vec3; d: Vec3; r: number; p: Vec3 };
}

interface Resolved { name: string; face: TopoDS_Shape; type: string; center: Vec3; normal: Vec3; axis?: { o: Vec3; d: Vec3 }; radius?: number; point: Vec3 }

function resolve(ctx: Ctx, ref: { kind: "face"; name: string }): Resolved | null {
  const report: StepReport = { warnings: [] };
  let nf;
  try { [nf] = resolveFaces(ctx, [ref], report); } catch { return null; }
  if (!nf) return null;
  const p = faceProps(nf.face);
  // ponto da superfície (nas faces de revolução o centroide cai no eixo): meio da primeira aresta
  const e = explore(nf.face, "edge")[0];
  let onSurf = p.type === "plane" || !e ? p.center : sampleEdge(e, 3)[1].p;
  let radius: number | undefined;
  if (p.axis) {
    try {
      const o = oc();
      const ad = T(new o.BRepAdaptor_Surface(T(o.TopoDS.Face(nf.face)), true));
      radius = (ad.Cylinder() as unknown as { Radius(): number }).Radius();
    } catch { radius = undefined; }
    // reserva: distância de um ponto da superfície ao eixo
    if (!(radius! > 0)) radius = v3.dist(v3.cross(v3.sub(onSurf, p.axis.o), p.axis.d), [0, 0, 0]);
  }
  // cilindro: âncora a meia altura da face (centroide no eixo deslocado radialmente até à superfície)
  if (p.axis && radius! > 0) {
    const rad = v3.sub(onSurf, p.center);
    const radial = v3.sub(rad, v3.mul(p.axis.d, v3.dot(rad, p.axis.d)));
    if (v3.dist(radial, [0, 0, 0]) > 1e-9) onSurf = v3.add(p.center, v3.mul(v3.norm(radial), radius!));
  }
  let normal: Vec3;
  try { normal = normalOnFace(nf.face, onSurf); } catch { normal = [0, 0, 1]; }
  return { name: nf.name, face: nf.face, type: p.type, center: p.center, normal, axis: p.axis, radius, point: onSurf };
}

export function pmiStates(ctx: Ctx, items: PmiItem[]): PmiState[] {
  if (!ctx.body) return items.map((i) => ({ id: i.id, text: pmiText(i), anchor: [0, 0, 0], normal: [0, 0, 1], faces: [], errors: ["A peça não tem corpo sólido"] }));
  const datums = items.flatMap((i) => (i.kind === "datum" ? [i.label] : []));
  const cache = new Map<string, Resolved | null>();
  const get = (r: { kind: "face"; name: string }) => {
    if (!cache.has(r.name)) cache.set(r.name, resolve(ctx, { kind: "face", name: r.name }));
    return cache.get(r.name)!;
  };
  return items.map((item) => {
    const refs = item.kind === "datum" ? [item.face] : item.faces;
    const res = refs.map((r) => get({ kind: "face", name: r.name }));
    const errors = checkPmi(item, datums, (r) => get({ kind: "face", name: r.name })?.type ?? null);
    const ok = res.filter((x): x is Resolved => !!x);
    let nominal: number | undefined;
    let geom: PmiState["geom"];
    if (item.kind === "dimension" && ok.length === res.length) {
      if (item.type === "distance" && ok.length === 2 && ok.every((x) => x.type === "plane")) {
        const [a, b] = ok;
        if (Math.abs(v3.dot(a.normal, b.normal)) < 1 - 1e-6) errors.push("Distância: as faces não são paralelas");
        else {
          const dd = v3.dot(v3.sub(b.center, a.center), a.normal);
          nominal = Math.abs(dd);
          geom = { kind: "distance", p: a.center, n: a.normal, d: dd };
        }
      } else if ((item.type === "diameter" || item.type === "radius") && ok[0]?.radius) {
        nominal = item.type === "diameter" ? 2 * ok[0].radius : ok[0].radius;
        if (ok[0].axis) {
          // ponto do eixo à altura do centro da face
          const ax = ok[0].axis, t = v3.dot(v3.sub(ok[0].center, ax.o), ax.d);
          geom = { kind: "axis", o: v3.add(ax.o, v3.mul(ax.d, t)) as Vec3, d: ax.d, r: ok[0].radius, p: ok[0].point };
        }
      }
      else if (item.type === "angle" && ok.length === 2) nominal = 180 - (Math.acos(Math.max(-1, Math.min(1, v3.dot(ok[0].normal, ok[1].normal)))) * 180) / Math.PI;
      if (item.nominal !== undefined && nominal !== undefined && Math.abs(item.nominal - nominal) > 1e-6 * Math.max(1, nominal)) errors.push(`O valor fixado (${item.nominal}) difere do modelo (${+nominal.toFixed(4)})`);
    }
    // âncora: média dos pontos das faces; normal da primeira face
    const anchor: Vec3 = ok.length ? [0, 1, 2].map((q) => ok.reduce((s, x) => s + x.point[q], 0) / ok.length) as Vec3 : [0, 0, 0];
    return { id: item.id, text: pmiText(item, nominal), nominal, anchor, normal: ok[0]?.normal ?? [0, 0, 1], faces: ok.map((x) => x.name), errors, geom };
  });
}

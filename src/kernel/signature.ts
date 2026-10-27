// Assinatura geométrica de uma peça (para o assistente de BOM): medidas, tipos de faces, cilindros
// exteriores/interiores, simetria de revolução, prisma sextavado e espessura constante de chapa.
import type { Vec3 } from "../doc/types.ts";
import type { NamedBody } from "./naming.ts";
import { bbox, explore, faceProps, normalOnFace, sampleEdge, v3, volume } from "./occ.ts";

export interface PartSignature {
  volume: number;
  area: number;
  /** Dimensões da caixa envolvente, por ordem decrescente (mm). */
  box: [number, number, number];
  faces: Record<string, number>;
  /** Cilindros: raio, eixo, comprimento ao longo do eixo e se é exterior (veio) ou interior (furo). */
  cylinders: { r: number; o: Vec3; d: Vec3; len: number; outer: boolean }[];
  /** Todas as faces de revolução partilham o mesmo eixo e as planas são perpendiculares a ele. */
  revolution: { o: Vec3; d: Vec3 } | null;
  /** Sextavado: 6 faces planas paralelas ao eixo a 60°; distância entre faces opostas (mm). */
  hex: { across: number; d: Vec3; len: number } | null;
  /** Chapa: duas faces planas grandes, paralelas, com a maior parte da área (espessura constante). */
  plate: { t: number } | null;
  solids: number;
}

const parallel = (a: Vec3, b: Vec3, tol = 1e-4) => Math.abs(Math.abs(v3.dot(a, b)) - 1) < tol;

export function partSignature(body: NamedBody, area: number): PartSignature {
  const shape = body.shape;
  const b = bbox(shape);
  const box = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].sort((x, y) => y - x) as [number, number, number];
  const faces: Record<string, number> = {};
  const cylinders: PartSignature["cylinders"] = [];
  const planes: { n: Vec3; c: Vec3; area: number; f: import("./occ.ts").TopoDS_Face }[] = [];
  const axes: { o: Vec3; d: Vec3 }[] = [];
  for (const f of explore(shape, "face")) {
    const p = faceProps(f);
    faces[p.type] = (faces[p.type] ?? 0) + 1;
    if (p.type === "plane" && p.normal) planes.push({ n: normalOnFace(f, p.center), c: p.center, area: p.area, f });
    if (p.axis) axes.push(p.axis);
    if (p.type === "cylinder" && p.axis) {
      const pts = explore(f, "edge").flatMap((e) => sampleEdge(e, 5).map((s) => s.p));
      if (!pts.length) continue;
      const ts = pts.map((q) => v3.dot(v3.sub(q, p.axis!.o), p.axis!.d));
      const q = pts[0];
      const radial = v3.sub(v3.sub(q, p.axis.o), v3.mul(p.axis.d, v3.dot(v3.sub(q, p.axis.o), p.axis.d)));
      const r = v3.len(radial);
      const outer = v3.dot(normalOnFace(f, q), radial) > 0;
      if (!cylinders.some((c) => Math.abs(c.r - r) < 1e-6 && c.outer === outer && parallel(c.d, p.axis!.d) && v3.len(v3.cross(v3.sub(c.o, p.axis!.o), c.d)) < 1e-6)) {
        cylinders.push({ r, o: p.axis.o, d: p.axis.d, len: Math.max(...ts) - Math.min(...ts), outer });
      }
    }
  }
  // revolução: eixos colineares e planos perpendiculares ao eixo
  let revolution: PartSignature["revolution"] = null;
  if (axes.length && (faces.bspline ?? 0) === 0) {
    const a = axes[0];
    const coaxial = axes.every((x) => parallel(x.d, a.d) && v3.len(v3.cross(v3.sub(x.o, a.o), a.d)) < 1e-5);
    if (coaxial && planes.every((p) => parallel(p.n, a.d))) revolution = a;
  }
  // sextavado: grupos de 6 faces planas cujas normais são perpendiculares a um eixo e distam 60°
  let hex: PartSignature["hex"] = null;
  for (const ax of [...axes.map((x) => x.d), ...planes.map((p) => p.n)]) {
    const side = planes.filter((p) => Math.abs(v3.dot(p.n, ax)) < 1e-4);
    if (side.length < 6) continue;
    const ref = side[0].n;
    const angs = side.map((p) => (Math.atan2(v3.dot(v3.cross(ref, p.n), ax), v3.dot(ref, p.n)) * 180) / Math.PI);
    const on60 = angs.filter((a) => Math.abs(((a % 60) + 60) % 60) < 0.05 || Math.abs((((a % 60) + 60) % 60) - 60) < 0.05);
    if (on60.length < 6) continue;
    const opp = side.find((p) => v3.dot(p.n, ref) < -0.9999);
    if (!opp) continue;
    const across = Math.abs(v3.dot(v3.sub(opp.c, side[0].c), ref));
    // altura do sextavado: extensão das faces laterais ao longo do eixo
    const ts = side.flatMap((p) => explore(p.f, "edge").flatMap((e) => sampleEdge(e, 3).map((q) => v3.dot(q.p, ax))));
    hex = { across, d: ax, len: Math.max(...ts) - Math.min(...ts) };
    break;
  }
  // chapa: as duas maiores faces planas são paralelas, opostas, e cobrem a maior parte da área
  let plate: PartSignature["plate"] = null;
  const big = [...planes].sort((x, y) => y.area - x.area);
  if (big.length >= 2 && parallel(big[0].n, big[1].n) && v3.dot(big[0].n, big[1].n) < 0 && Math.abs(big[0].area - big[1].area) < 0.02 * big[0].area && (big[0].area + big[1].area) > 0.6 * area) {
    const t = Math.abs(v3.dot(v3.sub(big[1].c, big[0].c), big[0].n));
    if (t < box[1] * 0.25) plate = { t };
  }
  return { volume: volume(shape).volume, area, box, faces, cylinders, revolution, hex, plate, solids: explore(shape, "solid").length };
}

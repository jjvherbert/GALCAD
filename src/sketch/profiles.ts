// Deteção de perfis: contornos fechados (com furos) e cadeias abertas, a partir do esboço resolvido.
import type { SketchEntity } from "../doc/types.ts";
import { type Bezier, type P2, allEntities, arcSweep, dist, pt, sampleEntity, splineBeziers } from "./geometry.ts";

/** Segmento orientado de um contorno, ligado à entidade do esboço que o gerou. */
export type Seg =
  | { kind: "line"; entity: string; a: P2; b: P2 }
  | { kind: "arc"; entity: string; c: P2; r: number; from: P2; to: P2; mid: P2 }
  | { kind: "circle"; entity: string; c: P2; r: number }
  | { kind: "spline"; entity: string; beziers: Bezier[] };

export interface Loop {
  segs: Seg[];
  /** Polilinha amostrada (fechada), para testes de contenção. */
  poly: P2[];
  area: number; // com sinal (positiva = anti-horário)
}

export interface Region {
  outer: Loop;
  holes: Loop[];
  /** Chave estável da região: menor id de entidade do contorno exterior. */
  key: string;
}

export interface Chain {
  segs: Seg[];
  closed: boolean;
}

export interface Profiles {
  regions: Region[];
  /** Cadeias de entidades (abertas ou fechadas), por ordem, para caminhos e nervuras. */
  chains: Chain[];
  errors: string[];
}

type Raw = { entity: string; a: P2; b: P2; make: (reversed: boolean) => Seg };

const signedArea = (poly: P2[]) => {
  let s = 0;
  for (let i = 0; i < poly.length - 1; i++) s += poly[i][0] * poly[i + 1][1] - poly[i + 1][0] * poly[i][1];
  return s / 2;
};

function pointInPoly(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(p1: P2, p2: P2, p3: P2, p4: P2): boolean {
  const d = (a: P2, b: P2, c: P2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  // regra semiaberta (zero conta como lado negativo): apanha vértices que caem exatamente na outra polilinha
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

export function polysIntersect(a: P2[], b: P2[]): boolean {
  for (let i = 0; i < a.length - 1; i++) for (let j = 0; j < b.length - 1; j++) if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
  return false;
}

export function segSample(s: Seg): P2[] {
  switch (s.kind) {
    case "line": return [s.a, s.b];
    case "circle": return Array.from({ length: 49 }, (_, i) => [s.c[0] + s.r * Math.cos((i / 48) * 2 * Math.PI), s.c[1] + s.r * Math.sin((i / 48) * 2 * Math.PI)] as P2);
    case "arc": {
      const a0 = Math.atan2(s.from[1] - s.c[1], s.from[0] - s.c[0]);
      const a1 = Math.atan2(s.to[1] - s.c[1], s.to[0] - s.c[0]);
      const am = Math.atan2(s.mid[1] - s.c[1], s.mid[0] - s.c[0]);
      // sentido: o que passa pelo ponto médio
      const ccw = arcSweep(a0, am) < arcSweep(a0, a1);
      const sw = ccw ? arcSweep(a0, a1) : -arcSweep(a1, a0);
      return Array.from({ length: 25 }, (_, i) => [s.c[0] + s.r * Math.cos(a0 + (sw * i) / 24), s.c[1] + s.r * Math.sin(a0 + (sw * i) / 24)] as P2);
    }
    case "spline": {
      const out: P2[] = [];
      for (const [p0, p1, p2, p3] of s.beziers) {
        for (let i = out.length ? 1 : 0; i <= 12; i++) {
          const t = i / 12, u = 1 - t;
          out.push([
            u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
          ]);
        }
      }
      return out;
    }
  }
}

/** Analisa as entidades (não de construção) do esboço resolvido. */
export function findProfiles(entities: Record<string, SketchEntity>): Profiles {
  const ents = allEntities({ entities });
  const errors: string[] = [];
  const raws: Raw[] = [];
  const circles: Seg[] = [];
  let scale = 1;

  for (const [id, e] of Object.entries(entities)) {
    if (e.construction) continue;
    if (e.type === "line") {
      const a = pt(ents, e.p1), b = pt(ents, e.p2);
      scale = Math.max(scale, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]));
      raws.push({ entity: id, a, b, make: (r) => ({ kind: "line", entity: id, a: r ? b : a, b: r ? a : b }) });
    } else if (e.type === "arc") {
      const c = pt(ents, e.c), a = pt(ents, e.s), b = pt(ents, e.e);
      const am = e.a0 + arcSweep(e.a0, e.a1) / 2;
      const mid: P2 = [c[0] + e.r * Math.cos(am), c[1] + e.r * Math.sin(am)];
      scale = Math.max(scale, Math.abs(c[0]) + e.r, Math.abs(c[1]) + e.r);
      raws.push({ entity: id, a, b, make: (r) => ({ kind: "arc", entity: id, c, r: e.r, from: r ? b : a, to: r ? a : b, mid }) });
    } else if (e.type === "spline") {
      const pts = e.pts.map((p) => pt(ents, p));
      if (pts.length < 2) continue;
      const bz = splineBeziers(pts);
      const rev = splineBeziers(pts.slice().reverse());
      raws.push({ entity: id, a: pts[0], b: pts[pts.length - 1], make: (r) => ({ kind: "spline", entity: id, beziers: r ? rev : bz }) });
    } else if (e.type === "circle") {
      circles.push({ kind: "circle", entity: id, c: pt(ents, e.c), r: e.r });
    }
  }

  // vértices: extremos coincidentes (por distância, não por id)
  const tol = 1e-6 * Math.max(1, scale);
  const verts: P2[] = [];
  const vid = (p: P2) => {
    let i = verts.findIndex((v) => dist(v, p) < tol);
    if (i < 0) { verts.push(p); i = verts.length - 1; }
    return i;
  };
  const edges = raws.map((r) => ({ ...r, va: vid(r.a), vb: vid(r.b) }));
  const incident = new Map<number, number[]>();
  edges.forEach((e, i) => {
    for (const v of [e.va, e.vb]) incident.set(v, [...(incident.get(v) ?? []), i]);
  });

  // componentes ligadas
  const seen = new Set<number>();
  const chains: Chain[] = [];
  const loops: Loop[] = [];
  for (let start = 0; start < edges.length; start++) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    while (stack.length) {
      const i = stack.pop()!;
      if (seen.has(i)) continue;
      seen.add(i);
      comp.push(i);
      for (const v of [edges[i].va, edges[i].vb]) for (const j of incident.get(v)!) if (!seen.has(j)) stack.push(j);
    }
    const vs = new Set(comp.flatMap((i) => [edges[i].va, edges[i].vb]));
    const degs = [...vs].map((v) => incident.get(v)!.length);
    if (degs.some((d) => d > 2)) {
      errors.push(`Contorno ramificado (${comp.map((i) => edges[i].entity).join(", ")}): mais de duas entidades num ponto`);
      continue;
    }
    // percorrer a cadeia a partir de um extremo (grau 1) ou de qualquer vértice (fechada)
    const closed = degs.every((d) => d === 2);
    let v = closed ? edges[comp[0]].va : [...vs].find((x) => incident.get(x)!.length === 1)!;
    const used = new Set<number>();
    const segs: Seg[] = [];
    for (;;) {
      const next = incident.get(v)!.find((i) => !used.has(i));
      if (next === undefined) break;
      used.add(next);
      const e = edges[next];
      const reversed = e.va !== v;
      segs.push(e.make(reversed));
      v = reversed ? e.va : e.vb;
    }
    chains.push({ segs, closed });
    if (closed) {
      const poly = segs.flatMap((s, i) => (i ? segSample(s).slice(1) : segSample(s)));
      loops.push({ segs, poly, area: signedArea(poly) });
    }
  }
  for (const c of circles) {
    const poly = segSample(c);
    loops.push({ segs: [c], poly, area: signedArea(poly) });
    chains.push({ segs: [c], closed: true });
  }

  // contornos que se intersetam não definem regiões válidas
  for (let i = 0; i < loops.length; i++) {
    for (let j = i + 1; j < loops.length; j++) {
      if (polysIntersect(loops[i].poly, loops[j].poly)) {
        errors.push(`Contornos intersetam-se (${loops[i].segs[0].entity} e ${loops[j].segs[0].entity})`);
      }
    }
  }

  // aninhamento: profundidade par = exterior; ímpar = furo do contorno que o contém diretamente
  const contains = (outer: Loop, inner: Loop) => Math.abs(outer.area) > Math.abs(inner.area) && pointInPoly(inner.poly[0], outer.poly);
  const depth = loops.map((l) => loops.filter((o) => o !== l && contains(o, l)).length);
  const regions: Region[] = [];
  loops.forEach((l, i) => {
    if (depth[i] % 2) return;
    const holes = loops.filter((h, j) => depth[j] === depth[i] + 1 && contains(l, h));
    const key = l.segs.map((s) => s.entity).sort()[0];
    regions.push({ outer: l, holes, key });
  });
  regions.sort((a, b) => a.key.localeCompare(b.key));
  return { regions, chains, errors };
}

/** Pontos isolados (não de construção, não usados por outras entidades): centros de furos. */
export function isolatedPoints(entities: Record<string, SketchEntity>): { id: string; p: P2 }[] {
  const used = new Set<string>();
  for (const e of Object.values(entities)) {
    if (e.type === "line") { used.add(e.p1); used.add(e.p2); }
    else if (e.type === "circle") used.add(e.c);
    else if (e.type === "arc") { used.add(e.c); used.add(e.s); used.add(e.e); }
    else if (e.type === "spline") e.pts.forEach((p) => used.add(p));
  }
  return Object.entries(entities)
    .filter(([id, e]) => e.type === "point" && !e.construction && !used.has(id))
    .map(([id, e]) => ({ id, p: [(e as { x: number }).x, (e as { y: number }).y] as P2 }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export { sampleEntity };

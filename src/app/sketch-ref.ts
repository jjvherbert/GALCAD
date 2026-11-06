// Arestas do modelo projetadas no plano do esboço (cálculo puro, fora do componente).
import type { RebuildResponse } from "../kernel/protocol.ts";
import type { P2 } from "../sketch/geometry.ts";

type Frame = NonNullable<NonNullable<RebuildResponse["sketches"][string]>["frame"]>;

/** Tolerância de "está no plano" proporcional ao tamanho do modelo. */
export function projTolOf(result: RebuildResponse | null) {
  return 1e-3 * Math.max(1, ...(result?.mass ? result.mass.bbox.max.map((v, i) => Math.abs(v - result.mass!.bbox.min[i])) : [1]));
}

/** Arestas do modelo projetadas, uma a uma, com o nome topológico (para converter). */
export function refGroupsOf(result: RebuildResponse | null, frame: Frame | undefined, projTol: number) {
  const m = result?.mesh;
  if (!m || !frame) return [];
  const L = m.lines;
  return m.edges.map((g) => {
    const pts: P2[] = [];
    let inPlane = true;
    for (let k = 0; k < g.count; k++) {
      if (k > 1 && k % 2 === 0) continue; // segmentos guardados aos pares: o vértice k repete o k−1
      const i = (g.start + k) * 3;
      const d = [L[i] - frame.o[0], L[i + 1] - frame.o[1], L[i + 2] - frame.o[2]];
      pts.push([d[0] * frame.x[0] + d[1] * frame.x[1] + d[2] * frame.x[2], d[0] * frame.y[0] + d[1] * frame.y[1] + d[2] * frame.y[2]]);
      if (Math.abs(d[0] * frame.z[0] + d[1] * frame.z[1] + d[2] * frame.z[2]) > projTol) inPlane = false;
    }
    return { name: g.name, type: g.type, mid: g.mid, dir: g.dir, pts, inPlane };
  });
}

export type RefGroup = ReturnType<typeof refGroupsOf>[number];

/** Arestas do modelo projetadas no plano do esboço (as que estão no plano ficam mais fortes). */
export function refEdgesOf(result: RebuildResponse | null, frame: Frame | undefined, projTol: number) {
  const lines = result?.mesh?.lines;
  if (!lines || !frame) return { inPlane: [] as [P2, P2][], other: [] as [P2, P2][] };
  const inPlane: [P2, P2][] = [], other: [P2, P2][] = [];
  const tol = projTol;
  const p2 = (i: number): [P2, number] => {
    const d = [lines[i] - frame.o[0], lines[i + 1] - frame.o[1], lines[i + 2] - frame.o[2]];
    return [[d[0] * frame.x[0] + d[1] * frame.x[1] + d[2] * frame.x[2], d[0] * frame.y[0] + d[1] * frame.y[1] + d[2] * frame.y[2]], d[0] * frame.z[0] + d[1] * frame.z[1] + d[2] * frame.z[2]];
  };
  for (let i = 0; i < lines.length; i += 6) {
    const [a, za] = p2(i), [b, zb] = p2(i + 3);
    (Math.abs(za) < tol && Math.abs(zb) < tol ? inPlane : other).push([a, b]);
  }
  return { inPlane, other };
}

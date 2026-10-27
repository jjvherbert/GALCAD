// Malha de visualização de uma montagem: as malhas das peças (em coordenadas da peça) são postas
// em cada instância e juntadas numa só, com os nomes prefixados pelo caminho do componente
// ("c2|f2:end:l5", ou "c2/c1|…" dentro de subconjuntos). Assim a seleção, as cores e o realce da
// vista de peça servem também para a montagem.
import type { AssemblyResponse } from "../kernel/protocol.ts";
import type { MeshData } from "../kernel/mesh.ts";
import type { MateRef } from "../doc/project.ts";

const apply = (m: number[], p: ArrayLike<number>, i: number, w: number): [number, number, number] => [
  m[0] * p[i] + m[4] * p[i + 1] + m[8] * p[i + 2] + w * m[12],
  m[1] * p[i] + m[5] * p[i + 1] + m[9] * p[i + 2] + w * m[13],
  m[2] * p[i] + m[6] * p[i + 1] + m[10] * p[i + 2] + w * m[14],
];
const r4 = (v: number[]) => v.map((x) => Math.round(x * 1e4) / 1e4) as [number, number, number];

export function assemblyMesh(r: AssemblyResponse): MeshData | null {
  const items = r.instances.filter((i) => r.parts[i.part]);
  if (!items.length) return null;
  let nv = 0, nt = 0, nl = 0;
  for (const i of items) { const m = r.parts[i.part]; nv += m.vertices.length; nt += m.triangles.length; nl += m.lines.length; }
  const out: MeshData = { vertices: new Float32Array(nv), normals: new Float32Array(nv), triangles: new Uint32Array(nt), lines: new Float32Array(nl), faces: [], edges: [] };
  let ov = 0, ot = 0, ol = 0;
  for (const inst of items) {
    const m = r.parts[inst.part], M = inst.matrix;
    for (let k = 0; k < m.vertices.length; k += 3) {
      out.vertices.set(apply(M, m.vertices, k, 1), ov + k);
      out.normals.set(apply(M, m.normals, k, 0), ov + k);
    }
    const base = ov / 3;
    for (let k = 0; k < m.triangles.length; k++) out.triangles[ot + k] = m.triangles[k] + base;
    for (let k = 0; k < m.lines.length; k += 3) out.lines.set(apply(M, m.lines, k, 1), ol + k);
    for (const f of m.faces) {
      out.faces.push({ ...f, start: f.start + ot, name: `${inst.path}|${f.name}`, center: r4(apply(M, f.center, 0, 1)), normal: f.normal && r4(apply(M, f.normal, 0, 0)) });
    }
    for (const e of m.edges) {
      out.edges.push({ ...e, start: e.start + ol / 3, name: `${inst.path}|${e.name}`, mid: r4(apply(M, e.mid, 0, 1)), dir: e.dir && r4(apply(M, e.dir, 0, 0)) });
    }
    ov += m.vertices.length; ot += m.triangles.length; ol += m.lines.length;
  }
  return out;
}

/**
 * Nome de uma face/aresta da montagem → componente de topo e nome da referência dentro dele:
 * "c2|f2:end:l5" → c2, "f2:end:l5"; "c2/c1|f2:end:l5" → c2, "c1/f2:end:l5".
 */
export function splitAssemblyName(name: string): { component: string; inner: string } | null {
  const bar = name.indexOf("|");
  if (bar < 0) return null;
  const path = name.slice(0, bar).split("/");
  const face = name.slice(bar + 1);
  return { component: path[0], inner: [...path.slice(1), face].join("/") };
}

/** Nome na malha da montagem de uma referência de mate (para realçar no 3D). */
export function meshNameOf(ref: MateRef): string | null {
  if (!("ref" in ref)) return null;
  const parts = ref.ref.name.split("/");
  return `${[ref.component, ...parts.slice(0, -1)].join("/")}|${parts.at(-1)}`;
}


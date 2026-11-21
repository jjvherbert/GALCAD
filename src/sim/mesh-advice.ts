// Avaliador de malha (C9a): tipos das sugestões e aplicação de um patch à malha do estudo.
// Puro (sem OCC): o kernel calcula as sugestões (src/kernel/mesh-advisor.ts); a UI pré-visualiza e aplica.
import type { MeshSeed, SimMesh } from "../doc/study.ts";
import type { TopoRef } from "../doc/types.ts";
import type { V3 } from "./case.ts";
import type { SeedPreview } from "../kernel/sim-fem.ts";

/** Alteração à malha que uma sugestão propõe: `set` substitui campos; seeds, partições e refinamentos locais juntam-se aos existentes. */
export interface MeshPatch {
  set?: Partial<Pick<SimMesh, "layers" | "curvature" | "hexMethod" | "element">>;
  addSeeds?: MeshSeed[];
  addPartitions?: NonNullable<SimMesh["partitions"]>;
  addLocal?: NonNullable<SimMesh["local"]>;
}

export type AdviceRule = "thin" | "tiny" | "arc" | "hex" | "jacobian";

export interface Suggestion {
  /** Estável entre avaliações da mesma malha (regra + região): serve para ignorar e para não duplicar. */
  id: string;
  rule: AdviceRule;
  /** O que a sugestão toca: o bloco/corpo (agrupamento), arestas e faces, e um rótulo legível. */
  region: { block: string; edges?: TopoRef[]; faces?: TopoRef[]; label: string };
  patch: MeshPatch;
  /** Fantasmas a desenhar antes de aceitar: arestas (tags do plano) e planos de corte. Não altera nada. */
  preview: { tags: number[]; planes?: { origin: V3; normal: V3 }[] };
  /** Frase da sugestão, com o limite e a fonte (de src/sim/quality.ts). */
  why: string;
  /** Métrica antes e estimativa depois de aceitar. */
  metric?: { name: string; before: number; after?: number; unit: string };
  /** N.º de elementos nas arestas tocadas, antes e depois (estimativa). */
  elements?: { before: number; after: number };
}

export interface MeshAdvice { suggestions: Suggestion[]; notes: string[] }

/** Malha com o patch aplicado (novo objeto; o original não muda). */
export function applyPatch(mesh: SimMesh, p: MeshPatch): SimMesh {
  const out: SimMesh = { ...mesh, ...p.set };
  if (p.addSeeds?.length) out.seeds = [...(mesh.seeds ?? []), ...p.addSeeds];
  if (p.addPartitions?.length) out.partitions = [...(mesh.partitions ?? []), ...p.addPartitions];
  if (p.addLocal?.length) out.local = [...(mesh.local ?? []), ...p.addLocal];
  return out;
}

/** Vários patches num só (para «Aceitar todas» num só passo de desfazer): `set` mais restritivo ganha. */
export function mergePatches(list: MeshPatch[]): MeshPatch {
  const out: MeshPatch = {};
  for (const p of list) {
    if (p.set) {
      const s = { ...out.set };
      for (const [k, v] of Object.entries(p.set) as [keyof NonNullable<MeshPatch["set"]>, never][]) {
        const cur = s[k];
        s[k] = (typeof cur === "number" && typeof v === "number" ? Math.max(cur, v) : v) as never;
      }
      out.set = s;
    }
    if (p.addSeeds?.length) out.addSeeds = [...(out.addSeeds ?? []), ...p.addSeeds];
    if (p.addPartitions?.length) out.addPartitions = [...(out.addPartitions ?? []), ...p.addPartitions];
    if (p.addLocal?.length) out.addLocal = [...(out.addLocal ?? []), ...p.addLocal];
  }
  return out;
}

/** Sugestões agrupadas por bloco/corpo, pela ordem em que aparecem. */
export function groupByBlock(list: Suggestion[]): { block: string; items: Suggestion[] }[] {
  const m = new Map<string, Suggestion[]>();
  for (const s of list) m.set(s.region.block, [...(m.get(s.region.block) ?? []), s]);
  return [...m].map(([block, items]) => ({ block, items }));
}

/** Tamanho obtido em cada aresta do plano (comprimento / n.º de elementos) e a razão para o tamanho pretendido. */
export function sizeMap(p: SeedPreview, target: number): { tag: number; kind: SeedPreview["edges"][number]["kind"]; n: number; length: number; h: number; ratio: number }[] {
  return p.edges.filter((e) => e.n > 0 && e.points.length >= 6).map((e) => {
    let length = 0;
    for (let i = 3; i < e.points.length; i += 3) length += Math.hypot(e.points[i] - e.points[i - 3], e.points[i + 1] - e.points[i - 2], e.points[i + 2] - e.points[i - 1]);
    const h = length / e.n;
    return { tag: e.tag, kind: e.kind, n: e.n, length, h, ratio: target > 0 ? h / target : NaN };
  });
}

// Rótulo e resumo das partições da malha para a árvore do estudo (puros: sem store, testáveis em Node).
import type { CadDocument } from "../doc/types.ts";
import type { SimMesh } from "../doc/study.ts";

type Partition = NonNullable<SimMesh["partitions"]>[number];

const num = (v: unknown) => (typeof v === "number" ? String(+v.toPrecision(6)) : String(v ?? "?"));

/** Rótulo curto de uma partição para a árvore: «X = 50», «Plano XY», «Esboço Esboço2», «Cilindro R 5»… */
export function partitionLabel(c: Partition, doc: Pick<CadDocument, "features">): string {
  switch (c.axis) {
    case "x": case "y": case "z": return `${c.axis.toUpperCase()} = ${num(c.at)}`;
    case "n": return `n·x = ${num(c.at)}`;
    case "f": return "Plano de uma face";
    case "plane": {
      const p = c.plane;
      if (!p || p.kind === "std") return `Plano ${p?.name ?? "XY"}`;
      if (p.kind === "face") return "Plano de uma face";
      return `Plano ${doc.features.find((f) => f.id === p.feature)?.name ?? "de referência"}`;
    }
    case "sketch": return `Esboço ${doc.features.find((f) => f.id === c.sketch)?.name ?? "(por escolher)"}`;
    case "cyl": return `Cilindro R ${num(c.at)}`;
  }
}

/** Resumo para o nó «Malha»: «3 partições (1 suprimida)». */
export function partitionSummary(m: SimMesh): string {
  const all = m.partitions ?? [];
  if (!all.length) return "";
  const off = all.filter((c) => c.suppressed).length;
  return `${all.length} partiç${all.length === 1 ? "ão" : "ões"}${off ? ` (${off} suprimida${off > 1 ? "s" : ""})` : ""}`;
}

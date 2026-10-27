// Lista de materiais (BOM) de uma montagem: só o nível de topo, só peças (achatada) ou indentada.
// Pura: recebe o projeto e o volume de cada peça (mm³) e devolve as linhas.
import { type CadProject, type PartProperties, DEFAULT_DENSITY } from "../doc/project.ts";

export type BomMode = "top" | "parts" | "indented";

export interface BomRow {
  /** Número do item (balões). Na indentada: "2.1". */
  item: string;
  level: number;
  kind: "part" | "assembly";
  id: string;
  name: string;
  number: string;
  description: string;
  material: string;
  qty: number;
  /** Massa unitária (g); null se o volume não for conhecido. */
  unitMass: number | null;
  custom: Record<string, string>;
}

export const BOM_COLUMNS: { key: string; label: string }[] = [
  { key: "item", label: "Item" }, { key: "qty", label: "Qtd." }, { key: "number", label: "Número" },
  { key: "description", label: "Descrição" }, { key: "material", label: "Material" }, { key: "unitMass", label: "Massa unit. (kg)" },
  { key: "totalMass", label: "Massa total (kg)" },
];

/** Massa (g) de uma peça ou montagem. */
export function docMass(project: CadProject, kind: "part" | "assembly", id: string, volumes: Record<string, number>, seen = new Set<string>()): number | null {
  if (kind === "part") {
    const p = project.parts.find((x) => x.id === id);
    const v = volumes[id];
    return p && v !== undefined ? (v / 1000) * (p.properties?.density ?? DEFAULT_DENSITY) : null;
  }
  if (seen.has(id)) return null;
  seen.add(id);
  const a = project.assemblies.find((x) => x.id === id);
  if (!a) return null;
  let m = 0;
  for (const c of a.components) {
    if (c.suppressed) continue;
    const x = docMass(project, c.ref.kind, c.ref.id, volumes, new Set(seen));
    if (x === null) return null;
    m += x;
  }
  return m;
}

function propsOf(project: CadProject, kind: "part" | "assembly", id: string): { name: string; p: PartProperties } {
  const d = kind === "part" ? project.parts.find((x) => x.id === id) : project.assemblies.find((x) => x.id === id);
  return { name: d?.name ?? id, p: d?.properties ?? {} };
}

function row(project: CadProject, kind: "part" | "assembly", id: string, qty: number, item: string, level: number, volumes: Record<string, number>): BomRow {
  const { name, p } = propsOf(project, kind, id);
  return {
    item, level, kind, id, name, number: p.number || name, description: p.description ?? "", material: kind === "part" ? p.material ?? "" : "",
    qty, unitMass: docMass(project, kind, id, volumes), custom: p.custom ?? {},
  };
}

/** Grupos (referência → quantidade) dos componentes de uma montagem, pela ordem de aparição. */
function groups(project: CadProject, asmId: string): { kind: "part" | "assembly"; id: string; qty: number }[] {
  const a = project.assemblies.find((x) => x.id === asmId);
  const out: { kind: "part" | "assembly"; id: string; qty: number }[] = [];
  for (const c of a?.components ?? []) {
    if (c.suppressed) continue;
    const g = out.find((x) => x.id === c.ref.id);
    if (g) g.qty++;
    else out.push({ kind: c.ref.kind, id: c.ref.id, qty: 1 });
  }
  return out;
}

export function computeBom(project: CadProject, asmId: string, mode: BomMode, volumes: Record<string, number>): BomRow[] {
  if (mode === "top") return groups(project, asmId).map((g, i) => row(project, g.kind, g.id, g.qty, String(i + 1), 0, volumes));
  if (mode === "parts") {
    const totals = new Map<string, number>();
    const walk = (id: string, mult: number, depth: number) => {
      if (depth > 32) return;
      for (const g of groups(project, id)) {
        if (g.kind === "part") totals.set(g.id, (totals.get(g.id) ?? 0) + g.qty * mult);
        else walk(g.id, g.qty * mult, depth + 1);
      }
    };
    walk(asmId, 1, 0);
    return [...totals].map(([id, qty], i) => row(project, "part", id, qty, String(i + 1), 0, volumes));
  }
  const out: BomRow[] = [];
  const walk = (id: string, prefix: string, level: number) => {
    if (level > 32) return;
    groups(project, id).forEach((g, i) => {
      const item = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      out.push(row(project, g.kind, g.id, g.qty, item, level, volumes));
      if (g.kind === "assembly") walk(g.id, item, level + 1);
    });
  };
  walk(asmId, "", 0);
  return out;
}

/** Valor de uma coluna (texto) para tabela/CSV. */
export function bomCell(r: BomRow, key: string): string {
  const kg = (g: number | null) => (g === null ? "" : (g / 1000).toLocaleString("pt-PT", { maximumFractionDigits: 3, minimumFractionDigits: 3 }));
  switch (key) {
    case "item": return r.item;
    case "qty": return String(r.qty);
    case "number": return r.number;
    case "description": return r.description;
    case "material": return r.material;
    case "unitMass": return kg(r.unitMass);
    case "totalMass": return kg(r.unitMass === null ? null : r.unitMass * r.qty);
    case "name": return r.name;
    default: return r.custom[key] ?? "";
  }
}

/** Colunas personalizadas presentes nas linhas (propriedades personalizadas das peças). */
export function customColumns(rows: BomRow[]): string[] {
  return [...new Set(rows.flatMap((r) => Object.keys(r.custom)))];
}

/** Item do balão de um componente de topo (BOM de nível de topo). */
export function itemOfComponent(project: CadProject, asmId: string, componentId: string): string | null {
  const a = project.assemblies.find((x) => x.id === asmId);
  const c = a?.components.find((x) => x.id === componentId);
  if (!c) return null;
  const i = groups(project, asmId).findIndex((g) => g.id === c.ref.id);
  return i < 0 ? null : String(i + 1);
}

// Cores por material na vista 3D (C1c): cada material distinto do estudo tem uma cor e uma linha na
// legenda; as faces de corpos sem material válido (sem nome ou E ≤ 0) ficam a vermelho e tracejadas.
import { bodyMaterial, type FemStudy, type SimMaterial } from "../doc/study.ts";

export const MATERIAL_PALETTE = [0x60a5fa, 0x34d399, 0xfbbf24, 0xa78bfa, 0xf472b6, 0x2dd4bf, 0xfb923c, 0xa3e635];
/** Cor das faces sem material válido. */
export const MISSING_MATERIAL = 0xef4444;

export interface MaterialLegendRow { name: string; color: number; /** Corpos com este material. */ bodies: number; missing?: boolean }
export interface MaterialColors {
  /** Nome da face → cor do material (ou `MISSING_MATERIAL`). */
  faces: Map<string, number>;
  /** Faces de corpos sem material válido. */
  missing: string[];
  legend: MaterialLegendRow[];
}

/** O material serve para o cálculo (o mesmo critério da verificação do modelo para E). */
export const validMaterial = (m: SimMaterial | undefined): m is SimMaterial => !!m && !!m.name?.trim() && m.E > 0;

const keyOf = (m: SimMaterial) => JSON.stringify([m.name, m.E, m.nu, m.density]);

/** Cores por material das faces dadas (`body` = "" no sólido, caminho da instância na montagem). */
export function materialColors(s: FemStudy, faces: readonly { name: string; body: string }[]): MaterialColors {
  const byKey = new Map<string, MaterialLegendRow>(), bodies = new Map<string, Set<string>>();
  const out: MaterialColors = { faces: new Map(), missing: [], legend: [] };
  let missingRow: MaterialLegendRow | null = null;
  const missingBodies = new Set<string>();
  for (const f of faces) {
    const m = bodyMaterial(s, f.body);
    if (!validMaterial(m)) {
      out.faces.set(f.name, MISSING_MATERIAL);
      out.missing.push(f.name);
      missingRow ??= { name: "Sem material", color: MISSING_MATERIAL, bodies: 0, missing: true };
      missingBodies.add(f.body);
      continue;
    }
    const k = keyOf(m);
    let row = byKey.get(k);
    if (!row) {
      // dois materiais com o mesmo nome e propriedades diferentes distinguem-se na legenda
      const same = [...byKey.values()].filter((r) => r.name === m.name || r.name.startsWith(`${m.name} (`)).length;
      row = { name: same ? `${m.name} (${same + 1})` : m.name, color: MATERIAL_PALETTE[byKey.size % MATERIAL_PALETTE.length], bodies: 0 };
      byKey.set(k, row);
      bodies.set(k, new Set());
    }
    bodies.get(k)!.add(f.body);
    out.faces.set(f.name, row.color);
  }
  for (const [k, row] of byKey) out.legend.push({ ...row, bodies: bodies.get(k)!.size });
  if (missingRow) out.legend.push({ ...missingRow, bodies: missingBodies.size });
  return out;
}

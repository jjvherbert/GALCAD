// Pré-visualização da malha (antes de calcular): superfície exterior com as arestas dos elementos e
// cada face colorida pela qualidade do seu elemento (jacobiano escalado, razão de aspeto), mais o
// relatório de qualidade. Puro: corre no agente.
import type { FemCase } from "./case.ts";
import type { Msh } from "./msh.ts";
import { exteriorSurface } from "./calculix.ts";
import { type MeshQuality, elementQuality, meshQuality } from "./quality.ts";
import { SOLIDS } from "./elements.ts";
import { elementsOf, solidBlocks } from "./msh.ts";
import type { ResultView } from "./result.ts";

export interface MeshPreview { quality: MeshQuality; view: ResultView; summary: [string, string][] }

export function meshPreview(c: FemCase, m: Msh): MeshPreview {
  const quality = meshQuality(m, c.bodies);
  // razão de aspeto por elemento (o jacobiano já vem em quality.perElement)
  const ar: number[] = [];
  for (const e of elementsOf(solidBlocks(m, c.bodies))) {
    const st = SOLIDS[e.type];
    ar.push(elementQuality(st.kind, e.nodes.slice(0, st.corners).map((n) => m.nodes.get(n)!)).ar);
  }
  // vértices próprios por face: cor uniforme por elemento (como os mapas de qualidade do Femap/Abaqus)
  const ext = exteriorSurface(m, c.bodies);
  const positions: number[] = [], triangles: number[] = [], edges: number[] = [], sj: number[] = [], aspect: number[] = [];
  for (const f of ext.faces) {
    const base = positions.length / 3;
    for (const n of f.corners) { positions.push(...m.nodes.get(n)!); sj.push(quality.perElement[f.element]); aspect.push(ar[f.element]); }
    // triângulos com a normal para fora (os cantos vêm com a normal para dentro)
    const k = f.corners.length;
    if (k === 3) triangles.push(base, base + 2, base + 1);
    else triangles.push(base, base + 3, base + 2, base, base + 2, base + 1);
    for (let i = 0; i < k; i++) edges.push(base + i, base + ((i + 1) % k));
  }
  const view: ResultView = {
    fields: [{ name: "Jacobiano escalado", unit: "" }, { name: "Razão de aspeto", unit: "" }],
    modes: [],
    layers: [{ name: "Malha", visible: true, positions, triangles, values: [sj, aspect], edges }],
  };
  const types = Object.entries(quality.types).map(([k, n]) => `${n} ${{ hex8: "hexaedros de 8 nós", hex20: "hexaedros de 20 nós", tet4: "tetraedros de 4 nós", tet10: "tetraedros de 10 nós" }[k] ?? k}`).join(" + ");
  const summary: [string, string][] = [["Malha", `${quality.nodes} nós · ${types}`], ["Volume da malha", `${quality.volume.toPrecision(6)} mm³`]];
  const flagged = quality.metrics.reduce((s, q) => s + q.fail.reduce((a, b) => a + b, 0), 0);
  summary.push(["Verificação", quality.ok ? (flagged ? `${flagged} assinalamento(s) — ver a qualidade` : "todos os elementos dentro dos limites") : "elementos inválidos (jacobiano ≤ 0)"]);
  return { quality, view, summary };
}

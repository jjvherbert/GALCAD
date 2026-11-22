// Pré-visualização da malha (antes de calcular): superfície exterior com as arestas dos elementos e
// cada face colorida pela qualidade do seu elemento (jacobiano escalado, razão de aspeto), mais o
// relatório de qualidade. Puro: corre no agente.
import type { FemCase } from "./case.ts";
import type { Msh } from "./msh.ts";
import { exteriorSurface } from "./calculix.ts";
import { type MeshReport, meshQuality } from "./quality.ts";
import type { ResultView } from "./result.ts";

export interface MeshPreview { quality: MeshReport; view: ResultView; summary: [string, string][] }

export function meshPreview(c: FemCase, m: Msh): MeshPreview {
  const shell = !!c.shell;
  const quality = meshQuality(m, c.bodies, shell);
  // vértices próprios por face: cor uniforme por elemento (como os mapas de qualidade do Femap/Abaqus)
  const ext = exteriorSurface(m, c.bodies, shell);
  const { perElement, perElementAr, ...report } = quality;
  // números curtos no JSON (a resposta da malha ao vivo tem dezenas de MB por extenso):
  // posições a 0,1 µm e medidas a 3 casas chegam para desenhar e colorir
  const mm = (x: number) => Math.round(x * 1e4) / 1e4, q3 = (x: number) => Math.round(x * 1e3) / 1e3;
  const positions: number[] = [], triangles: number[] = [], edges: number[] = [], sj: number[] = [], aspect: number[] = [];
  for (const f of ext.faces) {
    const base = positions.length / 3;
    const q = q3(perElement[f.element]), a = q3(perElementAr[f.element]);
    for (const n of f.corners) { const p = m.nodes.get(n)!; positions.push(mm(p[0]), mm(p[1]), mm(p[2])); sj.push(q); aspect.push(a); }
    // triângulos com a normal para fora (os cantos vêm com a normal para dentro; na casca, pela ordem do elemento)
    const k = f.corners.length;
    if (shell) triangles.push(base, base + 1, base + 2);
    else if (k === 3) triangles.push(base, base + 2, base + 1);
    else triangles.push(base, base + 3, base + 2, base, base + 2, base + 1);
    for (let i = 0; i < k; i++) edges.push(base + i, base + ((i + 1) % k));
  }
  const view: ResultView = {
    fields: [{ name: "Jacobiano escalado", unit: "" }, { name: "Razão de aspeto", unit: "" }],
    modes: [],
    layers: [{ name: "Malha", visible: true, positions, triangles, values: [sj, aspect], edges }],
  };
  const types = Object.entries(quality.types).map(([k, n]) => `${n} ${{ hex8: "hexaedros de 8 nós", hex20: "hexaedros de 20 nós", tet4: "tetraedros de 4 nós", tet10: "tetraedros de 10 nós", tri3: "triângulos de 3 nós", tri6: "triângulos de 6 nós" }[k] ?? k}`).join(" + ");
  const summary: [string, string][] = [["Malha", `${quality.nodes} nós · ${types}`], shell ? ["Área da malha", `${quality.volume.toPrecision(6)} mm² · espessura ${c.shell!.thickness} mm`] : ["Volume da malha", `${quality.volume.toPrecision(6)} mm³`]];
  const flagged = quality.metrics.reduce((s, q) => s + q.fail.reduce((a, b) => a + b, 0), 0);
  summary.push(["Verificação", quality.ok ? (flagged ? `${flagged} assinalamento(s) — ver a qualidade` : "todos os elementos dentro dos limites") : "elementos inválidos (jacobiano ≤ 0)"]);
  return { quality: report, view, summary };
}

// Script Gmsh (.geo) de um caso: importa o BREP exato do núcleo (mesma numeração de faces que o
// OpenCASCADE), define os grupos físicos com os nomes das condições e os tamanhos de malha.
// Corre com `gmsh mesh.geo -3 -o mesh.msh` (malha 3D, MSH 4.1 ASCII).
import type { CfdCase, FemCase } from "./case.ts";

const list = (tags: number[]) => `{${tags.join(", ")}}`;

export function femGeo(c: FemCase): string {
  const hex = c.mesh.element === "hex";
  const out = [
    `// Gerado pelo CAD protótipo — ${c.title}`,
    `// Unidades: mm. Elementos ${hex ? (c.mesh.hexMethod === "subdivision" ? "hexaédricos (subdivisão)" : "hexaédricos estruturados") : "tetraédricos"} de ordem ${c.mesh.order}.`,
    `SetFactory("OpenCASCADE");`,
    `Merge "model.brep";`,
  ];
  // um corpo: grupo SOLID; montagem: um grupo por volume (B1, B2, … pela ordem do composto)
  if (c.bodies?.length) c.bodies.forEach((b, k) => out.push(`Physical Volume("${b.group}") = {${k + 1}};`));
  else out.push(`Physical Volume("SOLID") = Volume{:};`);
  for (const [name, tags] of Object.entries(c.groups)) out.push(`Physical Surface("${name}") = ${list(tags)};`);
  out.push(
    `Mesh.MeshSizeMax = ${c.mesh.size};`,
    `Mesh.MeshSizeMin = ${c.mesh.minSize};`,
    `Mesh.MeshSizeFromCurvature = ${c.mesh.curvature};`,
    `Mesh.ElementOrder = ${c.mesh.order};`,
    // elementos quadráticos com os nós intermédios na geometria; otimização leve da qualidade (só nos
    // tetraedros: nos hexaedros de 20 nós a otimização do Gmsh pode não terminar)
    `Mesh.HighOrderOptimize = ${c.mesh.order === 2 && !hex ? 1 : 0};`,
    `Mesh.Optimize = 1;`,
    `Mesh.Algorithm3D = 1;`,
    `Mesh.MshFileVersion = 4.1;`,
    `Mesh.Binary = 0;`,
    `Mesh.SaveAll = 0;`,
  );
  for (const l of c.mesh.local) out.push(`MeshSize{ PointsOf{ Surface${list(c.groups[l.group])}; } } = ${l.size};`);
  out.push(...meshControls(c));
  return out.join("\n") + "\n";
}

/**
 * Controlos manuais da malha (ao estilo do pré-processador do Femap): seeds nas arestas (n.º de
 * elementos e distribuição), superfícies e volumes mapeados (transfinitos) e o tipo de elemento.
 */
export function meshControls(c: FemCase): string[] {
  const m = c.mesh, out: string[] = [];
  const hex = m.element === "hex";
  for (const cv of m.curves ?? []) {
    // n elementos = n + 1 nós; progressão geométrica (razão entre elementos consecutivos) ou bump
    const dist = cv.progression && Math.abs(cv.progression - 1) > 1e-9 ? ` Using Progression ${cv.progression}` : cv.bump && Math.abs(cv.bump - 1) > 1e-9 ? ` Using Bump ${cv.bump}` : "";
    out.push(`Transfinite Curve{${cv.tag}} = ${cv.n + 1}${dist};`);
  }
  if (m.surfaces?.length) {
    out.push(`Transfinite Surface${list(m.surfaces)};`);
    if (hex) out.push(`Recombine Surface${list(m.surfaces)};`);
  }
  if (m.volumes?.length) out.push(`Transfinite Volume${list(m.volumes)};`);
  if (hex) {
    // hexaedros de 20 nós (serendipity), como o C3D20R do Abaqus/CalculiX
    if (m.order === 2) out.push(`Mesh.SecondOrderIncomplete = 1;`);
    // subdivisão: cada tetraedro em 4 hexaedros (e cada triângulo em 3 quadriláteros)
    if (m.hexMethod === "subdivision") out.push(`Mesh.SubdivisionAlgorithm = 2;`);
  }
  return out;
}

/**
 * Malha de volume de fluido para o SU2. Interno: o próprio corpo. Externo: caixa do domínio menos o
 * corpo; as faces da caixa ficam "farfield" e as do corpo "body" (identificadas pela caixa envolvente).
 */
export function su2Geo(c: CfdCase): string {
  const out = [`// Gerado pelo CAD protótipo — ${c.title} (SU2)`, `SetFactory("OpenCASCADE");`, `Merge "model.brep";`];
  const s = c.mesh.size;
  if (c.regime === "internal") {
    out.push(`Physical Volume("fluid") = Volume{:};`);
    for (const [name, tags] of Object.entries(c.groups)) out.push(`Physical Surface("${name}") = ${list(tags)};`);
  } else {
    const d = c.domain!;
    const e = 1e-3 * Math.max(...d.max.map((x, i) => x - d.min[i]));
    out.push(
      `box = newv; Box(box) = {${d.min.join(", ")}, ${d.max.map((x, i) => x - d.min[i]).join(", ")}};`,
      `fluid() = BooleanDifference{ Volume{box}; Delete; }{ Volume{1}; Delete; };`,
      // as faces do corpo estão estritamente dentro da caixa do domínio; as restantes são da caixa
      `inner() = Surface In BoundingBox{${d.min.map((x) => x + e).join(", ")}, ${d.max.map((x) => x - e).join(", ")}};`,
      `far() = Surface{:};`,
      `far() -= inner();`,
      `Physical Volume("fluid") = fluid();`,
      `Physical Surface("body") = inner();`,
      `Physical Surface("farfield") = far();`,
    );
  }
  // SU2 em unidades SI: a malha sai em metros
  out.push(`Mesh.ScalingFactor = 0.001;`, `Mesh.MeshSizeMax = ${s};`, `Mesh.MeshSizeMin = ${s / 10};`, `Mesh.MeshSizeFromCurvature = 12;`, `Mesh.Algorithm3D = 1;`, `Mesh.ElementOrder = 1;`, `Mesh.SaveAll = 0;`);
  return out.join("\n") + "\n";
}

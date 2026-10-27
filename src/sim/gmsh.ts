// Script Gmsh (.geo) de um caso: importa o BREP exato do núcleo (mesma numeração de faces que o
// OpenCASCADE), define os grupos físicos com os nomes das condições e os tamanhos de malha.
// Corre com `gmsh mesh.geo -3 -o mesh.msh` (malha 3D, MSH 4.1 ASCII).
import type { CfdCase, FemCase } from "./case.ts";

const list = (tags: number[]) => `{${tags.join(", ")}}`;

export function femGeo(c: FemCase): string {
  const out = [
    `// Gerado pelo CAD protótipo — ${c.title}`,
    `// Unidades: mm. Elementos tetraédricos de ordem ${c.mesh.order}.`,
    `SetFactory("OpenCASCADE");`,
    `Merge "model.brep";`,
    `Physical Volume("SOLID") = Volume{:};`,
  ];
  for (const [name, tags] of Object.entries(c.groups)) out.push(`Physical Surface("${name}") = ${list(tags)};`);
  out.push(
    `Mesh.MeshSizeMax = ${c.mesh.size};`,
    `Mesh.MeshSizeMin = ${c.mesh.minSize};`,
    `Mesh.MeshSizeFromCurvature = ${c.mesh.curvature};`,
    `Mesh.ElementOrder = ${c.mesh.order};`,
    // elementos quadráticos com os nós intermédios na geometria; otimização leve da qualidade
    `Mesh.HighOrderOptimize = ${c.mesh.order === 2 ? 1 : 0};`,
    `Mesh.Optimize = 1;`,
    `Mesh.Algorithm3D = 1;`,
    `Mesh.MshFileVersion = 4.1;`,
    `Mesh.Binary = 0;`,
    `Mesh.SaveAll = 0;`,
  );
  for (const l of c.mesh.local) out.push(`MeshSize{ PointsOf{ Surface${list(c.groups[l.group])}; } } = ${l.size};`);
  return out.join("\n") + "\n";
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

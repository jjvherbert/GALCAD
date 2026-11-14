// Exportar a vista de resultados para VTK XML (.vtu, UnstructuredGrid em ASCII), para abrir no ParaView
// ou no Salome (ParaVis): uma Piece por camada (triângulos), os campos como PointData escalares e as
// deformadas como vetores de 3 componentes. Coordenadas em mm, como no visualizador. Puro.
import { type ResultView, layerShown } from "./result.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Número em texto curto e lido pelo VTK (NaN para valores em falta ou não finitos). */
const num = (x: number) => (Number.isFinite(x) ? String(+x.toPrecision(9)) : "NaN");
const lines = (xs: ArrayLike<number>, f: (x: number) => string, per = 12) => {
  const out: string[] = [];
  for (let i = 0; i < xs.length; i += per) out.push(Array.from({ length: Math.min(per, xs.length - i) }, (_, k) => f(xs[i + k])).join(" "));
  return out.join("\n");
};
const array = (type: string, name: string, comps: number, body: string) =>
  `<DataArray type="${type}"${name ? ` Name="${esc(name)}"` : ""}${comps > 1 ? ` NumberOfComponents="${comps}"` : ""} format="ascii">\n${body}\n</DataArray>`;

/** Nome do campo com a unidade, como na legenda: «von Mises (MPa)». */
const label = (name: string, unit: string) => (unit ? `${name} (${unit})` : name);

/**
 * Ficheiro .vtu com as camadas visíveis (ou todas, com `all`). Um campo sem significado numa camada
 * (`null`) sai como NaN, para todas as Pieces terem os mesmos arrays.
 */
export function toVtu(v: ResultView, opts: { hidden?: readonly string[]; all?: boolean } = {}): string {
  const layers = v.layers.filter((l) => opts.all || layerShown(l, opts.hidden ?? []));
  const pieces = layers.map((l) => {
    const n = l.positions.length / 3, t = l.triangles.length / 3;
    const scalars = v.fields.map((f, i) => {
      const vals = l.values[i];
      return array("Float64", label(f.name, f.unit), 1, lines(vals ?? new Array(n).fill(NaN), num));
    });
    const vectors = v.modes.map((m, i) => array("Float64", `Deslocamento ${m} (mm)`, 3, lines(l.displacements?.[i] ?? new Array(3 * n).fill(NaN), num)));
    return [
      `<Piece NumberOfPoints="${n}" NumberOfCells="${t}">`,
      `<!-- ${esc(l.name).replace(/--/g, "- -")} -->`,
      `<PointData${v.fields.length ? ` Scalars="${esc(label(v.fields[0].name, v.fields[0].unit))}"` : ""}${v.modes.length ? ` Vectors="${esc(`Deslocamento ${v.modes[0]} (mm)`)}"` : ""}>`,
      ...scalars, ...vectors,
      "</PointData>",
      "<Points>", array("Float64", "", 3, lines(l.positions, num)), "</Points>",
      "<Cells>",
      array("Int32", "connectivity", 1, lines(l.triangles, String)),
      array("Int32", "offsets", 1, lines(Array.from({ length: t }, (_, k) => 3 * (k + 1)), String)),
      array("UInt8", "types", 1, lines(new Array(t).fill(5), String, 40)),
      "</Cells>",
      "</Piece>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0"?>',
    '<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian">',
    "<UnstructuredGrid>",
    ...pieces,
    "</UnstructuredGrid>",
    "</VTKFile>",
    "",
  ].join("\n");
}

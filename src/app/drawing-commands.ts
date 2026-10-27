// Separadores do CommandManager no modo de desenho.
export const DRAWING_TABS: { id: "drawing" | "annotate"; label: string; groups: { title: string; ids: string[] }[] }[] = [
  { id: "drawing", label: "Esquema de vistas", groups: [
    { title: "Vistas", ids: ["dr.view.projected", "dr.view.section", "dr.view.detail", "dr.view.aux"] },
    { title: "Exportar", ids: ["dr.export.pdf", "dr.export.dxf", "dr.export.svg"] },
  ] },
  { id: "annotate", label: "Anotação", groups: [
    { title: "Cotas", ids: ["dr.dim", "dr.modelDims", "dr.pmi"] },
    { title: "Símbolos", ids: ["dr.note", "dr.gdt", "dr.datum", "dr.surface", "dr.weld"] },
    { title: "Montagem", ids: ["dr.balloon", "dr.autoBalloon", "dr.bom"] },
  ] },
];

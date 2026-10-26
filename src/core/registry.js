// Descoberta automática de plugins: cada pasta em src/plugins/ com plugin.js (metadados)
// e geometry.js (construtores, só carregado no worker). Ids de modelo: "<plugin>/<modelo>".
const metas = import.meta.glob("../plugins/*/plugin.js", { eager: true, import: "default" });

export const plugins = Object.values(metas).sort((a, b) => (a.id === "base" ? -1 : b.id === "base" ? 1 : a.name.localeCompare(b.name)));

export const modelDefs = Object.fromEntries(
  plugins.flatMap((p) => Object.entries(p.models).map(([k, m]) => [`${p.id}/${k}`, { ...m, plugin: p.id }])),
);

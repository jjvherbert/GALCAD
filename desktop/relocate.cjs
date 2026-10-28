// Relocação do ambiente conda do code_aster incluído no instalador: foi construído noutra pasta e os
// ficheiros de texto que a citam (configuração do code_aster, numpy/scipy, pkg-config) passam a citar
// a pasta onde está. Usado pela app (instalador e arranque) e pelo CI:
//   node desktop/relocate.cjs <pasta code_aster>
const fs = require("node:fs");
const path = require("node:path");

function relocateAster(dir) {
  const f = path.join(dir, ".galcad-relocate.json");
  if (!fs.existsSync(f)) return { ok: true, changed: 0 };
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  const target = path.resolve(dir).replace(/\\/g, "/");
  if (m.prefix === target) return { ok: true, changed: 0 };
  let changed = 0;
  for (const rel of m.files) {
    const p = path.join(dir, rel);
    try {
      const t = fs.readFileSync(p, "utf8");
      if (t.includes(m.prefix)) { fs.writeFileSync(p, t.split(m.prefix).join(target)); changed++; }
    } catch { /* ficheiro em falta: ignorado */ }
  }
  fs.writeFileSync(f, JSON.stringify({ ...m, prefix: target }, null, 1));
  return { ok: true, changed };
}

module.exports = { relocateAster };

if (require.main === module) {
  const r = relocateAster(process.argv[2] ?? ".");
  console.log(`code_aster: ${r.changed} ficheiro(s) relocado(s)`);
}

// Constrói todos os modelos de todos os plugins com os valores por defeito e exporta STEP.
// Uso: npm test
import opencascade from "replicad-opencascadejs";
import { setOC, importSTEP } from "replicad";
import { readdirSync } from "node:fs";

setOC(await opencascade());
const root = new URL("../plugins/", import.meta.url);
let failed = 0;
for (const dir of readdirSync(root)) {
  const { default: meta } = await import(new URL(`${dir}/plugin.js`, root));
  const { builders } = await import(new URL(`${dir}/geometry.js`, root));
  for (const [key, def] of Object.entries(meta.models)) {
    const params = Object.fromEntries(Object.entries(def.params).map(([k, p]) => [k, p.value]));
    try {
      const { shape } = builders[key](params);
      const back = await importSTEP(shape.blobSTEP());
      const [[x0, y0, z0], [x1, y1, z1]] = back.boundingBox.bounds;
      console.log(`ok   ${dir}/${key}  ${[x1 - x0, y1 - y0, z1 - z0].map((v) => v.toFixed(1)).join(" × ")} (${def.units}, antes da conversão)`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${dir}/${key}: ${e.message ?? e}`);
    }
  }
}
process.exit(failed ? 1 : 0);

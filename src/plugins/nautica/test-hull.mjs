import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { writeFileSync } from "node:fs";
const oc = await opencascade(); setOC(oc);
const { buildHull, hydrostatics } = await import("./geometry-hull.js");
const p = { L: 8, B: 2.6, D: 1.2, T: 0.5 };
const hull = buildHull(p);
console.log("hidro", hydrostatics(hull, p));
writeFileSync("/tmp/claude-0/hull.step", Buffer.from(await hull.blobSTEP().arrayBuffer()));

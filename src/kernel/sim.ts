// Do estudo (no documento) ao caso de simulação (números, grupos de faces) e aos ficheiros: BREP
// exato, script Gmsh, `case.json`, dicionários OpenFOAM/STL por patch ou configuração SU2, e um
// LEIA-ME com as hipóteses e os passos. A malha e o deck do CalculiX são feitos a seguir pelo agente
// local (que corre o Gmsh) — ver `tools/cad-runner.ts`.
import { type Study } from "../doc/study.ts";
import { type Ctx, type StepReport } from "./context.ts";
import { oc } from "./occ.ts";
import { type SimCase } from "../sim/case.ts";
import { femGeo, su2Geo } from "../sim/gmsh.ts";
import { openfoamCase } from "../sim/openfoam.ts";
import { su2Config } from "../sim/su2.ts";
import { type SimFiles, bodyOf, readme } from "./sim-common.ts";
import { femCase, femTopo } from "./sim-fem.ts";
import { cfdCase, stlPatches } from "./sim-cfd.ts";

export type { SimFiles } from "./sim-common.ts";
export type { AsmBody } from "./sim-asm.ts";
export { assemblyStudyCase, singleSolid } from "./sim-asm.ts";
export { femCase } from "./sim-fem.ts";
export { cfdCase } from "./sim-cfd.ts";

export function studyCase(ctx: Ctx, s: Study): SimFiles {
  const report: StepReport = { warnings: [] };
  const topo = s.physics === "fem" ? femTopo(ctx, s, report) : undefined;
  const solid = topo ? topo.shape : bodyOf(ctx);
  const brep = oc().BRepToolsWrapper.Write(solid) as string;
  const files: Record<string, string | Uint8Array> = { "model.brep": brep };
  let c: SimCase;
  if (s.physics === "fem") {
    c = femCase(ctx, s, report, topo);
    files["mesh.geo"] = femGeo(c);
  } else {
    c = cfdCase(ctx, s, report);
    if (c.solver === "openfoam") Object.assign(files, openfoamCase(c, stlPatches(ctx, solid, c)));
    else { files["mesh.geo"] = su2Geo(c); files["case.cfg"] = su2Config(c); }
  }
  files["case.json"] = JSON.stringify(c, null, 1);
  files["LEIA-ME.txt"] = readme(c);
  return { case: c, files, warnings: report.warnings };
}

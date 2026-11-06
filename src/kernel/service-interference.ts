// Serviço do núcleo: deteção de interferências entre as peças da última montagem.
import type { InterferenceResponse } from "./protocol.ts";
import type { CadProject } from "../doc/project.ts";
import type { Vec3 } from "../doc/types.ts";
import { type PartBuild, solveAssembly } from "./assembly.ts";
import { meshBody } from "./mesh.ts";
import { nameFresh } from "./naming.ts";
import { Arena, T, bbox, explore, oc, setArena, volume } from "./occ.ts";

/** Deteção de interferências entre as peças da última montagem (volume comum > 0). */
export async function interference(
  lastAsm: { project: CadProject; id: string } | null, partBuild: (project: CadProject, key: string) => Promise<PartBuild>, restoreArena: () => void,
): Promise<InterferenceResponse> {
  if (!lastAsm) throw new Error("Não há montagem");
  const { project, id } = lastAsm;
  const builds = new Map<string, PartBuild>();
  const get = async (pid: string) => { let b = builds.get(pid); if (!b) { b = await partBuild(project, pid); builds.set(pid, b); } return b; };
  const asm = await solveAssembly(project, id, get);
  const arena = new Arena();
  setArena(arena);
  try {
    const o = oc();
    const placed = asm.instances.flatMap((i) => {
      const body = builds.get(i.part)?.ctx.body;
      if (!body) return [];
      const t = T(new o.gp_Trsf());
      const R = i.pose.R, p = i.pose.t;
      t.SetValues(R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2]);
      const shape = T(T(new o.BRepBuilderAPI_Transform(body.shape, t, true, false)).Shape());
      return [{ path: i.path.join("/"), name: i.names.join(" / "), shape, box: bbox(shape) }];
    });
    const pairs: InterferenceResponse["pairs"] = [];
    const overlap = (a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }) => [0, 1, 2].every((k) => a.min[k] < b.max[k] && b.min[k] < a.max[k]);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      const A = placed[i], B = placed[j];
      if (!overlap(A.box, B.box)) continue;
      const c = T(new o.BRepAlgoAPI_Common(A.shape, B.shape));
      c.Build();
      if (!c.IsDone()) continue;
      const common = T(c.Shape());
      const vol = explore(common, "solid").length ? volume(common).volume : 0;
      if (vol > 1e-6) pairs.push({ a: A.path, b: B.path, volume: vol, mesh: meshBody(nameFresh(common, "int")) });
    }
    return { pairs };
  } finally {
    arena.free();
    restoreArena();
  }
}

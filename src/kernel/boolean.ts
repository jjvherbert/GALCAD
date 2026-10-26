// Operações booleanas entre o corpo e um sólido-ferramenta, com transporte dos nomes.
import type { BodyOp } from "../doc/types.ts";
import type { Ctx } from "./context.ts";
import { type NamedBody, nameResult } from "./naming.ts";
import { T, explore, isType, makeCompound, oc, volume } from "./occ.ts";

const OP_LABEL: Record<BodyOp, string> = { add: "adicionar", cut: "cortar", intersect: "intersetar", new: "corpo novo" };

export function applyOp(ctx: Ctx, tool: NamedBody, op: BodyOp, fid: string): NamedBody {
  const body = ctx.body;
  if (!body || explore(body.shape, "solid").length === 0) {
    if (op === "cut" || op === "intersect") throw new Error(`Não há corpo para ${OP_LABEL[op]}`);
    return tool;
  }
  if (op === "new") {
    return { shape: makeCompound([body.shape, tool.shape]), faces: [...body.faces, ...tool.faces] };
  }
  const o = oc();
  const builder = T(
    op === "add" ? new o.BRepAlgoAPI_Fuse(body.shape, tool.shape)
    : op === "cut" ? new o.BRepAlgoAPI_Cut(body.shape, tool.shape)
    : new o.BRepAlgoAPI_Common(body.shape, tool.shape),
  );
  builder.Build();
  if (!builder.IsDone() || builder.HasErrors()) throw new Error(`A operação booleana (${OP_LABEL[op]}) falhou`);
  // une faces coplanares/cocilíndricas resultantes (topologia limpa); o histórico é mantido
  builder.SimplifyResult(true, true, 1e-3);
  const shape = T(builder.Shape());
  if (explore(shape, "solid").length === 0) {
    throw new Error(op === "cut" ? "O corte remove o corpo todo" : op === "intersect" ? "A interseção é vazia" : "O resultado é vazio");
  }
  return nameResult(builder, [...body.faces, ...tool.faces], shape, fid);
}

/** Verifica se a ferramenta intersecta o corpo (aviso para cortes que não removem material). */
export function cutHasEffect(before: NamedBody | null, after: NamedBody): boolean {
  if (!before) return true;
  return Math.abs(volume(before.shape).volume - volume(after.shape).volume) > 1e-9;
}

export const isSolidLike = (b: NamedBody) => isType(b.shape, "solid") || explore(b.shape, "solid").length > 0;

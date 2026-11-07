// Aplicar o valor de filete/deslocamento e gravar cotas editadas do editor de esboço 2D.
import { evalExpr } from "../doc/expr.ts";
import { type ChamferSpec, sketchChamfer } from "../sketch/chamfer.ts";
import { offset, sketchFillet } from "../sketch/modify.ts";
import type { SketchData } from "../sketch/ops.ts";

export type ChamferMode = ChamferSpec["mode"];
/** Pedido de valor: raio do filete, distância(s)/ângulo do chanfro ou distância do deslocamento. */
export type Prompt = { kind: "fillet" | "chamfer" | "offset"; at: [number, number]; text: string; target: string[]; mode?: ChamferMode; text2?: string; flip?: boolean };
/** Últimos valores usados, para pré-preencher o próximo pedido. */
export type LastValues = { fillet: string; chamfer: string; offset: string; chamfer2: string; chamferAng: string; chamferMode: ChamferMode };
export const LAST_DEFAULTS: LastValues = { fillet: "5", chamfer: "5", offset: "5", chamfer2: "5", chamferAng: "45", chamferMode: "equal" };

/** Especificação do chanfro a partir do pedido (o segundo valor é o ângulo ou a segunda distância). */
export function chamferSpecOf(p: Prompt, scope: (n: string) => number | undefined): ChamferSpec {
  const d = Math.abs(evalExpr(p.text, scope));
  if (p.mode === "angle") return { mode: "angle", d, angle: Math.abs(evalExpr(p.text2 ?? "45", scope)) };
  if (p.mode === "two") return { mode: "two", d1: d, d2: Math.abs(evalExpr(p.text2 ?? p.text, scope)) };
  return { mode: "equal", d };
}

/** Contexto dos comandos: estado do editor e as ações que usam. */
export type CmdCtx = {
  prompt: Prompt | null;
  dimEdit: { id: string; text: string } | null;
  draft: SketchData;
  scope: (n: string) => number | undefined;
  data: () => SketchData;
  commit: (next: SketchData, label: string, opts?: { drivenOnConflict?: string }) => boolean;
  lastValue: { current: LastValues };
  setMsg: (m: string | null) => void;
  setPrompt: (p: Prompt | null) => void;
  setSel: (s: string[]) => void;
  setDimEdit: (d: { id: string; text: string } | null) => void;
};

export function applyPromptIn(c: CmdCtx) {
  const { prompt, scope, data, commit, lastValue, setMsg, setPrompt, setSel } = c;
  if (!prompt) return;
  let v: number, spec: ChamferSpec | null = null;
  try {
    v = evalExpr(prompt.text, scope);
    if (prompt.kind === "chamfer") spec = chamferSpecOf(prompt, scope);
  } catch (e) { setMsg((e as Error).message); return; }
  lastValue.current[prompt.kind] = prompt.text;
  if (prompt.kind === "fillet") {
    const r = sketchFillet(data(), prompt.target[0], Math.abs(v));
    if (!r) { setMsg("Raio demasiado grande para as linhas do canto"); return; }
    if (commit(r, "Filete de canto")) setPrompt(null);
  } else if (spec) {
    lastValue.current.chamferMode = spec.mode;
    if (spec.mode === "angle") lastValue.current.chamferAng = prompt.text2 ?? "45";
    if (spec.mode === "two") lastValue.current.chamfer2 = prompt.text2 ?? prompt.text;
    const r = sketchChamfer(data(), prompt.target[0], spec, prompt.flip);
    if (!r) { setMsg(spec.mode === "angle" ? "O chanfro não cabe com esta distância e ângulo" : "Distância demasiado grande para as linhas do canto"); return; }
    if (commit(r, "Chanfro de canto")) setPrompt(null);
  } else {
    if (commit(offset(data(), prompt.target, v), "Deslocar")) { setPrompt(null); setSel([]); }
  }
}

export function saveDimIn(c: CmdCtx) {
  const { dimEdit, draft, scope, data, commit, setMsg, setDimEdit } = c;
  if (!dimEdit) return;
  const text = dimEdit.text.trim();
  try {
    const val = evalExpr(text, scope);
    if (!(val > 0) && !text.startsWith("-")) throw new Error("O valor tem de ser positivo");
    const num = Number(text.replace(",", "."));
    const value = Number.isFinite(num) && /^[-+]?[\d.,]+$/.test(text) ? num : text;
    const next = { ...data(), constraints: draft.constraints.map((c) => (c.id === dimEdit.id ? { ...c, value, driven: false } : c)) };
    if (commit(next, "Cota", { drivenOnConflict: dimEdit.id })) setDimEdit(null);
  } catch (e) {
    setMsg((e as Error).message);
  }
}

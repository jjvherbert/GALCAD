// Aplicar o valor de filete/deslocamento e gravar cotas editadas do editor de esboço 2D.
import { evalExpr } from "../doc/expr.ts";
import { offset, sketchFillet } from "../sketch/modify.ts";
import type { SketchData } from "../sketch/ops.ts";

type Prompt = { kind: "fillet" | "offset"; at: [number, number]; text: string; target: string[] };

/** Contexto dos comandos: estado do editor e as ações que usam. */
export type CmdCtx = {
  prompt: Prompt | null;
  dimEdit: { id: string; text: string } | null;
  draft: SketchData;
  scope: (n: string) => number | undefined;
  data: () => SketchData;
  commit: (next: SketchData, label: string, opts?: { drivenOnConflict?: string }) => boolean;
  lastValue: { current: { fillet: string; offset: string } };
  setMsg: (m: string | null) => void;
  setPrompt: (p: Prompt | null) => void;
  setSel: (s: string[]) => void;
  setDimEdit: (d: { id: string; text: string } | null) => void;
};

export function applyPromptIn(c: CmdCtx) {
  const { prompt, scope, data, commit, lastValue, setMsg, setPrompt, setSel } = c;
  if (!prompt) return;
  let v: number;
  try { v = evalExpr(prompt.text, scope); } catch (e) { setMsg((e as Error).message); return; }
  lastValue.current[prompt.kind] = prompt.text;
  if (prompt.kind === "fillet") {
    const r = sketchFillet(data(), prompt.target[0], Math.abs(v));
    if (!r) { setMsg("Raio demasiado grande para as linhas do canto"); return; }
    if (commit(r, "Filete de canto")) setPrompt(null);
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

// Pedido de valor do editor de esboço (filete/chanfro/deslocar) e opções do chanfro: modo, segundo valor, troca de lado e pré-visualização.
import type { P2 } from "../sketch/geometry.ts";
import { chamferGeometry } from "../sketch/chamfer.ts";
import type { SketchData } from "../sketch/ops.ts";
import { type ChamferMode, type LastValues, type Prompt, chamferSpecOf } from "./sketch-cmd.ts";

export const CHAMFER_MODES: [ChamferMode, string][] = [["equal", "Distância igual"], ["angle", "Distância + ângulo"], ["two", "Duas distâncias"]];

/** Muda o modo do chanfro; se houver um pedido de chanfro aberto, passa-o para o novo modo. */
export function withChamferMode(p: Prompt | null, mode: ChamferMode, lv: LastValues): Prompt | null {
  if (p?.kind !== "chamfer") return p;
  return { ...p, mode, text2: mode === "angle" ? lv.chamferAng : lv.chamfer2 };
}

export function ChamferModeSelect({ mode, onChange }: { mode: ChamferMode; onChange: (m: ChamferMode) => void }) {
  return (
    <select value={mode} onChange={(e) => onChange((e.target as HTMLSelectElement).value as ChamferMode)} title="Como definir o chanfro">
      {CHAMFER_MODES.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
    </select>
  );
}

const LABEL = { fillet: "Raio do filete", chamfer: "Distância do chanfro", offset: "Distância (negativa para o outro lado)" };

export function PromptBox({ prompt, setPrompt, apply }: { prompt: Prompt; setPrompt: (p: Prompt | null) => void; apply: () => void }) {
  const keys = (e: KeyboardEvent) => { if (e.key === "Enter") apply(); if (e.key === "Escape") setPrompt(null); };
  const two = prompt.kind === "chamfer" && (prompt.mode === "angle" || prompt.mode === "two");
  return (
    <div class="dim-input" style={{ left: `${prompt.at[0]}px`, top: `${prompt.at[1]}px` }}>
      <input autoFocus value={prompt.text} aria-label={prompt.kind === "chamfer" && two ? "Primeira distância do chanfro" : LABEL[prompt.kind]}
        onInput={(e) => setPrompt({ ...prompt, text: (e.target as HTMLInputElement).value })} onKeyDown={keys} />
      {two && (
        <input value={prompt.text2 ?? ""} aria-label={prompt.mode === "angle" ? "Ângulo do chanfro (°)" : "Segunda distância do chanfro"}
          title={prompt.mode === "angle" ? "Ângulo em graus, medido a partir da linha onde se mede a distância" : "Distância na outra linha"}
          onInput={(e) => setPrompt({ ...prompt, text2: (e.target as HTMLInputElement).value })} onKeyDown={keys} />
      )}
      {two && <button onClick={() => setPrompt({ ...prompt, flip: !prompt.flip })} title="Trocar de lado (a distância passa para a outra linha)">⇄</button>}
      <button onClick={apply} title="Aplicar">✓</button>
      <button onClick={() => setPrompt(null)} title="Fechar">✕</button>
    </div>
  );
}

/** Linha tracejada onde fica o chanfro com os valores atuais do pedido (nada se ainda não couber). */
export function ChamferPreview({ prompt, data, scope, S }: { prompt: Prompt | null; data: SketchData; scope: (n: string) => number | undefined; S: (p: P2) => P2 }) {
  if (prompt?.kind !== "chamfer") return null;
  let g: ReturnType<typeof chamferGeometry> = null;
  try { g = chamferGeometry(data, prompt.target[0], chamferSpecOf(prompt, scope), prompt.flip); } catch { return null; }
  if (!g) return null;
  const [a, b] = g.T.map((p) => S(p));
  return <line class="preview chamfer-preview" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
}

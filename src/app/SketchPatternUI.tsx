// Repetir no editor de esboço: abrir o pedido (linear ou circular) e os campos de modo, valor e sentido.
import { type CircularMode, type LastValues, type LinearMode, type Prompt, patternValueFor as valueFor } from "./sketch-cmd.ts";

export const LINEAR_MODES: [LinearMode, string][] = [["spacing", "Passo entre cópias"], ["total", "Comprimento total"]];
export const CIRCULAR_MODES: [CircularMode, string][] = [["full", "Volta completa (360°)"], ["total", "Ângulo total"], ["step", "Ângulo entre cópias"]];

export function PatternFields({ prompt, setPrompt, lv, keys }: { prompt: Prompt; setPrompt: (p: Prompt) => void; lv: LastValues; keys: (e: KeyboardEvent) => void }) {
  const lin = prompt.pkind === "linear";
  const modes: [string, string][] = lin ? LINEAR_MODES : CIRCULAR_MODES;
  const mode = prompt.pmode ?? modes[0][0];
  const label = lin ? (mode === "total" ? "Comprimento total" : "Passo entre cópias") : mode === "total" ? "Ângulo total (°)" : "Ângulo entre cópias (°)";
  const setMode = (m: string) => {
    const pmode = m as LinearMode | CircularMode;
    // ao mudar de modo mantém o valor escrito, exceto ao entrar/sair da volta completa
    const keep = prompt.text2 && mode !== "full" && pmode !== "full";
    setPrompt({ ...prompt, pmode, text2: keep ? prompt.text2 : valueFor(prompt.pkind, pmode, lv) });
  };
  return (
    <>
      <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value)} title={lin ? "Como definir a repetição linear" : "Como definir a repetição circular"}>
        {modes.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
      </select>
      {mode !== "full" && (
        <input value={prompt.text2 ?? ""} aria-label={label} title={label}
          onInput={(e) => setPrompt({ ...prompt, text2: (e.target as HTMLInputElement).value })} onKeyDown={keys} />
      )}
      {(lin || mode !== "full") && <button onClick={() => setPrompt({ ...prompt, flip: !prompt.flip })} title={lin ? "Trocar de sentido" : "Trocar de sentido (horário/anti-horário)"}>⇄</button>}
    </>
  );
}

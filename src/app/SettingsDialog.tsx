// Diálogo «Definições»: as alterações aplicam-se logo (e ficam guardadas no browser).
import { useEffect } from "preact/hooks";
import { store, useStore } from "./store.ts";
import { commandById } from "./commands.ts";
import { LIMITS, type GestureDir, type Settings } from "./settings.ts";

const THEMES: [Settings["theme"], string][] = [["light", "Claro"], ["dark", "Escuro"], ["system", "Sistema"]];
const STYLES: [Settings["displayStyle"], string][] = [["shadedEdges", "Sombreado com arestas"], ["shaded", "Sombreado"], ["wireframe", "Arestas (fio de arame)"]];
const GESTURES: [GestureDir, string][] = [
  ["up", "↑ Cima"], ["upRight", "↗ Cima-direita"], ["right", "→ Direita"], ["downRight", "↘ Baixo-direita"],
  ["down", "↓ Baixo"], ["downLeft", "↙ Baixo-esquerda"], ["left", "← Esquerda"], ["upLeft", "↖ Cima-esquerda"],
];
/** Comandos que fazem sentido num gesto: os de vista e «novo esboço». */
const GESTURE_COMMANDS = [...commandById.values()].filter((c) => c.group === "Vista" || c.id === "sketch.new");

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** Campo numérico que só grava ao confirmar (Enter/sair), cortado aos limites; texto inválido repõe o valor. */
function NumberField(p: { value: number; limits: readonly [number, number]; scale?: number; step?: number; label: string; onCommit: (v: number) => void }) {
  const k = p.scale ?? 1;
  return (
    <input type="number" aria-label={p.label} min={p.limits[0] / k} max={p.limits[1] / k} step={p.step ?? 1} value={Math.round((p.value / k) * 100) / 100}
      onChange={(e) => {
        const el = e.currentTarget as HTMLInputElement;
        const v = Number(el.value);
        if (el.value.trim() === "" || !Number.isFinite(v)) { el.value = String(p.value / k); return; }
        const c = clamp(v * k, p.limits);
        p.onCommit(c);
        el.value = String(Math.round((c / k) * 100) / 100);
      }} />
  );
}

export function SettingsDialog() {
  const st = useStore();
  const s = st.settings;
  const close = () => store.set({ showSettings: false });
  const set = (patch: Partial<Settings>) => store.updateSettings(patch);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); e.stopImmediatePropagation(); } };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div class="modal-back" onClick={close}>
      <div class="modal settings" role="dialog" aria-modal="true" aria-label="Definições" onClick={(e) => e.stopPropagation()}>
        <h2>Definições</h2>
        <p class="muted">As alterações aplicam-se de imediato e ficam guardadas neste browser.</p>

        <section>
          <h3>Aparência</h3>
          <div class="row">
            <span>Tema</span>
            <div class="seg" role="radiogroup" aria-label="Tema">
              {THEMES.map(([v, label]) => (
                <label key={v} class={s.theme === v ? "on" : ""}>
                  <input type="radio" name="theme" value={v} checked={s.theme === v} onChange={() => set({ theme: v })} />{label}
                </label>
              ))}
            </div>
          </div>
        </section>

        <section>
          <h3>Rato e vista</h3>
          <label class="row"><span>Inverter zoom da roda</span><input type="checkbox" checked={s.reverseWheel} onChange={(e) => set({ reverseWheel: (e.currentTarget as HTMLInputElement).checked })} /></label>
          <label class="row"><span>Passo das setas (°)</span><NumberField label="Passo das setas em graus" value={s.arrowStep} limits={LIMITS.arrowStep} onCommit={(v) => set({ arrowStep: v })} /></label>
          <label class="row"><span>Estilo de visualização</span>
            <select value={s.displayStyle} onChange={(e) => set({ displayStyle: (e.currentTarget as HTMLSelectElement).value as Settings["displayStyle"] })}>
              {STYLES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
          <label class="row"><span>Mostrar planos</span><input type="checkbox" checked={s.showPlanes} onChange={(e) => { set({ showPlanes: (e.currentTarget as HTMLInputElement).checked }); store.rebuild(0); }} /></label>
          <details>
            <summary>Gestos do rato (arrastar com o botão direito)</summary>
            {GESTURES.map(([d, label]) => (
              <label key={d} class="row"><span>{label}</span>
                <select value={s.gestures[d]} onChange={(e) => set({ gestures: { ...s.gestures, [d]: (e.currentTarget as HTMLSelectElement).value } })}>
                  {GESTURE_COMMANDS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
            ))}
          </details>
        </section>

        <section>
          <h3>Esboço</h3>
          <label class="row"><span>Quadrícula de fundo</span><input type="checkbox" checked={s.sketchGrid} onChange={(e) => set({ sketchGrid: (e.currentTarget as HTMLInputElement).checked })} /></label>
        </section>

        <section>
          <h3>Solvers</h3>
          <label class="row"><span>Endereço do agente</span>
            <input type="url" value={s.agentUrl} spellcheck={false} onChange={(e) => { const el = e.currentTarget as HTMLInputElement; store.setAgentUrl(el.value); el.value = store.state.settings.agentUrl; }} />
          </label>
          <label class="row"><span>Limite por tentativa de malha (s)</span><NumberField label="Limite da malha em segundos" value={s.meshTimeout} limits={LIMITS.meshTimeout} onCommit={(v) => set({ meshTimeout: v })} /></label>
          <label class="row"><span>Limite de cada solve (min)</span><NumberField label="Limite do solve em minutos" value={s.solveTimeout} limits={LIMITS.solveTimeout} scale={60} onCommit={(v) => set({ solveTimeout: v })} /></label>
          <label class="row"><span>Limite do núcleo geométrico (s)</span><NumberField label="Limite do núcleo em segundos" value={s.kernelTimeout} limits={LIMITS.kernelTimeout} onCommit={(v) => set({ kernelTimeout: v })} /></label>
          <p class="muted">O token do agente nunca é guardado; fica só em memória durante a sessão.</p>
        </section>

        <div class="actions"><span class="grow" /><button class="primary" onClick={close}>Fechar</button></div>
      </div>
    </div>
  );
}

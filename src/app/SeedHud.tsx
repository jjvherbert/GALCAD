// Painel flutuante da seed em edição no 3D: valor, distribuição e atalhos (+/−, Shift+roda, B).
import { store, useStoreKeys } from "./store.ts";
import { activeSeed, activeSeedIndex, cycleSeedBias, seedBiasName, stepSeed } from "./seed-actions.ts";

export function SeedHud() {
  const st = useStoreKeys("pickTarget", "doc", "simStudy", "liveMesh", "agent", "simBusy");
  const i = activeSeedIndex(), sd = activeSeed();
  if (i == null || !sd) return null;
  const value = typeof sd.value === "number" ? sd.value : String(sd.value);
  return (
    <div class="seed-hud" role="group" aria-label={`Seed ${i + 1}`}>
      <b>Seed {i + 1}</b>
      <span class="seed-hud-n">
        <button class="icon" aria-label="Menos" title="Menos (−, Shift+roda)" onClick={() => stepSeed(sd.mode === "count" ? -1 : 1)}>−</button>
        <span>{sd.mode === "count" ? `${value} elem.` : `${value} mm`}</span>
        <button class="icon" aria-label="Mais" title="Mais (+, Shift+roda)" onClick={() => stepSeed(sd.mode === "count" ? 1 : -1)}>+</button>
      </span>
      <button class="small" title="Mudar a distribuição (B)" onClick={cycleSeedBias}>{seedBiasName(sd)}</button>
      <span class="muted seed-hud-hint">{sd.edges.length} aresta(s) · clique nas arestas</span>
      <label class="seed-hud-live" title={st.agent.token ? "Volta a gerar a malha completa (Gmsh) após cada alteração" : "Precisa do agente local ligado"}>
        <input type="checkbox" checked={st.liveMesh} disabled={!st.agent.token} onChange={(e) => store.set({ liveMesh: e.currentTarget.checked })} />
        Malha ao vivo{st.liveMesh && st.simBusy === "mesh" ? " …" : ""}
      </label>
      <button class="small" onClick={() => store.set({ pickTarget: null })}>Concluir</button>
    </div>
  );
}

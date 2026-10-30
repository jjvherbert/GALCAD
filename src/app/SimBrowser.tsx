// Árvore do modelo de simulação (espaços FEM e CFD), ao estilo da Model Tree do Abaqus/CAE e do Model
// Info do Femap: estudos e, em cada um, as secções do modelo (estudo, material, cargas e apoios,
// contacto, malha, sondas, resolver, resultados) com um resumo e o estado. Clicar abre a secção no
// painel à direita; o 3D mostra o resultado do estudo escolhido.
import type { CfdStudy, FemLoad, FemStudy, Study } from "../doc/study.ts";
import { type SimSection, store, useStore } from "./store.ts";
import { CONDITION_COLORS, activeStudies, activeStudy, addStudy, deleteStudy } from "./sim-actions.ts";
import { runCommand } from "./commands.ts";

const LOAD_SHORT: Record<FemLoad["kind"], string> = {
  fixed: "Encastramento", displacement: "Deslocamento", force: "Força", pressure: "Pressão", gravity: "Gravidade",
  temperature: "Temperatura", convection: "Convecção", heatFlux: "Fluxo de calor",
};
const ANALYSIS: Record<FemStudy["analysis"], string> = { static: "Estática", modal: "Modal", buckling: "Encurvadura", dynamic: "Dinâmica", thermal: "Térmica" };
const SOLVER: Record<string, string> = { calculix: "CalculiX", code_aster: "code_aster", openradioss: "OpenRadioss", openfoam: "OpenFOAM", su2: "SU2" };

interface Node { section: SimSection; icon: string; label: string; detail: string; state?: "ok" | "warn" | "todo"; children?: { label: string; detail?: string; color?: number }[] }

function femNodes(s: FemStudy, asm: boolean, hasResult: boolean): Node[] {
  const loads = s.loads;
  const supports = loads.filter((l) => l.kind === "fixed" || l.kind === "displacement").length;
  const structural = s.analysis !== "thermal";
  const m = s.mesh;
  const seeds = m.seeds?.length ?? 0;
  return [
    { section: "study", icon: "⚙", label: "Estudo", detail: `${ANALYSIS[s.analysis]}${s.analysis === "dynamic" ? ` ${s.dynamic?.scheme === "explicit" ? "explícita" : "implícita"}` : ""} · ${SOLVER[s.solver ?? "calculix"]}`, state: "ok" },
    { section: "material", icon: "◧", label: "Material", detail: asm ? "por corpo" : s.material.name, state: "ok" },
    {
      section: "conditions", icon: "⤓", label: "Cargas e apoios", detail: `${loads.length} condição(ões)`,
      state: structural && !supports && s.analysis !== "modal" ? "warn" : loads.length ? "ok" : "todo",
      children: loads.map((l) => ({ label: LOAD_SHORT[l.kind], detail: "faces" in l ? `${l.faces.length} face(s)` : "", color: CONDITION_COLORS[l.kind] })),
    },
    ...(asm ? [{ section: "contact" as const, icon: "⧉", label: "Contacto", detail: ({ bonded: "colado", friction: `atrito μ = ${s.contact?.mu ?? 0.3}`, none: "sem ligação" } as Record<string, string>)[s.contact?.mode ?? "bonded"], state: "ok" as const }] : []),
    { section: "mesh", icon: "▦", label: "Malha", detail: `${m.element === "hex" ? "hexaedros" : "tetraedros"} ${m.order === 2 ? "quadráticos" : "lineares"} · ${m.size} mm${seeds ? ` · ${seeds} seed(s)` : ""}`, state: "ok" },
    { section: "probes", icon: "⌖", label: "Sondas", detail: `${s.probes?.length ?? 0}`, state: s.probes?.length ? "ok" : "todo" },
    { section: "run", icon: "▶", label: "Resolver", detail: "agente local", state: "todo" },
    { section: "results", icon: "◑", label: "Resultados", detail: hasResult ? "calculado" : "por calcular", state: hasResult ? "ok" : "todo" },
  ];
}

function cfdNodes(s: CfdStudy, hasResult: boolean): Node[] {
  return [
    { section: "study", icon: "⚙", label: "Estudo", detail: `${s.regime === "internal" ? "Interno" : "Externo"} · ${SOLVER[s.solver]} · ${s.turbulence === "laminar" ? "laminar" : s.turbulence}`, state: "ok" },
    {
      section: "conditions", icon: "⇉", label: "Fluido e fronteiras", detail: s.fluid.name, state: s.regime === "internal" && !(s.inlet?.faces.length && s.outlet?.faces.length) ? "warn" : "ok",
      children: s.regime === "internal" ? [{ label: "Entrada", detail: `${s.inlet?.faces.length ?? 0} face(s)`, color: CONDITION_COLORS.inlet }, { label: "Saída", detail: `${s.outlet?.faces.length ?? 0} face(s)`, color: CONDITION_COLORS.outlet }] : [],
    },
    { section: "mesh", icon: "▦", label: "Malha", detail: `${s.mesh.size} mm`, state: "ok" },
    { section: "run", icon: "▶", label: "Resolver", detail: `${s.iterations} iterações`, state: "todo" },
    { section: "results", icon: "◑", label: "Resultados", detail: hasResult ? "calculado" : "por calcular", state: hasResult ? "ok" : "todo" },
  ];
}

export function SimBrowser() {
  const st = useStore();
  const physics = st.workspace === "cfd" ? "cfd" : "fem";
  const asm = !!store.activeAssembly();
  const studies = activeStudies(physics);
  const cur: Study | undefined = activeStudy(physics);
  const docId = store.activeAssembly()?.id ?? st.doc.id;
  const nodesOf = (s: Study) => {
    const has = st.simResult?.studyId === s.id && st.simResult.doc === docId;
    return s.physics === "fem" ? femNodes(s, asm, has) : cfdNodes(s, has);
  };
  return (
    <div class="sim-browser" aria-label="Árvore do modelo de simulação">
      <div class="tree-head"><b>{physics === "fem" ? "Modelo FEM" : "Modelo CFD"}</b><span class="muted">{asm ? store.activeAssembly()!.name : st.doc.name}</span></div>
      {studies.map((s) => {
        const on = s.id === cur?.id;
        return (
          <div key={s.id} class={`sim-study ${on ? "on" : ""}`}>
            <div class="sim-study-head" onClick={() => store.set({ simStudy: s.id, simSection: on ? st.simSection : "study", simResult: on ? st.simResult : null })}>
              <span class="caret">{on ? "▾" : "▸"}</span>
              <b>{s.name}</b>
              <button class="icon" title="Apagar estudo" aria-label={`Apagar ${s.name}`} onClick={(e) => { e.stopPropagation(); if (confirm(`Apagar o estudo «${s.name}»?`)) deleteStudy(s.id); }}>✕</button>
            </div>
            {on && (
              <ul class="sim-nodes">
                {nodesOf(s).map((n) => (
                  <li key={n.section}>
                    <button class={`sim-node ${st.simSection === n.section ? "on" : ""} ${n.state ? `st-${n.state}` : ""}`} onClick={() => store.set({ simSection: n.section })}>
                      <span class="ic">{n.icon}</span><span class="lb">{n.label}</span><span class="dt">{n.detail}</span>
                      {n.state === "warn" && <span class="st" title="Falta informação">!</span>}
                    </button>
                    {n.children?.length ? (
                      <ul class="sim-leaves">{n.children.map((c, k) => <li key={k} onClick={() => store.set({ simSection: n.section })}><span>{c.color !== undefined && <i class="sw" style={{ background: `#${c.color.toString(16).padStart(6, "0")}` }} />}{c.label}</span><span class="dt">{c.detail}</span></li>)}</ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {!studies.length && <p class="field-hint">Sem estudos {physics === "fem" ? "FEM" : "CFD"}. Crie um no separador «Estudo» ou aqui:</p>}
      <div class="sim-new">
        {physics === "fem"
          ? <><button class="small" onClick={() => runCommand("sim.new.static")}>+ Estático</button><button class="small" onClick={() => runCommand("sim.new.modal")}>+ Modal</button><button class="small" onClick={() => runCommand("sim.new.dynamic")}>+ Dinâmico</button></>
          : <><button class="small" onClick={() => addStudy("cfd", { regime: "internal" } as never)}>+ Interno</button>{!asm && <button class="small" onClick={() => addStudy("cfd", { regime: "external" } as never)}>+ Externo</button>}</>}
      </div>
    </div>
  );
}

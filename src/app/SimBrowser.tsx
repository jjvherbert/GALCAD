// Árvore do modelo de simulação (espaços FEM e CFD), ao estilo da Model Tree do Abaqus/CAE e do Model
// Info do Femap: estudos e, em cada um, as secções do modelo (estudo, material, cargas e apoios,
// contacto, malha, sondas, resolver, resultados) com um resumo e o estado. Clicar abre a secção no
// painel à direita; o 3D mostra o resultado do estudo escolhido.
import type { CfdStudy, FemLoad, FemStudy, Study } from "../doc/study.ts";
import type { CadDocument } from "../doc/types.ts";
import { deletePartition, focusPartition, setPartitionSuppressed } from "./partition-actions.ts";
import { partitionLabel, partitionSummary } from "./partition-label.ts";
import { useState } from "preact/hooks";
import { type SimSection, store, useStoreKeys } from "./store.ts";
import { focusSelect } from "./forms-base.tsx";
import { CONDITION_COLORS, activeStudies, activeStudy, addStudy, deleteStudy, updateStudy } from "./sim-actions.ts";
import { runCommand } from "./commands.ts";
import { checkStudy, checkSummary } from "../sim/modelcheck.ts";
import { loadEdges, loadFaces } from "../doc/study.ts";
import { pl } from "../doc/plural.ts";
import { type StepInfo, type StepState } from "./workflow.ts";
import { activeStepStates } from "./workflow-actions.ts";

const BADGE: Record<StepState, string> = { "por fazer": "todo", "em curso": "doing", "concluído": "done", "desatualizado": "stale" };
const BADGE_MARK: Record<StepState, string> = { "por fazer": "", "em curso": "…", "concluído": "✓", "desatualizado": "↻" };

const LOAD_SHORT: Record<FemLoad["kind"], string> = {
  fixed: "Encastramento", displacement: "Deslocamento", symmetry: "Simetria", pointForce: "Força pontual", force: "Força", pressure: "Pressão", gravity: "Gravidade", spring: "Mola", mass: "Massa", coupling: "Acoplamento",
  temperature: "Temperatura", convection: "Convecção", heatFlux: "Fluxo de calor", thermalField: "Campo de temperatura",
};
const ANALYSIS: Record<FemStudy["analysis"], string> = { static: "Estática", modal: "Modal", buckling: "Encurvadura", dynamic: "Dinâmica", thermal: "Térmica" };
const SOLVER: Record<string, string> = { calculix: "CalculiX", code_aster: "code_aster", openradioss: "OpenRadioss", openfoam: "OpenFOAM", su2: "SU2" };

interface Leaf { label: string; detail?: string; color?: number; edges?: boolean; partition?: number; off?: boolean }
interface Node { section: SimSection; icon: string; label: string; detail: string; state?: "ok" | "warn" | "todo"; children?: Leaf[] }

function femNodes(s: FemStudy, asm: boolean, hasResult: boolean, doc: Pick<CadDocument, "features">): Node[] {
  const loads = s.loads;
  const supports = loads.filter((l) => l.kind === "fixed" || l.kind === "displacement").length;
  const structural = s.analysis !== "thermal";
  const m = s.mesh;
  const seeds = m.seeds?.length ?? 0;
  const parts = partitionSummary(m);
  return [
    { section: "study", icon: "⚙", label: "Estudo", detail: `${ANALYSIS[s.analysis]}${s.analysis === "dynamic" ? ` ${s.dynamic?.scheme === "explicit" ? "explícita" : "implícita"}` : ""} · ${SOLVER[s.solver ?? "calculix"]}`, state: "ok" },
    { section: "material", icon: "◧", label: "Material", detail: asm ? "por corpo" : s.material.name, state: "ok" },
    {
      section: "conditions", icon: "⤓", label: "Cargas e apoios", detail: pl(loads.length, "condição", "condições"),
      state: structural && !supports && s.analysis !== "modal" ? "warn" : loads.length ? "ok" : "todo",
      children: loads.map((l) => {
        const edges = loadEdges(s, l).length;
        return { label: LOAD_SHORT[l.kind], detail: edges ? pl(edges, "aresta", "arestas") : "faces" in l ? pl(loadFaces(s, l).length, "face", "faces") : "", color: CONDITION_COLORS[l.kind], edges: edges > 0 };
      }),
    },
    ...(asm ? [{ section: "contact" as const, icon: "⧉", label: "Contacto", detail: ({ bonded: "colado", friction: `atrito μ = ${s.contact?.mu ?? 0.3}`, none: "sem ligação" } as Record<string, string>)[s.contact?.mode ?? "bonded"], state: "ok" as const }] : []),
    { section: "mesh", icon: "▦", label: "Malha", detail: `${m.element === "hex" ? "hexaedros" : "tetraedros"} ${m.order === 2 ? "quadráticos" : "lineares"} · ${m.size} mm${seeds ? ` · ${pl(seeds, "seed", "seeds")}` : ""}${parts ? ` · ${parts}` : ""}`, state: "ok",
      children: (m.partitions ?? []).map((c, i) => ({ label: partitionLabel(c, doc), partition: i, off: !!c.suppressed, detail: c.suppressed ? "suprimida" : "" })),
    },
    convNode(s),
    { section: "probes", icon: "⌖", label: "Sondas", detail: `${s.probes?.length ?? 0}`, state: s.probes?.length ? "ok" : "todo" },
    checkNode(s, asm),
    { section: "run", icon: "▶", label: "Resolver", detail: "agente local", state: "todo" },
    { section: "results", icon: "◑", label: "Resultados", detail: hasResult ? "calculado" : "por calcular", state: hasResult ? "ok" : "todo" },
  ];
}

function convNode(s: Study): Node {
  const c = s.convergence, runs = s.convergenceRuns?.length ?? 0;
  const mode = c ? { three: "3 malhas", sweep: `±${c.levels} níveis`, auto: `GCI ≤ ${c.target} %` }[c.mode] : "";
  return { section: "convergence", icon: "⤳", label: "Convergência", detail: [c?.enabled ? `ligada · ${mode} · r ${c.ratio}` : runs ? "" : "desligada", runs ? pl(runs, "guardado", "guardados") : ""].filter(Boolean).join(" · "), state: runs ? "ok" : "todo" };
}

function checkNode(s: Study, asm: boolean): Node {
  const items = checkStudy(s, asm);
  return { section: "check", icon: "✔", label: "Verificação", detail: checkSummary(items), state: items.some((i) => i.level !== "info") ? "warn" : "ok" };
}

function cfdNodes(s: CfdStudy, hasResult: boolean): Node[] {
  return [
    { section: "study", icon: "⚙", label: "Estudo", detail: `${s.regime === "internal" ? "Interno" : "Externo"} · ${SOLVER[s.solver]} · ${s.turbulence === "laminar" ? "laminar" : s.turbulence}`, state: "ok" },
    {
      section: "conditions", icon: "⇉", label: "Fluido e fronteiras", detail: s.fluid.name, state: s.regime === "internal" && !(s.inlet?.faces.length && s.outlet?.faces.length) ? "warn" : "ok",
      children: s.regime === "internal" ? [{ label: "Entrada", detail: pl(s.inlet?.faces.length ?? 0, "face", "faces"), color: CONDITION_COLORS.inlet }, { label: "Saída", detail: pl(s.outlet?.faces.length ?? 0, "face", "faces"), color: CONDITION_COLORS.outlet }] : [],
    },
    { section: "mesh", icon: "▦", label: "Malha", detail: `${s.mesh.size} mm`, state: "ok" },
    convNode(s),
    checkNode(s, false),
    { section: "run", icon: "▶", label: "Resolver", detail: `${s.iterations} iterações`, state: "todo" },
    { section: "results", icon: "◑", label: "Resultados", detail: hasResult ? "calculado" : "por calcular", state: hasResult ? "ok" : "todo" },
  ];
}

/** Folha de uma partição (como uma feature na árvore do SolidWorks): clique leva à sua linha no editor,
 *  e os botões suprimem/retomam ou apagam sem abrir o painel (cada um com o seu passo de desfazer). */
function PartitionLeaf({ s, c }: { s: Study; c: Leaf }) {
  const i = c.partition!, n = i + 1;
  return (
    <li class={`pl${c.off ? " off" : ""}`} title="Clique: abrir esta partição no editor da malha" onClick={() => focusPartition(s, i)}>
      <span class="lb"><i class="pn">{n}</i>{c.label}</span><span class="dt">{c.detail}</span>
      <span class="acts">
        <button class="icon" title={c.off ? "Retomar (volta a cortar)" : "Suprimir (fica na lista mas não corta)"} aria-label={`${c.off ? "Retomar" : "Suprimir"} partição ${n}`} aria-pressed={c.off}
          onClick={(e) => { e.stopPropagation(); setPartitionSuppressed(s, i, !c.off); }}>{c.off ? "▶" : "⏸"}</button>
        <button class="icon" title="Apagar partição" aria-label={`Apagar partição ${n}`} onClick={(e) => { e.stopPropagation(); deletePartition(s, i); }}>✕</button>
      </span>
    </li>
  );
}

export function SimBrowser() {
  // `project`/`active`/`simStudy`: lidos por `activeAssembly`/`activeStudy`
  const st = useStoreKeys("workspace", "doc", "simResult", "simSection", "simStudy", "project", "active");
  const [renaming, setRenaming] = useState<string | null>(null);
  const physics = st.workspace === "cfd" ? "cfd" : "fem";
  const asm = !!store.activeAssembly();
  const studies = activeStudies(physics);
  const cur: Study | undefined = activeStudy(physics);
  const docId = store.activeAssembly()?.id ?? st.doc.id;
  const nodesOf = (s: Study) => {
    const has = st.simResult?.studyId === s.id && st.simResult.doc === docId;
    return s.physics === "fem" ? femNodes(s, asm, has, st.doc) : cfdNodes(s, has);
  };
  // estado dos passos do fluxo guiado (C1a), só no nó principal de cada passo
  const stepsOf = (s: Study): StepInfo[] => (s.physics === "fem" ? activeStepStates(s) : []);
  return (
    <div class="sim-browser" aria-label="Árvore do modelo de simulação">
      <div class="tree-head"><b>{physics === "fem" ? "Modelo FEM" : "Modelo CFD"}</b><span class="muted">{asm ? store.activeAssembly()!.name : st.doc.name}</span></div>
      {studies.map((s) => {
        const on = s.id === cur?.id;
        const steps = on ? stepsOf(s) : [];
        return (
          <div key={s.id} class={`sim-study ${on ? "on" : ""}`}>
            <div class="sim-study-head" onClick={() => store.set({ simStudy: s.id, simSection: on ? st.simSection : "study", simResult: on ? st.simResult : null })}>
              <span class="caret">{on ? "▾" : "▸"}</span>
              {renaming === s.id
                ? <input class="rename" ref={focusSelect} value={s.name} aria-label="Nome do estudo" onClick={(e) => e.stopPropagation()}
                    onInput={(e) => updateStudy(s.id, { name: (e.target as HTMLInputElement).value })}
                    onBlur={() => setRenaming(null)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" || e.key === "Escape") setRenaming(null); }} />
                : <b title="Duplo clique para renomear" onDblClick={(e) => { e.stopPropagation(); setRenaming(s.id); }}>{s.name}</b>}
              <button class="icon" title="Apagar estudo" aria-label={`Apagar ${s.name}`} onClick={(e) => { e.stopPropagation(); if (confirm(`Apagar o estudo «${s.name}»?`)) deleteStudy(s.id); }}>✕</button>
            </div>
            {on && (
              <ul class="sim-nodes">
                {nodesOf(s).map((n) => { const step = steps.find((i) => i.section === n.section); return (
                  <li key={n.section}>
                    <button class={`sim-node ${st.simSection === n.section ? "on" : ""} ${n.state ? `st-${n.state}` : ""}`} onClick={() => store.set({ simSection: n.section })}>
                      <span class="ic">{n.icon}</span><span class="lb">{n.label}</span><span class="dt">{n.detail}</span>
                      {step && <span class={`step-badge ${BADGE[step.state]}`} title={`${step.label}: ${step.state}${step.reason ? ` — ${step.reason}` : ""}`} aria-label={`${step.label}: ${step.state}`}>{BADGE_MARK[step.state]}</span>}
                      {n.state === "warn" && <span class="st" title="Falta informação">!</span>}
                    </button>
                    {n.children?.length ? (
                      <ul class="sim-leaves">{n.children.map((c, k) => c.partition != null ? <PartitionLeaf key={`p${k}`} s={s} c={c} /> : <li key={k} title={`Duplo clique: escolher as ${c.edges ? "arestas" : "faces"} desta condição`} onClick={() => store.set({ simSection: n.section })} onDblClick={() => store.set({ simSection: n.section, pickTarget: n.section === "conditions" ? (c.edges ? { field: `loadEdge${k}`, accept: ["edge"] } : { field: `load${k}`, accept: ["face"] }) : null })}><span>{c.color !== undefined && <i class="sw" style={{ background: `#${c.color.toString(16).padStart(6, "0")}` }} />}{c.label}</span><span class="dt">{c.detail}</span></li>)}</ul>
                    ) : null}
                  </li>
                ); })}
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

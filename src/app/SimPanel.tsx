// Painel de simulação da peça (pré-processador F1): estudos FEM (CalculiX) e CFD (OpenFOAM, SU2),
// condições nas faces pelo nome topológico, malha, exportação do caso e cálculo no agente local.
import { useState } from "preact/hooks";
import type { Expr } from "../doc/types.ts";
import { type CfdStudy, type FemLoad, type FemStudy, type Probe, type Study, SIM_FLUIDS, SIM_MATERIALS, newCfdStudy, newFemStudy } from "../doc/study.ts";
import { store, useStore } from "./store.ts";
import { Check, ExprInput, Field, RefList, Select } from "./forms.tsx";
import { type RunResult, agentStatus, exportStudyCase, resultView, runStudy } from "./sim-client.ts";
import { fieldRange, layerShown, toggleLayer } from "../sim/result.ts";

const LOAD_LABELS: Record<FemLoad["kind"], string> = {
  fixed: "Encastramento", displacement: "Deslocamento imposto", force: "Força total", pressure: "Pressão", gravity: "Gravidade",
  temperature: "Temperatura", convection: "Convecção", heatFlux: "Fluxo de calor",
};
const STRUCT: FemLoad["kind"][] = ["fixed", "displacement", "force", "pressure", "gravity"];
const THERM: FemLoad["kind"][] = ["temperature", "convection", "heatFlux"];

function newLoad(kind: FemLoad["kind"]): FemLoad {
  switch (kind) {
    case "fixed": return { kind, faces: [] };
    case "displacement": return { kind, faces: [], ux: 0 };
    case "force": return { kind, faces: [], f: [0, 0, -100] };
    case "pressure": return { kind, faces: [], p: 1 };
    case "gravity": return { kind, g: [0, 0, -9810] };
    case "temperature": return { kind, faces: [], t: 100 };
    case "convection": return { kind, faces: [], h: 10, tInf: 20 };
    case "heatFlux": return { kind, faces: [], q: 1000 };
  }
}

function Vec3Input({ label, unit, value, onChange }: { label: string; unit: string; value: [Expr, Expr, Expr]; onChange: (v: [Expr, Expr, Expr]) => void }) {
  return (
    <div class="row3">
      {[0, 1, 2].map((k) => <ExprInput key={k} label={`${label} ${"XYZ"[k]}`} unit={unit} value={value[k]} onChange={(x) => { const n = [...value] as [Expr, Expr, Expr]; n[k] = x ?? 0; onChange(n); }} />)}
    </div>
  );
}

export function SimPanel() {
  const st = useStore();
  // estudos da peça ativa ou, na montagem, da montagem (só FEM: vários corpos e contacto colado)
  const asm = store.activeAssembly() ?? null;
  const studies: Study[] = asm ? asm.studies ?? [] : st.doc.studies ?? [];
  const [sel, setSel] = useState<string>(studies[0]?.id ?? "");
  const s = studies.find((x) => x.id === sel) ?? studies[0];
  const save = (next: Study[], label = "Estudos") => (asm ? store.commitAssembly({ ...asm, studies: next as FemStudy[] }, label, true) : store.commitDoc("part", { ...st.doc, studies: next }, label, true));
  const up = (patch: Partial<Study>) => s && save(studies.map((x) => (x.id === s.id ? ({ ...x, ...patch } as Study) : x)));
  const add = (kind: "fem" | "cfd") => {
    const n = studies.reduce((m, x) => Math.max(m, Number(x.id.slice(1)) || 0), 0) + 1;
    const ns = kind === "fem" ? newFemStudy(`s${n}`, n) : newCfdStudy(`s${n}`, n);
    if (kind === "fem" && st.doc.properties?.material && !asm) {
      const m = SIM_MATERIALS.find((x) => x.name === st.doc.properties!.material);
      if (m) (ns as FemStudy).material = { ...m };
    }
    if (asm && ns.physics === "fem") ns.contact = { mode: "bonded" };
    save([...studies, ns], "Novo estudo");
    setSel(ns.id);
  };
  const docId = asm?.id ?? st.doc.id;
  return (
    <div class="knowledge-panel sim-panel">
      <div class="tree-head">
        <b>Simulação — {asm?.name ?? st.doc.name}</b>
        <button class="small" onClick={() => store.set({ sidePanel: null, simResult: null })}>← Árvore</button>
      </div>
      <div class="row">
        <select aria-label="Estudo" value={s?.id ?? ""} onChange={(e) => { setSel((e.target as HTMLSelectElement).value); store.set({ simResult: null }); }}>
          {studies.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.physics === "fem" ? "FEM" : "CFD"})</option>)}
          {!studies.length && <option value="">— sem estudos —</option>}
        </select>
        <button class="small" onClick={() => add("fem")}>+ FEM</button>
        {!asm && <button class="small" onClick={() => add("cfd")}>+ CFD</button>}
        {s && <button class="icon" aria-label="Apagar estudo" onClick={() => { save(studies.filter((x) => x.id !== s.id), "Apagar estudo"); setSel(""); }}>✕</button>}
      </div>
      {s && <Field label="Nome"><input value={s.name} onChange={(e) => up({ name: (e.target as HTMLInputElement).value })} /></Field>}
      {s?.physics === "fem" && <FemEditor s={s} up={up} assembly={!!asm} />}
      {s?.physics === "fem" && asm && <AssemblyBodies s={s} up={up} />}
      {s?.physics === "cfd" && <CfdEditor s={s} up={up} />}
      {s && <RunBox s={s} doc={docId} />}
      {!s && <p class="field-hint">{asm
        ? "Os estudos da montagem analisam vários corpos de uma vez: cada instância com o seu material e as faces planas coincidentes entre corpos coladas (contacto colado, *TIE no CalculiX). As faces das condições escolhem-se nos componentes."
        : "Os estudos preparam o modelo de análise dentro do CAD: condições ligadas às faces pelo nome topológico, malha e ficheiros dos solvers abertos (CalculiX para estruturas e térmica; OpenFOAM ou SU2 para escoamentos)."}</p>}
    </div>
  );
}

/** Ligação ao agente local (endereço, token, solvers encontrados): partilhada com o painel Cálculos. */
export function AgentBox() {
  const st = useStore();
  const a = st.agent;
  const [status, setStatus] = useState("");
  return (
    <details class="claude-box">
        <summary>Agente local {status && <span class="muted">· {status}</span>}</summary>
        <p class="field-hint">Corre na sua máquina com Node.js: <code>node cad-runner.mjs --serve</code>. Usa o Gmsh, o CalculiX, o code_aster, o OpenFOAM, o SU2 e o XFOIL instalados (processos separados) e mostra um token para colar aqui.</p>
        <Field label="Endereço"><input value={a.url} onChange={(e) => store.set({ agent: { ...a, url: (e.target as HTMLInputElement).value.replace(/\/$/, "") } })} /></Field>
        <Field label="Token"><input type="password" autocomplete="off" value={a.token} onInput={(e) => store.set({ agent: { ...a, token: (e.target as HTMLInputElement).value.trim() } })} /></Field>
        <button class="small" onClick={async () => { const x = await agentStatus(a.url, a.token); setStatus(x.ok ? Object.entries(x.tools ?? {}).map(([k, t]) => `${k} ${t ? "✓" : "✗"}`).join(" · ") : x.error ?? "erro"); }}>Testar ligação</button>
      </details>
  );
}

/** Montagem: material de cada corpo (instância) e modo de contacto entre corpos. */
function AssemblyBodies({ s, up }: { s: FemStudy; up: (p: Partial<FemStudy>) => void }) {
  const st = useStore();
  const inst = st.asmResult?.instances ?? [];
  const mats = s.bodyMaterials ?? {};
  return (
    <>
      <h3>Corpos e contacto</h3>
      <Select label="Contacto entre corpos" value={s.contact?.mode ?? "bonded"} options={[["bonded", "Colado nas faces planas coincidentes"], ["none", "Sem ligação (corpos independentes)"]]} onChange={(mode) => up({ contact: { ...s.contact, mode } })} />
      <table class="info-table">
        {inst.map((i) => (
          <tr key={i.path}>
            <td>{i.name}</td>
            <td>
              <select aria-label={`Material de ${i.name}`} value={mats[i.path]?.name ?? ""} onChange={(e) => {
                const m = SIM_MATERIALS.find((x) => x.name === (e.target as HTMLSelectElement).value);
                const next = { ...mats };
                if (m) next[i.path] = { ...m }; else delete next[i.path];
                up({ bodyMaterials: next });
              }}>
                <option value="">Material do estudo</option>
                {SIM_MATERIALS.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
              </select>
            </td>
          </tr>
        ))}
      </table>
      {!inst.length && <p class="muted">Sem instâncias resolvidas.</p>}
      <p class="field-hint">Faces curvas em contacto (pinos, veios) não são coladas automaticamente; o contacto com atrito/separação fica para uma etapa seguinte.</p>
    </>
  );
}

function FemEditor({ s, up, assembly }: { s: FemStudy; up: (p: Partial<FemStudy>) => void; assembly?: boolean }) {
  const thermal = s.analysis === "thermal";
  const kinds = thermal ? THERM : STRUCT;
  const setLoad = (i: number, l: FemLoad) => up({ loads: s.loads.map((x, k) => (k === i ? l : x)) });
  const m = s.material;
  return (
    <>
      <Select label="Solver" value={s.solver ?? "calculix"} options={[["calculix", "CalculiX"], ["code_aster", "code_aster (EDF)"]]} onChange={(solver) => up({ solver })} />
      <Select label="Análise" value={s.analysis} options={[["static", "Estática linear"], ["modal", "Modal (frequências próprias)"], ["buckling", "Encurvadura linear"], ["thermal", "Térmica (regime permanente)"]]}
        onChange={(analysis) => up({ analysis, loads: s.loads.filter((l) => (analysis === "thermal" ? THERM : STRUCT).includes(l.kind)) })} />
      {s.analysis === "static" && (
        <fieldset class="checklist">
          <legend class="field-label">Não linear</legend>
          <Check label="Grandes deslocamentos e rotações" value={!!s.nonlinear?.geometry} onChange={(geometry) => up({ nonlinear: { ...s.nonlinear, geometry } })} />
          <Check label="Plasticidade (von Mises, bilinear)" value={!!s.nonlinear?.plasticity} onChange={(plasticity) => up({ nonlinear: { ...s.nonlinear, plasticity } })} />
          {(s.nonlinear?.geometry || s.nonlinear?.plasticity) && <Field label="Incrementos de carga"><input type="number" min="1" max="200" value={s.nonlinear?.increments ?? 10} onChange={(e) => up({ nonlinear: { ...s.nonlinear, increments: Number((e.target as HTMLInputElement).value) || 10 } })} /></Field>}
        </fieldset>
      )}
      {(s.analysis === "modal" || s.analysis === "buckling") && <Field label="N.º de modos"><input type="number" min="1" max="50" value={s.modes ?? 6} onChange={(e) => up({ modes: Number((e.target as HTMLInputElement).value) || 6 })} /></Field>}
      <fieldset class="checklist">
        <legend class="field-label">Material</legend>
        <select aria-label="Material de referência" value={SIM_MATERIALS.some((x) => x.name === m.name) ? m.name : ""} onChange={(e) => { const x = SIM_MATERIALS.find((y) => y.name === (e.target as HTMLSelectElement).value); if (x) up({ material: { ...x } }); }}>
          <option value="">Personalizado</option>
          {SIM_MATERIALS.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
        <div class="row3">
          <Field label="E (MPa)"><input type="number" value={m.E} onChange={(e) => up({ material: { ...m, name: "Personalizado", E: Number((e.target as HTMLInputElement).value) } })} /></Field>
          <Field label="ν"><input type="number" step="0.01" value={m.nu} onChange={(e) => up({ material: { ...m, name: "Personalizado", nu: Number((e.target as HTMLInputElement).value) } })} /></Field>
          <Field label="ρ (g/cm³)"><input type="number" step="0.01" value={m.density} onChange={(e) => up({ material: { ...m, name: "Personalizado", density: Number((e.target as HTMLInputElement).value) } })} /></Field>
        </div>
        <div class="row3">
          <Field label="k (W/(m·K))"><input type="number" value={m.k ?? ""} onChange={(e) => up({ material: { ...m, k: Number((e.target as HTMLInputElement).value) } })} /></Field>
          <Field label="Cedência (MPa)"><input type="number" value={m.yield ?? ""} onChange={(e) => up({ material: { ...m, yield: Number((e.target as HTMLInputElement).value) } })} /></Field>
          <Field label="Et (MPa)"><input type="number" value={m.tangent ?? ""} onChange={(e) => up({ material: { ...m, tangent: Number((e.target as HTMLInputElement).value) } })} /></Field>
        </div>
        {s.nonlinear?.plasticity && <p class="field-hint">Et (módulo tangente depois da cedência) dos materiais de referência é indicativo (≈ E/100): use a curva do certificado do material quando a plasticidade decide.</p>}
        {m.source && <p class="muted">{m.source}</p>}
      </fieldset>
      <h3>Condições</h3>
      {s.loads.map((l, i) => (
        <div class="kw-item" key={i}>
          <div class="row"><b>{LOAD_LABELS[l.kind]}</b><button class="icon" aria-label={`Retirar condição ${i + 1}`} onClick={() => up({ loads: s.loads.filter((_, k) => k !== i) })}>✕</button></div>
          {"faces" in l && <RefList field={`load${i}`} label="Faces" accept={["face"]} refs={l.faces} onChange={(faces) => setLoad(i, { ...l, faces } as FemLoad)} />}
          {l.kind === "displacement" && <div class="row3">{(["ux", "uy", "uz"] as const).map((k) => <ExprInput key={k} label={k} allowEmpty value={l[k]} onChange={(x) => setLoad(i, { ...l, [k]: x })} />)}</div>}
          {l.kind === "force" && <Vec3Input label="F" unit="N" value={l.f} onChange={(f) => setLoad(i, { ...l, f })} />}
          {l.kind === "pressure" && <ExprInput label="Pressão (MPa)" unit="MPa" value={l.p} onChange={(p) => setLoad(i, { ...l, p: p ?? 0 })} />}
          {l.kind === "gravity" && <Vec3Input label="g" unit="mm/s²" value={l.g} onChange={(g) => setLoad(i, { ...l, g })} />}
          {l.kind === "temperature" && <ExprInput label="Temperatura" unit="°C" value={l.t} onChange={(t) => setLoad(i, { ...l, t: t ?? 0 })} />}
          {l.kind === "convection" && <div class="row"><ExprInput label="h" unit="W/(m²·K)" value={l.h} onChange={(h) => setLoad(i, { ...l, h: h ?? 0 })} /><ExprInput label="T fluido" unit="°C" value={l.tInf} onChange={(tInf) => setLoad(i, { ...l, tInf: tInf ?? 0 })} /></div>}
          {l.kind === "heatFlux" && <ExprInput label="Fluxo" unit="W/m²" value={l.q} onChange={(q) => setLoad(i, { ...l, q: q ?? 0 })} />}
        </div>
      ))}
      <select aria-label="Acrescentar condição" value="" onChange={(e) => { const k = (e.target as HTMLSelectElement).value as FemLoad["kind"]; if (k) up({ loads: [...s.loads, newLoad(k)] }); }}>
        <option value="">+ condição…</option>
        {kinds.map((k) => <option key={k} value={k}>{LOAD_LABELS[k]}</option>)}
      </select>
      <h3>Sondas</h3>
      {(s.probes ?? []).map((pr, i) => {
        const set = (p: Partial<Probe>) => up({ probes: (s.probes ?? []).map((x, k) => (k === i ? { ...x, ...p } : x)) });
        return (
          <div class="kw-item" key={i}>
            <div class="row">
              <input aria-label={`Nome da sonda ${i + 1}`} value={pr.name} onChange={(e) => set({ name: (e.target as HTMLInputElement).value })} />
              <button class="icon" aria-label={`Retirar sonda ${i + 1}`} onClick={() => up({ probes: (s.probes ?? []).filter((_, k) => k !== i) })}>✕</button>
            </div>
            <div class="row">
              <Select label="Grandeza" value={pr.quantity} options={[["u", "|u| (mm)"], ["ux", "ux"], ["uy", "uy"], ["uz", "uz"], ["vm", "von Mises (MPa)"], ["T", "Temperatura (°C)"]]} onChange={(quantity) => set({ quantity })} />
              <Select label="Onde" value={pr.at.kind} options={[["faces", "Média em faces"], ["point", "Ponto (nó mais próximo)"]]} onChange={(k) => set({ at: k === "faces" ? { kind: "faces", faces: [] } : { kind: "point", point: [0, 0, 0] } })} />
            </div>
            {pr.at.kind === "faces"
              ? <RefList field={`probe${i}`} label="Faces" accept={["face"]} refs={pr.at.faces} onChange={(faces) => set({ at: { kind: "faces", faces } })} />
              : <Vec3Input label="P" unit="mm" value={pr.at.point} onChange={(point) => set({ at: { kind: "point", point } })} />}
          </div>
        );
      })}
      <button class="small" onClick={() => up({ probes: [...(s.probes ?? []), { name: `Sonda ${(s.probes ?? []).length + 1}`, quantity: thermal ? "T" : "u", at: { kind: "faces", faces: [] } }] })}>+ sonda</button>
      <h3>Malha (Gmsh)</h3>
      <div class="row">
        <ExprInput label="Tamanho máx." value={s.mesh.size} onChange={(size) => up({ mesh: { ...s.mesh, size: size ?? 5 } })} />
        <Select label="Ordem" value={String(s.mesh.order) as "1" | "2"} options={[["2", "Quadráticos (C3D10)"], ["1", "Lineares (C3D4)"]]} onChange={(o) => up({ mesh: { ...s.mesh, order: Number(o) as 1 | 2 } })} />
      </div>
      {s.mesh.order === 1 && !thermal && <p class="field-hint">Tetraedros lineares são demasiado rígidos em flexão: use quadráticos para tensões e deslocamentos.</p>}
    </>
  );
}

function CfdEditor({ s, up }: { s: CfdStudy; up: (p: Partial<CfdStudy>) => void }) {
  return (
    <>
      <div class="row">
        <Select label="Solver" value={s.solver} options={[["openfoam", "OpenFOAM (simpleFoam + snappyHexMesh)"], ["su2", "SU2 (incompressível, malha Gmsh)"]]} onChange={(solver) => up({ solver })} />
        <Select label="Regime" value={s.regime} options={[["internal", "Interno (o corpo é o fluido)"], ["external", "Externo (o corpo é um obstáculo)"]]} onChange={(regime) => up({ regime })} />
      </div>
      <div class="row">
        <select aria-label="Fluido" value={SIM_FLUIDS.some((x) => x.name === s.fluid.name) ? s.fluid.name : ""} onChange={(e) => { const x = SIM_FLUIDS.find((y) => y.name === (e.target as HTMLSelectElement).value); if (x) up({ fluid: { ...x } }); }}>
          {SIM_FLUIDS.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
        <Select label="Turbulência" value={s.turbulence} options={[["laminar", "Laminar"], ["kOmegaSST", "RANS k-ω SST"], ["kEpsilon", "RANS k-ε"]]} onChange={(turbulence) => up({ turbulence })} />
      </div>
      {s.regime === "internal" ? (
        <>
          <RefList field="cfd.inlet" label="Entrada (velocidade imposta)" accept={["face"]} refs={s.inlet?.faces ?? []} onChange={(faces) => up({ inlet: { velocity: s.inlet?.velocity ?? [1, 0, 0], faces } })} />
          <Vec3Input label="U" unit="m/s" value={s.inlet?.velocity ?? [1, 0, 0]} onChange={(velocity) => up({ inlet: { faces: s.inlet?.faces ?? [], velocity } })} />
          <RefList field="cfd.outlet" label="Saída (pressão 0)" accept={["face"]} refs={s.outlet?.faces ?? []} onChange={(faces) => up({ outlet: { faces } })} />
          <p class="field-hint">As restantes faces são paredes sem escorregamento.</p>
        </>
      ) : (
        <>
          <Vec3Input label="U∞" unit="m/s" value={s.freestream?.velocity ?? [1, 0, 0]} onChange={(velocity) => up({ freestream: { ...s.freestream, velocity } })} />
          <div class="row3">
            {(["A montante", "A jusante", "Lados"] as const).map((l, k) => (
              <Field key={l} label={`${l} (× dim.)`}><input type="number" min="0.5" step="0.5" value={(s.freestream?.domain ?? [3, 6, 2])[k]} onChange={(e) => { const d = [...(s.freestream?.domain ?? [3, 6, 2])] as [number, number, number]; d[k] = Number((e.target as HTMLInputElement).value) || 1; up({ freestream: { velocity: s.freestream?.velocity ?? [1, 0, 0], domain: d } }); }} /></Field>
            ))}
          </div>
        </>
      )}
      <h3>Malha e cálculo</h3>
      <div class="row">
        <ExprInput label="Células de fundo" value={s.mesh.size} onChange={(size) => up({ mesh: { ...s.mesh, size: size ?? 5 } })} />
        <Field label="Iterações"><input type="number" min="10" value={s.iterations} onChange={(e) => up({ iterations: Number((e.target as HTMLInputElement).value) || 500 })} /></Field>
      </div>
      {s.solver === "openfoam" && (
        <div class="row3">
          <Field label="Nível mín."><input type="number" min="0" max="6" value={s.mesh.surfaceLevel?.[0] ?? 1} onChange={(e) => up({ mesh: { ...s.mesh, surfaceLevel: [Number((e.target as HTMLInputElement).value), s.mesh.surfaceLevel?.[1] ?? 2] } })} /></Field>
          <Field label="Nível máx."><input type="number" min="0" max="6" value={s.mesh.surfaceLevel?.[1] ?? 2} onChange={(e) => up({ mesh: { ...s.mesh, surfaceLevel: [s.mesh.surfaceLevel?.[0] ?? 1, Number((e.target as HTMLInputElement).value)] } })} /></Field>
          <Field label="Camadas"><input type="number" min="0" max="10" value={s.mesh.layers ?? 3} onChange={(e) => up({ mesh: { ...s.mesh, layers: Number((e.target as HTMLInputElement).value) } })} /></Field>
        </div>
      )}
    </>
  );
}

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(2)} %` : "—");
const num = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(3) : x.toPrecision(5)) : "—");
const BEHAVIOUR = { monotonic: "monotónica", oscillatory: "oscilatória", divergent: "divergente", converged: "convergida" } as const;

function RunBox({ s, doc }: { s: Study; doc: string }) {
  const st = useStore();
  const [busy, setBusy] = useState(false);
  const [conv, setConv] = useState(false);
  const [ratio, setRatio] = useState(1.5);
  const [auto, setAuto] = useState(false);
  const [target, setTarget] = useState(1);
  const [levels, setLevels] = useState(5);
  const [metric, setMetric] = useState("");
  const a = st.agent;
  const res = st.simResult?.studyId === s.id && st.simResult.doc === doc ? st.simResult : null;
  const run = async () => {
    setBusy(true);
    try {
      const { result } = await runStudy(s.id, a.url, a.token, conv ? { ratio, ...(auto ? { target: target / 100, maxLevels: levels, metric: metric || undefined } : {}) } : undefined);
      store.set({ simResult: { doc, studyId: s.id, result }, simView: { field: 0, disp: 0, scale: 0, hidden: [] }, message: `Calculado em ${result.seconds.toFixed(1)} s` });
    } catch (e) {
      store.set({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const r = res?.result;
  const view = resultView(r);
  const v = st.simView;
  return (
    <>
      <h3>Calcular</h3>
      <div class="row">
        <button class="small" onClick={() => void exportStudyCase(s.id)}>Exportar caso (.zip)</button>
        <a class="small button" href="cad-runner.mjs" download="cad-runner.mjs">Agente local (cad-runner.mjs)</a>
      </div>
      <AgentBox />
      <Check label="Estudo de convergência da malha (GCI)" value={conv} onChange={setConv} />
      {conv && (
        <fieldset class="checklist">
          <Select label="Modo" value={auto ? "auto" : "three"} options={[["three", "3 malhas: h, r·h, r²·h"], ["auto", "Automático: refinar até ao GCI alvo"]]} onChange={(m) => setAuto(m === "auto")} />
          <Field label="Razão r entre malhas"><input type="number" min="1.1" max="3" step="0.1" value={ratio} onChange={(e) => setRatio(Number((e.target as HTMLInputElement).value) || 1.5)} /></Field>
          {auto && (
            <>
              <div class="row">
                <Field label="GCI alvo (%)"><input type="number" min="0.05" max="50" step="0.1" value={target} onChange={(e) => setTarget(Number((e.target as HTMLInputElement).value) || 1)} /></Field>
                <Field label="Máx. malhas"><input type="number" min="3" max="8" value={levels} onChange={(e) => setLevels(Number((e.target as HTMLInputElement).value) || 5)} /></Field>
              </div>
              <Select label="Grandeza seguida" value={metric} options={[["", "Primeira sonda (ou deslocamento máx.)"], ...((s.physics === "fem" ? s.probes ?? [] : []).map((p, i): [string, string] => [`probe${i + 1}`, `Sonda: ${p.name}`])), ["umax", "Deslocamento máx."], ["f1", "Frequência 1"], ["tmax", "Temperatura máx."], ["dp", "Queda de pressão (CFD)"], ["drag", "Arrasto (CFD)"]]} onChange={setMetric} />
            </>
          )}
          <p class="field-hint">{auto ? "Refina a partir do tamanho pedido (h, h/r, h/r², …) até o GCI da grandeza ficar abaixo do alvo com convergência monotónica, ou até ao máximo de malhas." : "Corre também com malhas r·h e r²·h (mais grossas) e estima a incerteza da malha pedida."} Use sondas (valores em pontos ou médias em faces): os máximos junto a cantos vivos e apoios não convergem. Celik et al. 2008 / ASME V&V 20.</p>
        </fieldset>
      )}
      <button class="small primary" disabled={busy || !a.token} onClick={() => void run()}>{busy ? "A calcular…" : "Calcular no agente local"}</button>
      {r && (
        <div class="kw-item ok">
          <b>{r.solver}</b>
          <table class="info-table">{r.summary.map(([k, x]) => <tr key={k}><td>{k}</td><td>{x}</td></tr>)}</table>
          {r.warnings.map((w) => <p key={w} class="error-text">{w}</p>)}
          {view && (
            <>
              {view.fields.length > 0 && (
                <Select label="Campo" value={String(v.field)} options={view.fields.map((f, k) => [String(k), `${f.name} (${f.unit})`])} onChange={(x) => store.set({ simView: { ...v, field: Number(x) } })} />
              )}
              {view.modes.length > 0 && (
                <>
                  <Select label="Deformada" value={String(v.disp)} options={view.modes.map((d, k) => [String(k), d])} onChange={(x) => store.set({ simView: { ...v, disp: Number(x) } })} />
                  <Field label="Ampliação da deformada (0 = automática)"><input type="number" min="0" value={v.scale} onChange={(e) => store.set({ simView: { ...v, scale: Number((e.target as HTMLInputElement).value) || 0 } })} /></Field>
                </>
              )}
              {view.layers.length > 1 && (
                <fieldset class="checklist">
                  <legend class="field-label">Camadas</legend>
                  {view.layers.map((l) => <Check key={l.name} label={l.name} value={layerShown(l, v.hidden)} onChange={() => store.set({ simView: { ...v, hidden: toggleLayer(l, v.hidden) } })} />)}
                </fieldset>
              )}
              <SimLegend />
            </>
          )}
          {r.fem && r.fem.history.length > 1 && (
            <details class="history">
              <summary>Curva carga–deslocamento ({r.fem.history.length} incrementos)</summary>
              <table class="info-table">
                <tr><td>Carga</td><td>Desl. máx. (mm) · reação (N)</td></tr>
                {r.fem.history.map((h) => <tr key={h.time}><td>{(100 * h.time).toFixed(1)} %</td><td>{num(h.umax)} · {h.reaction ? num(Math.hypot(...h.reaction)) : "—"}</td></tr>)}
              </table>
            </details>
          )}
          {r.convergence && (
            <details open class="convergence">
              <summary>Convergência da malha (r = {r.convergence.ratio})</summary>
              <table class="info-table">
                <tr><td>Malhas</td><td>{r.convergence.meshes.map((m) => m.cells).join(" / ")} {r.physics === "fem" ? "elementos" : "células"}</td></tr>
                {r.convergence.rows.map((x) => (
                  <tr key={x.key}>
                    <td>{x.label}{x.unit && ` (${x.unit})`}</td>
                    <td>{x.values.map(num).join(" / ")} → <b>{num(x.gci.extrapolated)}</b> · GCI {pct(x.gci.gciFine)} · p = {num(x.gci.p)} · {BEHAVIOUR[x.gci.behaviour]}</td>
                  </tr>
                ))}
              </table>
              {r.convergence.auto && <ConvergencePlot auto={r.convergence.auto} ext={r.convergence.rows.find((x) => x.key === r.convergence!.auto!.metric)?.gci.extrapolated} label={r.convergence.rows.find((x) => x.key === r.convergence!.auto!.metric)?.label ?? r.convergence.auto.metric} />}
              <ul class="muted">{r.convergence.hypotheses.map((h) => <li key={h}>{h}</li>)}</ul>
            </details>
          )}
          <Check label="Mostrar resultados no 3D" value={!st.simHidden} onChange={(x) => store.set({ simHidden: !x })} />
          <details><summary>Hipóteses</summary><ul>{(r.hypotheses ?? r.fem?.hypotheses ?? []).map((h) => <li key={h}>{h}</li>)}</ul></details>
        </div>
      )}
      <p class="field-hint">Resultados de apoio à decisão de engenharia, com as hipóteses e limites indicados: não são certificação nem decisão de uma autoridade ou de um organismo notificado.</p>
    </>
  );
}

function SimLegend() {
  const st = useStore();
  const view = resultView(st.simResult?.result);
  const f = view?.fields[st.simView.field];
  const range = view ? fieldRange(view, st.simView.field, st.simView.hidden) : null;
  if (!f || !range) return null;
  const fmt = (x: number) => (Math.abs(x) >= 1000 || (Math.abs(x) < 0.01 && x !== 0) ? x.toExponential(2) : x.toFixed(3));
  return (
    <>
      <div class="legend sequential" />
      <div class="legend-labels"><span>{fmt(range[0])}</span><span>{f.unit}</span><span>{fmt(range[1])}</span></div>
    </>
  );
}

/** Refinamento automático: valor da grandeza por nível contra o tamanho de malha, com o extrapolado. */
function ConvergencePlot({ auto, ext, label }: { auto: NonNullable<NonNullable<RunResult["convergence"]>["auto"]>; ext?: number; label: string }) {
  const pts = auto.steps.filter((x) => Number.isFinite(x.value));
  if (!pts.length) return null;
  const W = 260, H = 120, P = 28;
  const hs = pts.map((x) => (1 / x.cells) ** (1 / 3));
  const vs = [...pts.map((x) => x.value), ...(ext !== undefined && Number.isFinite(ext) ? [ext] : [])];
  const h0 = 0, h1 = Math.max(...hs) * 1.05, v0 = Math.min(...vs), v1 = Math.max(...vs);
  const X = (h: number) => P + ((h - h0) / (h1 - h0 || 1)) * (W - P - 6), Y = (v: number) => H - 18 - ((v - v0) / (v1 - v0 || 1)) * (H - 30);
  return (
    <>
      <p class="muted">{auto.achieved ? "✓ convergido" : "✗ não convergido"}: {auto.stop} · {label}</p>
      <svg class="conv-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Convergência da malha">
        <line x1={P} y1={H - 18} x2={W - 4} y2={H - 18} class="axis" />
        <line x1={P} y1={6} x2={P} y2={H - 18} class="axis" />
        {ext !== undefined && Number.isFinite(ext) && <line x1={P} x2={W - 4} y1={Y(ext)} y2={Y(ext)} class="ext" />}
        <polyline points={pts.map((x, i) => `${X(hs[i])},${Y(x.value)}`).join(" ")} class="curve" />
        {pts.map((x, i) => <circle key={i} cx={X(hs[i])} cy={Y(x.value)} r="2.5" />)}
        <text x={P} y={H - 4}>0</text>
        <text x={W - 6} y={H - 4} text-anchor="end">h = (1/N)^⅓</text>
        <text x={P - 3} y={Y(v1) + 3} text-anchor="end">{num(v1)}</text>
        <text x={P - 3} y={Y(v0) + 3} text-anchor="end">{num(v0)}</text>
      </svg>
      <table class="info-table">
        <tr><td>Nível · tamanho</td><td>Elementos · valor · GCI</td></tr>
        {auto.steps.map((x) => <tr key={x.level}><td>{x.level} · {num(x.size)} mm</td><td>{x.cells} · {num(x.value)} · {x.gci !== undefined ? pct(x.gci) : "—"}</td></tr>)}
      </table>
    </>
  );
}

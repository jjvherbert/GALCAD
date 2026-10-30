// Painel de simulação da peça (pré-processador F1): estudos FEM (CalculiX) e CFD (OpenFOAM, SU2),
// condições nas faces pelo nome topológico, malha, exportação do caso e cálculo no agente local.
import { useState } from "preact/hooks";
import type { Expr } from "../doc/types.ts";
import { type CfdStudy, type FemDynamic, type FemLoad, type FemStudy, type MeshSeed, type Probe, type SimMesh, type Study, SIM_FLUIDS, SIM_MATERIALS, newCfdStudy, newFemStudy } from "../doc/study.ts";
import { desktopAgent, store, useStore } from "./store.ts";
import { Check, ExprInput, Field, RefList, Select, usePickTarget } from "./forms.tsx";
import { type RunResult, agentStatus, exportStudyCase, previewStudyMesh, resultView, runStudy } from "./sim-client.ts";
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

/** Escolher um ponto clicando numa face do modelo (o ponto da peça mais próximo do clique). */
function PointPick({ field, onPick }: { field: string; onPick: (p: [number, number, number]) => void }) {
  const st = useStore();
  const active = st.pickTarget?.field === field;
  usePickTarget(field, (p) => {
    if (p.kind !== "face" || !p.point) return;
    onPick(p.point.map((x) => Math.round(x * 100) / 100) as [number, number, number]);
    store.set({ pickTarget: null });
  });
  return <button class="small" onClick={() => store.set({ pickTarget: active ? null : { field, accept: ["face"] } })}>{active ? "Clique na peça…" : "Escolher ponto no 3D"}</button>;
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
  if (desktopAgent()) return (
    <details class="claude-box">
      <summary>Agente local <span class="muted">· embutido na app{status && ` · ${status}`}</span></summary>
      <p class="field-hint">Os solvers (CalculiX, Gmsh, XFOIL) vêm instalados com a GALCAD e correm na sua máquina como programas separados; não é preciso configurar nada.</p>
      <button class="small" onClick={async () => { const x = await agentStatus(a.url, a.token); setStatus(x.ok ? Object.entries(x.tools ?? {}).map(([k, t]) => `${k} ${t ? "✓" : "✗"}`).join(" · ") : x.error ?? "erro"); }}>Ver solvers</button>
    </details>
  );
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
      <Select label="Contacto entre corpos" value={s.contact?.mode ?? "bonded"} options={[["bonded", "Colado nas faces planas coincidentes"], ["friction", "Com atrito e separação (Coulomb)"], ["none", "Sem ligação (corpos independentes)"]]} onChange={(mode) => up({ contact: { ...s.contact, mode } })} />
      {s.contact?.mode === "friction" && (
        <Field label="Coeficiente de atrito μ" hint="Penalidade face a face no CalculiX, carga em incrementos; aço/aço seco ≈ 0,15–0,3">
          <input type="number" min="0" max="2" step="0.05" value={s.contact.mu ?? 0.3} onChange={(e) => up({ contact: { ...s.contact!, mu: Number((e.target as HTMLInputElement).value) } })} />
        </Field>
      )}
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
      <p class="field-hint">O contacto aplica-se às faces planas coincidentes entre corpos; faces curvas em contacto (pinos, veios) ainda não são tratadas. Com atrito, as reações por apoio mostram a força transmitida.</p>
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
      <Select label="Análise" value={s.analysis} options={[["static", "Estática linear"], ["modal", "Modal (frequências próprias)"], ["buckling", "Encurvadura linear"], ["dynamic", "Dinâmica transitória"], ["thermal", "Térmica (regime permanente)"]]}
        onChange={(analysis) => up({ analysis, loads: s.loads.filter((l) => (analysis === "thermal" ? THERM : STRUCT).includes(l.kind)) })} />
      {s.analysis === "static" && (
        <fieldset class="checklist">
          <legend class="field-label">Não linear</legend>
          <Check label="Grandes deslocamentos e rotações" value={!!s.nonlinear?.geometry} onChange={(geometry) => up({ nonlinear: { ...s.nonlinear, geometry } })} />
          <Check label="Plasticidade (von Mises, bilinear)" value={!!s.nonlinear?.plasticity} onChange={(plasticity) => up({ nonlinear: { ...s.nonlinear, plasticity } })} />
          {(s.nonlinear?.geometry || s.nonlinear?.plasticity) && <Field label="Incrementos de carga"><input type="number" min="1" max="200" value={s.nonlinear?.increments ?? 10} onChange={(e) => up({ nonlinear: { ...s.nonlinear, increments: Number((e.target as HTMLInputElement).value) || 10 } })} /></Field>}
        </fieldset>
      )}
      {s.analysis === "dynamic" && <DynamicEditor d={s.dynamic ?? { scheme: "implicit", duration: 0.01, load: "step" }} onChange={(dynamic) => up({ dynamic })} />}
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
              : <><Vec3Input label="P" unit="mm" value={pr.at.point} onChange={(point) => set({ at: { kind: "point", point } })} /><PointPick field={`probept${i}`} onPick={(point) => set({ at: { kind: "point", point } })} /></>}
          </div>
        );
      })}
      <button class="small" onClick={() => up({ probes: [...(s.probes ?? []), { name: `Sonda ${(s.probes ?? []).length + 1}`, quantity: thermal ? "T" : "u", at: { kind: "faces", faces: [] } }] })}>+ sonda</button>
      <MeshEditor mesh={s.mesh} thermal={thermal} onChange={(mesh) => up({ mesh })} />
    </>
  );
}

/** Dinâmica transitória: esquema, tempo, amplitude da carga e amortecimento de Rayleigh. */
function DynamicEditor({ d, onChange }: { d: FemDynamic; onChange: (d: FemDynamic) => void }) {
  const set = (p: Partial<FemDynamic>) => onChange({ ...d, ...p });
  const [zeta, setZeta] = useState(2);
  const [freq, setFreq] = useState(100);
  return (
    <fieldset class="checklist">
      <legend class="field-label">Dinâmica</legend>
      <div class="row">
        <Select label="Integração" value={d.scheme} options={[["implicit", "Implícita (Newmark/HHT)"], ["explicit", "Explícita (diferenças centrais)"]]} onChange={(scheme) => set({ scheme })} />
        <Select label="Carga no tempo" value={d.load} options={[["step", "Degrau"], ["ramp", "Rampa"], ["halfsine", "Meio seno (choque)"], ["sine", "Seno (harmónica)"]]} onChange={(load) => set({ load })} />
      </div>
      <div class="row">
        <ExprInput label="Duração" unit="s" value={d.duration} onChange={(duration) => set({ duration: duration ?? 0.01 })} />
        <ExprInput label="Passo" unit="s" allowEmpty value={d.dt} onChange={(dt) => set({ dt })} />
      </div>
      {d.load === "ramp" && <ExprInput label="Tempo de subida" unit="s" value={d.rise ?? d.duration} onChange={(rise) => set({ rise })} />}
      {(d.load === "halfsine" || d.load === "sine") && <ExprInput label={d.load === "halfsine" ? "Duração do choque" : "Período"} unit="s" value={d.period ?? ""} onChange={(period) => set({ period })} />}
      <div class="row">
        <ExprInput label="Rayleigh α (massa)" unit="1/s" allowEmpty value={d.alpha} onChange={(alpha) => set({ alpha })} />
        <ExprInput label="Rayleigh β (rigidez)" unit="s" allowEmpty value={d.beta} onChange={(beta) => set({ beta })} />
      </div>
      <div class="row">
        <Field label="ζ (%)"><input type="number" min="0" max="50" step="0.5" value={zeta} onChange={(e) => setZeta(Number((e.target as HTMLInputElement).value) || 0)} /></Field>
        <Field label="no modo de (Hz)"><input type="number" min="0" value={freq} onChange={(e) => setFreq(Number((e.target as HTMLInputElement).value) || 0)} /></Field>
        <button class="small" title="α = 2ζω (amortecimento proporcional à massa, exato nessa frequência)" onClick={() => set({ alpha: Number((2 * (zeta / 100) * 2 * Math.PI * freq).toPrecision(4)), beta: undefined })}>α de ζ</button>
      </div>
      <Field label="Instantes guardados"><input type="number" min="5" max="400" value={d.frames ?? 50} onChange={(e) => set({ frames: Number((e.target as HTMLInputElement).value) || 50 })} /></Field>
      <p class="field-hint">{d.scheme === "implicit"
        ? "Implícita: vibrações e choques lentos; passo por omissão duração/200 (≈ 20 passos por período do modo mais alto que interessa)."
        : "Explícita: impacto e ondas; passo em branco = o estável da malha (Courant), sem escalar massa. Use hexaedros lineares C3D8R; o custo cresce com elementos pequenos."} Corra primeiro a modal para conhecer f₁ e escolher a duração e o amortecimento.</p>
    </fieldset>
  );
}

/** Histórias no tempo da dinâmica (deslocamento máx. e sondas). */
function TimePlot({ h }: { h: NonNullable<NonNullable<RunResult["fem"]>["timeHistory"]> }) {
  const [k, setK] = useState(h.series.length > 1 ? 1 : 0);
  const s = h.series[Math.min(k, h.series.length - 1)];
  const pts = h.times.map((t, i) => [t, s.values[i]] as const).filter(([, v]) => Number.isFinite(v));
  if (!pts.length) return null;
  const W = 260, H = 120, P = 30;
  const t1 = Math.max(...pts.map((p) => p[0])) || 1, v0 = Math.min(0, ...pts.map((p) => p[1])), v1 = Math.max(0, ...pts.map((p) => p[1]));
  const X = (t: number) => P + (t / t1) * (W - P - 6), Y = (v: number) => H - 18 - ((v - v0) / (v1 - v0 || 1)) * (H - 30);
  return (
    <details open class="history">
      <summary>Resposta no tempo</summary>
      {h.series.length > 1 && <Select label="Série" value={String(k)} options={h.series.map((x, i) => [String(i), `${x.label} (${x.unit})`])} onChange={(x) => setK(Number(x))} />}
      <svg class="conv-plot time-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Resposta no tempo">
        <line x1={P} y1={Y(0)} x2={W - 4} y2={Y(0)} class="axis" />
        <line x1={P} y1={6} x2={P} y2={H - 18} class="axis" />
        <polyline points={pts.map(([t, v]) => `${X(t)},${Y(v)}`).join(" ")} class="curve" />
        <text x={P} y={H - 4}>0</text>
        <text x={W - 6} y={H - 4} text-anchor="end">{num(t1 * 1e3)} ms</text>
        <text x={P - 3} y={Y(v1) + 3} text-anchor="end">{num(v1)}</text>
        <text x={P - 3} y={Y(v0) + 3} text-anchor="end">{num(v0)}</text>
      </svg>
    </details>
  );
}

const SEED_AT: [NonNullable<MeshSeed["biasAt"]>, string][] = [["start", "No início da aresta"], ["end", "No fim da aresta"], ["ends", "Nas duas pontas"], ["center", "No meio"]];

/**
 * Malha manual ao estilo do Femap: tamanho global e local, tetraedros ou hexaedros (estruturados ou
 * por subdivisão), integração, seeds nas arestas (n.º ou tamanho, distribuição) e faces mapeadas.
 */
function MeshEditor({ mesh: m, thermal, onChange }: { mesh: SimMesh; thermal: boolean; onChange: (m: SimMesh) => void }) {
  const set = (p: Partial<SimMesh>) => onChange({ ...m, ...p });
  const hex = m.element === "hex";
  const seeds = m.seeds ?? [];
  const setSeed = (i: number, p: Partial<MeshSeed>) => set({ seeds: seeds.map((x, k) => (k === i ? { ...x, ...p } : x)) });
  return (
    <>
      <h3>Malha (Gmsh)</h3>
      <div class="row">
        <Select label="Elementos" value={m.element ?? "tet"} options={[["tet", "Tetraedros"], ["hex", "Hexaedros"]]} onChange={(element) => set({ element })} />
        <Select label="Ordem" value={String(m.order) as "1" | "2"} options={hex ? [["2", "Quadráticos (20 nós)"], ["1", "Lineares (8 nós)"]] : [["2", "Quadráticos (C3D10)"], ["1", "Lineares (C3D4)"]]} onChange={(o) => set({ order: Number(o) as 1 | 2 })} />
      </div>
      <div class="row">
        <ExprInput label="Tamanho máx." unit="mm" value={m.size} onChange={(size) => set({ size: size ?? 5 })} />
        <Field label="Curvatura (elem./volta)"><input type="number" min="0" max="60" value={m.curvature ?? 12} onChange={(e) => set({ curvature: Number((e.target as HTMLInputElement).value) || 0 })} /></Field>
      </div>
      {hex && (
        <div class="row">
          <Select label="Método" value={m.hexMethod ?? "auto"} options={[["auto", "Automático"], ["structured", "Estruturado (mapeado)"], ["subdivision", "Subdivisão (qualquer forma)"]]} onChange={(hexMethod) => set({ hexMethod })} />
          {!thermal && <Select label="Integração" value={m.integration ?? (m.order === 2 ? "reduced" : "incompatible")} options={m.order === 2 ? [["reduced", "Reduzida (C3D20R)"], ["full", "Completa (C3D20)"]] : [["incompatible", "Modos incompatíveis (C3D8I)"], ["full", "Completa (C3D8)"], ["reduced", "Reduzida (C3D8R)"]]} onChange={(integration) => set({ integration })} />}
        </div>
      )}
      {hex && <p class="field-hint">Estruturado: cada volume tem de ser um bloco (6 faces de 4 arestas) — divida a peça em blocos como no Femap/Abaqus. Subdivisão: qualquer forma, cada tetraedro passa a 4 hexaedros (qualidade inferior).{m.order === 1 && m.integration === "full" ? " C3D8 com integração completa bloqueia em flexão: prefira C3D8I." : ""}{m.order === 1 && m.integration === "reduced" ? " C3D8R precisa de várias camadas na espessura (modos de hourglass)." : ""}</p>}
      {!hex && m.order === 1 && !thermal && <p class="field-hint">Tetraedros lineares são demasiado rígidos em flexão: use quadráticos para tensões e deslocamentos.</p>}
      <fieldset class="checklist">
        <legend class="field-label">Seeds nas arestas</legend>
        {seeds.map((sd, i) => (
          <div class="kw-item" key={i}>
            <div class="row">
              <Select label="Por" value={sd.mode} options={[["count", "N.º de elementos"], ["size", "Tamanho (mm)"]]} onChange={(mode) => setSeed(i, { mode })} />
              <ExprInput label={sd.mode === "count" ? "Elementos" : "Tamanho"} value={sd.value} onChange={(value) => setSeed(i, { value: value ?? 1 })} />
              <button class="icon" aria-label={`Retirar seed ${i + 1}`} onClick={() => set({ seeds: seeds.filter((_, k) => k !== i) })}>✕</button>
            </div>
            <div class="row">
              <ExprInput label="Razão maior/menor" allowEmpty value={sd.bias} onChange={(bias) => setSeed(i, { bias })} />
              <Select label="Elementos pequenos" value={sd.biasAt ?? "start"} options={SEED_AT} onChange={(biasAt) => setSeed(i, { biasAt })} />
            </div>
            <RefList field={`seed${i}`} label="Arestas" accept={["edge", "face"]} refs={sd.edges} onChange={(edges) => setSeed(i, { edges })} />
          </div>
        ))}
        <button class="small" onClick={() => set({ seeds: [...seeds, { edges: [], mode: "count", value: 10 }] })}>+ seed</button>
        <p class="field-hint">Uma face escolhida conta como as suas arestas. Nas malhas mapeadas o n.º de elementos passa às arestas opostas; a distribuição também, no mesmo sentido. Confira o resultado na pré-visualização.</p>
      </fieldset>
      <RefList field="mesh.mapped" label="Faces mapeadas (4 arestas)" accept={["face"]} refs={m.mapped ?? []} onChange={(mapped) => set({ mapped })} />
      <fieldset class="checklist">
        <legend class="field-label">Refinamento local</legend>
        {(m.local ?? []).map((l, i) => (
          <div class="kw-item" key={i}>
            <div class="row">
              <ExprInput label="Tamanho" unit="mm" value={l.size} onChange={(size) => set({ local: (m.local ?? []).map((x, k) => (k === i ? { ...x, size: size ?? 1 } : x)) })} />
              <button class="icon" aria-label={`Retirar refinamento ${i + 1}`} onClick={() => set({ local: (m.local ?? []).filter((_, k) => k !== i) })}>✕</button>
            </div>
            <RefList field={`local${i}`} label="Faces" accept={["face"]} refs={l.faces} onChange={(faces) => set({ local: (m.local ?? []).map((x, k) => (k === i ? { ...x, faces } : x)) })} />
          </div>
        ))}
        <button class="small" onClick={() => set({ local: [...(m.local ?? []), { faces: [], size: 1 }] })}>+ refinamento</button>
      </fieldset>
    </>
  );
}

/** Relatório de qualidade da malha (pré-visualização): métricas, limites, histograma e piores elementos. */
function QualityReport({ q }: { q: NonNullable<RunResult["quality"]> }) {
  const lim = (l: { min?: number; max?: number }) => (l.min !== undefined ? `≥ ${l.min}` : `≤ ${l.max}`);
  const sj = q.metrics.find((x) => x.key === "sj");
  const peak = sj ? Math.max(...sj.hist.counts, 1) : 1;
  return (
    <details open class="quality">
      <summary>Qualidade da malha {q.ok ? "" : "— com elementos inválidos"}</summary>
      <table class="info-table">
        <tr><td>Métrica</td><td>mín. · média · máx. — fora dos limites</td></tr>
        {q.metrics.map((x) => (
          <tr key={x.key}>
            <td>{x.label}</td>
            <td>{x.min.toPrecision(3)} · {x.mean.toPrecision(3)} · {x.max.toPrecision(3)}{x.unit} — {x.limits.map((l, i) => <span key={i} class={x.fail[i] ? "error-text" : ""}>{lim(l)}: {x.fail[i]}{i < x.limits.length - 1 ? "; " : ""}</span>)}</td>
          </tr>
        ))}
      </table>
      {sj && (
        <div class="histogram" aria-label="Histograma do jacobiano escalado">
          {sj.hist.counts.map((n, i) => <div key={i} class="bar" title={`${sj.hist.edges[i].toFixed(2)}–${sj.hist.edges[i + 1].toFixed(2)}: ${n}`} style={{ height: `${(100 * n) / peak}%` }} />)}
        </div>
      )}
      {sj && <p class="muted">Jacobiano escalado de {sj.hist.edges[0].toFixed(1)} a 1 (1 = elemento perfeito)</p>}
      {q.worst.length > 0 && <p class="muted">Piores elementos: {q.worst.slice(0, 5).map((w) => `n.º ${w.element} (J = ${w.sj.toFixed(2)}, em ${w.center.map((v) => v.toFixed(1)).join(", ")} mm)`).join("; ")}</p>}
      <p class="field-hint">Limites por omissão: ângulos das faces, razão de aspeto e fator de forma como no Verify Mesh do Abaqus/CAE; jacobiano e empeno como no Femap. Elementos assinalados longe das zonas de interesse costumam ser aceitáveis.</p>
    </details>
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
  const [mode, setMode] = useState<"three" | "auto" | "sweep">("three");
  const auto = mode === "auto";
  const [target, setTarget] = useState(1);
  const [levels, setLevels] = useState(5);
  const [metric, setMetric] = useState("");
  const a = st.agent;
  const res = st.simResult?.studyId === s.id && st.simResult.doc === doc ? st.simResult : null;
  const run = async (meshOnly = false) => {
    setBusy(true);
    try {
      const { result } = meshOnly ? await previewStudyMesh(s.id, a.url, a.token) : await runStudy(s.id, a.url, a.token, conv ? { ratio, ...(auto ? { target: target / 100, maxLevels: levels, metric: metric || undefined } : mode === "sweep" ? { sweep: 3, metric: metric || undefined } : {}) } : undefined);
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
          <Select label="Modo" value={mode} options={[["three", "3 malhas: h, r·h, r²·h"], ["sweep", "±3 níveis: 7 malhas à volta de h"], ["auto", "Automático: refinar até ao GCI alvo"]]} onChange={(m) => { setMode(m); if (m === "sweep" && ratio > 1.4) setRatio(1.35); }} />
          <Field label="Razão r entre malhas"><input type="number" min="1.1" max="3" step="0.1" value={ratio} onChange={(e) => setRatio(Number((e.target as HTMLInputElement).value) || 1.5)} /></Field>
          {(auto || mode === "sweep") && (
            <>
              {auto && <div class="row">
                <Field label="GCI alvo (%)"><input type="number" min="0.05" max="50" step="0.1" value={target} onChange={(e) => setTarget(Number((e.target as HTMLInputElement).value) || 1)} /></Field>
                <Field label="Máx. malhas"><input type="number" min="3" max="8" value={levels} onChange={(e) => setLevels(Number((e.target as HTMLInputElement).value) || 5)} /></Field>
              </div>}
              <Select label="Grandeza seguida" value={metric} options={[["", "Primeira sonda (ou deslocamento máx.)"], ...((s.physics === "fem" ? s.probes ?? [] : []).map((p, i): [string, string] => [`probe${i + 1}`, `Sonda: ${p.name}`])), ["umax", "Deslocamento máx."], ["f1", "Frequência 1"], ["tmax", "Temperatura máx."], ["dp", "Queda de pressão (CFD)"], ["drag", "Arrasto (CFD)"]]} onChange={setMetric} />
            </>
          )}
          <p class="field-hint">{mode === "sweep" ? "Sete malhas h·r^k (k = 3 … −3): três mais grossas e três mais finas que a pedida, a grandeza seguida em cada uma, monotonia, extrapolação pelo trio mais fino e o erro estimado da malha pedida. Para um ponto da peça: crie uma sonda «Ponto» e escolha-o no 3D (r = 1,35 por omissão: a mais fina tem ~15× os elementos da pedida)." : auto ? "Refina a partir do tamanho pedido (h, h/r, h/r², …) até o GCI da grandeza ficar abaixo do alvo com convergência monotónica, ou até ao máximo de malhas." : "Corre também com malhas r·h e r²·h (mais grossas) e estima a incerteza da malha pedida."} Use sondas (valores em pontos ou médias em faces): os máximos junto a cantos vivos e apoios não convergem. Celik et al. 2008 / ASME V&V 20.</p>
        </fieldset>
      )}
      <div class="row">
        {s.physics === "fem" && <button class="small" disabled={busy || !a.token} onClick={() => void run(true)}>Pré-visualizar malha</button>}
        <button class="small primary" disabled={busy || !a.token} onClick={() => void run()}>{busy ? "A calcular…" : "Calcular no agente local"}</button>
      </div>
      {r && (
        <div class="kw-item ok">
          <b>{r.solver}</b>
          <table class="info-table">{r.summary.map(([k, x]) => <tr key={k}><td>{k}</td><td>{x}</td></tr>)}</table>
          {r.warnings.map((w) => <p key={w} class="error-text">{w}</p>)}
          {r.quality && <QualityReport q={r.quality} />}
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
          {r.fem?.timeHistory && <TimePlot h={r.fem.timeHistory} />}
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
              {r.convergence.sweep && <SweepPlot sw={r.convergence.sweep} ext={r.convergence.rows.find((x) => x.key === r.convergence!.sweep!.metric)?.gci.extrapolated} label={r.convergence.rows.find((x) => x.key === r.convergence!.sweep!.metric)?.label ?? r.convergence.sweep.metric} />}
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
/** Varrimento ±n níveis: valor por malha (h = (1/N)^⅓), extrapolado, monotonia e erro da malha pedida. */
function SweepPlot({ sw, ext, label }: { sw: NonNullable<NonNullable<RunResult["convergence"]>["sweep"]>; ext?: number; label: string }) {
  const pts = sw.steps.filter((x) => Number.isFinite(x.value));
  if (!pts.length) return null;
  const W = 260, H = 120, P = 28;
  const hs = pts.map((x) => (1 / x.cells) ** (1 / 3));
  const vs = [...pts.map((x) => x.value), ...(ext !== undefined && Number.isFinite(ext) ? [ext] : [])];
  const h1 = Math.max(...hs) * 1.05, v0 = Math.min(...vs), v1 = Math.max(...vs);
  const X = (h: number) => P + (h / (h1 || 1)) * (W - P - 6), Y = (v: number) => H - 18 - ((v - v0) / (v1 - v0 || 1)) * (H - 30);
  return (
    <>
      <p class="muted">{label}: {sw.monotonic ? "✓ monotónica" : "✗ não monotónica"}{sw.baseError !== undefined ? ` · erro estimado da malha pedida ${pct(sw.baseError)}` : ""}{sw.stop ? ` · ${sw.stop}` : ""}</p>
      <svg class="conv-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Varrimento da malha">
        <line x1={P} y1={H - 18} x2={W - 4} y2={H - 18} class="axis" />
        <line x1={P} y1={6} x2={P} y2={H - 18} class="axis" />
        {ext !== undefined && Number.isFinite(ext) && <line x1={P} x2={W - 4} y1={Y(ext)} y2={Y(ext)} class="ext" />}
        <polyline points={pts.map((x, i) => `${X(hs[i])},${Y(x.value)}`).join(" ")} class="curve" />
        {pts.map((x, i) => <circle key={i} cx={X(hs[i])} cy={Y(x.value)} r={x.level === 0 ? 4 : 2.5} class={x.level === 0 ? "base" : ""} />)}
        <text x={P} y={H - 4}>0</text>
        <text x={W - 6} y={H - 4} text-anchor="end">h = (1/N)^⅓</text>
        <text x={P - 3} y={Y(v1) + 3} text-anchor="end">{num(v1)}</text>
        <text x={P - 3} y={Y(v0) + 3} text-anchor="end">{num(v0)}</text>
      </svg>
      <table class="info-table sweep">
        <tr><td>Nível · tamanho</td><td>Elementos · valor</td></tr>
        {sw.steps.map((x) => <tr key={x.level} class={x.level === 0 ? "base" : ""}><td>{x.level > 0 ? `+${x.level}` : x.level}{x.level === 0 ? " (pedida)" : ""} · {num(x.size)} mm</td><td>{x.cells} · {num(x.value)}</td></tr>)}
      </table>
    </>
  );
}

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

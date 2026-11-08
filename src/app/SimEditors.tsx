// Editores de pré-processamento do painel de simulação: FEM (cargas, conjuntos, dinâmica, malha, montagem) e CFD.
import { useState } from "preact/hooks";
import type { Expr } from "../doc/types.ts";
import { type CfdStudy, type FemDynamic, type FemLoad, type FemSet, type FemStudy, type MeshSeed, type Probe, type SimMesh, SIM_FLUIDS, loadEdges, loadFaces, setKind } from "../doc/study.ts";
import { allMaterials } from "./material-library.ts";
import { type SimSection, store, useStoreKeys } from "./store.ts";
import { STRUCT_LOADS, THERMAL_LOADS, newLoad } from "./sim-actions.ts";
import { Check, ExprInput, Field, RefList, Select, usePickTarget } from "./forms.tsx";

const LOAD_LABELS: Record<FemLoad["kind"], string> = {
  fixed: "Encastramento", displacement: "Deslocamento imposto", symmetry: "Simetria (plano)", pointForce: "Força pontual", force: "Força total", pressure: "Pressão", gravity: "Gravidade",
  temperature: "Temperatura", convection: "Convecção", heatFlux: "Fluxo de calor",
};
const STRUCT = STRUCT_LOADS;
/** Condições que aceitam arestas (apoios e força total). */
const edgeLoad = (l: FemLoad): l is Extract<FemLoad, { kind: "fixed" | "displacement" | "force" }> => l.kind === "fixed" || l.kind === "displacement" || l.kind === "force";
const THERM = THERMAL_LOADS;

/** Escolher um ponto clicando numa face do modelo (o ponto da peça mais próximo do clique). */
function PointPick({ field, onPick }: { field: string; onPick: (p: [number, number, number]) => void }) {
  const st = useStoreKeys("pickTarget");
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

/** Montagem: material de cada corpo (instância) e modo de contacto entre corpos. */
export function AssemblyBodies({ s, up }: { s: FemStudy; up: (p: Partial<FemStudy>) => void }) {
  const st = useStoreKeys("asmResult", "userMaterials");
  const inst = st.asmResult?.instances ?? [];
  const lib = allMaterials(st.userMaterials);
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
                const m = lib.find((x) => x.name === (e.target as HTMLSelectElement).value);
                const next = { ...mats };
                if (m) next[i.path] = { ...m }; else delete next[i.path];
                up({ bodyMaterials: next });
              }}>
                <option value="">Material do estudo</option>
                {lib.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
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

export function FemEditor({ s, up, assembly, section }: { s: FemStudy; up: (p: Partial<FemStudy>) => void; assembly?: boolean; section: SimSection }) {
  const st = useStoreKeys("simFocus", "userMaterials");
  const lib = allMaterials(st.userMaterials);
  const thermal = s.analysis === "thermal";
  const kinds = thermal ? THERM : STRUCT;
  const setLoad = (i: number, l: FemLoad) => up({ loads: s.loads.map((x, k) => (k === i ? l : x)) });
  const m = s.material;
  const curve = m.plasticCurve?.length ? m.plasticCurve : undefined;
  return (
    <>
      {section === "study" && <>
      <Select label="Solver" value={s.solver ?? "calculix"} options={[["calculix", "CalculiX"], ["code_aster", "code_aster (EDF)"], ["openradioss", "OpenRadioss (explícito, impacto)"]]}
        onChange={(solver) => up(solver === "openradioss"
          ? { solver, analysis: "dynamic", dynamic: { ...(s.dynamic ?? { duration: 0.001, load: "step" }), scheme: "explicit" }, mesh: { ...s.mesh, order: 1, element: s.mesh.element ?? "hex", integration: "reduced" } }
          : { solver })} />
      {s.solver === "openradioss" && <p class="field-hint">OpenRadioss (OpenCourant, AGPL-3.0): explícito de impacto e choque; hexaedros de 8 nós com estabilização física do hourglass (Isolid 24) ou tetraedros de 4 nós; o passo é o estável do Engine.</p>}
      <Select label="Análise" value={s.analysis} options={[["static", "Estática linear"], ["modal", "Modal (frequências próprias)"], ["buckling", "Encurvadura linear"], ["dynamic", "Dinâmica transitória"], ["thermal", "Térmica (regime permanente)"]]}
        onChange={(analysis) => up({ analysis, loads: s.loads.filter((l) => (analysis === "thermal" ? THERM : STRUCT).includes(l.kind)) })} />
      {s.analysis === "static" && (
        <fieldset class="checklist">
          <legend class="field-label">Não linear</legend>
          <Check label="Grandes deslocamentos e rotações" value={!!s.nonlinear?.geometry} onChange={(geometry) => up({ nonlinear: { ...s.nonlinear, geometry } })} />
          <Check label="Plasticidade (von Mises)" value={!!s.nonlinear?.plasticity} onChange={(plasticity) => up({ nonlinear: { ...s.nonlinear, plasticity } })} />
          {(s.nonlinear?.geometry || s.nonlinear?.plasticity) && <Field label="Incrementos de carga"><input type="number" min="1" max="200" value={s.nonlinear?.increments ?? 10} onChange={(e) => up({ nonlinear: { ...s.nonlinear, increments: Number((e.target as HTMLInputElement).value) || 10 } })} /></Field>}
        </fieldset>
      )}
      {s.analysis === "dynamic" && <DynamicEditor d={s.dynamic ?? { scheme: "implicit", duration: 0.01, load: "step" }} onChange={(dynamic) => up({ dynamic })} />}
      {(s.analysis === "modal" || s.analysis === "buckling") && <Field label="N.º de modos"><input type="number" min="1" max="50" value={s.modes ?? 6} onChange={(e) => up({ modes: Number((e.target as HTMLInputElement).value) || 6 })} /></Field>}
      </>}
      {section === "material" && <fieldset class="checklist">
        <legend class="field-label">Material</legend>
        <div class="mat-select">
          <select aria-label="Material da biblioteca" value={lib.some((x) => x.name === m.name) ? m.name : ""} onChange={(e) => { const x = lib.find((y) => y.name === (e.target as HTMLSelectElement).value); if (x) up({ material: { ...x } }); }}>
            <option value="">Personalizado</option>
            {lib.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </select>
          <button class="small" title="Gerir os seus materiais" onClick={() => store.set({ showMaterials: true })}>Materiais…</button>
        </div>
        <div class="row3">
          <Field label="E (MPa)"><input type="number" value={m.E} onChange={(e) => up({ material: { ...m, name: "Personalizado", E: Number((e.target as HTMLInputElement).value) } })} /></Field>
          <Field label="ν"><input type="number" step="0.01" value={m.nu} onChange={(e) => up({ material: { ...m, name: "Personalizado", nu: Number((e.target as HTMLInputElement).value) } })} /></Field>
          <Field label="ρ (g/cm³)"><input type="number" step="0.01" value={m.density} onChange={(e) => up({ material: { ...m, name: "Personalizado", density: Number((e.target as HTMLInputElement).value) } })} /></Field>
        </div>
        <div class="row3">
          <Field label="k (W/(m·K))"><input type="number" value={m.k ?? ""} onChange={(e) => up({ material: { ...m, k: Number((e.target as HTMLInputElement).value) } })} /></Field>
          <Field label="Cedência (MPa)"><input type="number" value={m.yield ?? ""} readOnly={!!curve} title={curve ? "Primeiro ponto da curva plástica: altere em «Materiais…»" : undefined} onChange={(e) => up({ material: { ...m, yield: Number((e.target as HTMLInputElement).value) } })} /></Field>
          {curve
            ? <Field label="Endurecimento"><input value={`curva ${curve.length} pts`} readOnly title="Curva σ–εp do material: altere em «Materiais…»" /></Field>
            : <Field label="Et (MPa)"><input type="number" value={m.tangent ?? ""} onChange={(e) => up({ material: { ...m, tangent: Number((e.target as HTMLInputElement).value) } })} /></Field>}
        </div>
        {s.nonlinear?.plasticity && (curve
          ? <p class="field-hint">Plasticidade multilinear: curva σ–εp com {curve.length} pontos, de {curve[0][0]} a {curve[curve.length - 1][0]} MPa, e plástico perfeito depois do último ponto. A curva e a cedência editam-se em «Materiais…».</p>
          : <p class="field-hint">Et (módulo tangente depois da cedência) dos materiais de referência é indicativo (≈ E/100): use a curva do certificado do material quando a plasticidade decide (em «Materiais…», curva plástica).</p>)}
        {m.source && <p class="muted">{m.source}</p>}
      </fieldset>}
      {section === "conditions" && <>
      <SetsBox s={s} up={up} assembly={!!assembly} />
      {s.loads.map((l, i) => (
        <div class={`kw-item ${st.simFocus?.index === i ? "focus" : ""}`} key={`${i}:${st.simFocus?.index === i ? st.simFocus.n : 0}`} ref={(el) => { if (el && st.simFocus?.index === i) el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }}>
          <div class="row"><b>{LOAD_LABELS[l.kind]}</b><button class="icon" aria-label={`Retirar condição ${i + 1}`} onClick={() => up({ loads: s.loads.filter((_, k) => k !== i) })}>✕</button></div>
          {"faces" in l && <RefList field={`load${i}`} label="Faces" accept={["face"]} refs={l.faces} onChange={(faces) => setLoad(i, { ...l, faces } as FemLoad)} />}
          {edgeLoad(l) && <>
            <RefList field={`loadEdge${i}`} label="Arestas" accept={["edge"]} refs={l.edges ?? []} onChange={(edges) => setLoad(i, { ...l, edges: edges.length ? edges : undefined })} />
            {loadEdges(s, l).length > 0 && <p class="field-hint">{loadFaces(s, l).length ? "Escolha faces ou arestas, não as duas: retire as faces (ou as arestas) desta condição." : l.kind === "force" ? "Força total repartida pelo comprimento das arestas (CalculiX e code_aster)." : "Apoio nas linhas da malha das arestas (CalculiX e code_aster): concentra tensões junto à aresta."}</p>}
          </>}
          {"faces" in l && (() => {
            const usable = (s.sets ?? []).filter((g) => setKind(g) === "face" || (setKind(g) === "edge" && edgeLoad(l)));
            return usable.length > 0 && (
              <div class="set-chips" aria-label="Conjuntos desta condição">
                {usable.map((g) => {
                  const on = !!l.sets?.includes(g.id);
                  const n = setKind(g) === "edge" ? `${g.edges?.length ?? 0} aresta(s)` : `${g.faces.length} face(s)`;
                  return <button key={g.id} class={`chip ${on ? "on" : ""}`} aria-pressed={on} title={n} onClick={() => setLoad(i, { ...l, sets: on ? (l.sets ?? []).filter((x) => x !== g.id) : [...(l.sets ?? []), g.id] } as FemLoad)}>{on ? "✓ " : "+ "}{g.name}</button>;
                })}
              </div>
            );
          })()}
          {"faces" in l && l.faces.length > 0 && <button class="small" title="Guarda as faces desta condição como conjunto para as reutilizar" onClick={() => { const id = nextSetId(s); up({ sets: [...(s.sets ?? []), { id, name: `${LOAD_LABELS[l.kind]} ${(s.sets?.length ?? 0) + 1}`, faces: l.faces }], loads: s.loads.map((x, k) => (k === i && "faces" in x ? { ...x, faces: [], sets: [...(x.sets ?? []), id] } as FemLoad : x)) }); }}>→ guardar faces como conjunto</button>}
          {edgeLoad(l) && (l.edges?.length ?? 0) > 0 && <button class="small" title="Guarda as arestas desta condição como conjunto para as reutilizar" onClick={() => { const id = nextSetId(s); up({ sets: [...(s.sets ?? []), { id, name: `${LOAD_LABELS[l.kind]} ${(s.sets?.length ?? 0) + 1} (arestas)`, kind: "edge", faces: [], edges: l.edges }], loads: s.loads.map((x, k) => (k === i && edgeLoad(x) ? { ...x, edges: undefined, sets: [...(x.sets ?? []), id] } as FemLoad : x)) }); }}>→ guardar arestas como conjunto</button>}
          {l.kind === "displacement" && <div class="row3">{(["ux", "uy", "uz"] as const).map((k) => <ExprInput key={k} label={k} allowEmpty value={l[k]} onChange={(x) => setLoad(i, { ...l, [k]: x })} />)}</div>}
          {l.kind === "force" && <Vec3Input label="F" unit="N" value={l.f} onChange={(f) => setLoad(i, { ...l, f })} />}
          {l.kind === "pointForce" && (
            <>
              <Vec3Input label="Ponto" unit="mm" value={l.point} onChange={(point) => setLoad(i, { ...l, point })} />
              <PointPick field={`loadpt${i}`} onPick={(point) => setLoad(i, { ...l, point })} />
              <Vec3Input label="F" unit="N" value={l.f} onChange={(f) => setLoad(i, { ...l, f })} />
              <p class="field-hint">Aplicada no nó da malha mais próximo: dá tensões locais irreais junto ao ponto (singularidade); a resposta global (flechas longe do ponto, reações) é válida.</p>
            </>
          )}
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
      </>}
      {section === "probes" && <>
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
      </>}
      {section === "mesh" && <MeshEditor mesh={s.mesh} thermal={thermal} onChange={(mesh) => up({ mesh })} />}
    </>
  );
}

const nextSetId = (s: FemStudy) => `g${(s.sets ?? []).reduce((m, g) => Math.max(m, Number(g.id.slice(1)) || 0), 0) + 1}`;

/**
 * Conjuntos nomeados (como os sets do Abaqus): faces ou arestas que se usam em várias condições, e
 * nas montagens conjuntos de corpos com um material comum.
 */
function SetsBox({ s, up, assembly }: { s: FemStudy; up: (p: Partial<FemStudy>) => void; assembly: boolean }) {
  const st = useStoreKeys("asmResult", "userMaterials");
  const sets = s.sets ?? [];
  const inst = st.asmResult?.instances ?? [];
  const lib = allMaterials(st.userMaterials);
  const setSet = (i: number, patch: Partial<FemSet>) => up({ sets: sets.map((g, k) => (k === i ? { ...g, ...patch } : g)) });
  const remove = (i: number) => up({ sets: sets.filter((_, k) => k !== i), loads: s.loads.map((l) => ("faces" in l && l.sets?.includes(sets[i].id) ? { ...l, sets: l.sets.filter((x) => x !== sets[i].id) } as FemLoad : l)) });
  const add = (kind: "face" | "edge" | "body") => {
    const id = nextSetId(s);
    const label = kind === "edge" ? "Arestas" : kind === "body" ? "Corpos" : "Conjunto";
    up({ sets: [...sets, { id, name: `${label} ${sets.length + 1}`, ...(kind === "face" ? {} : { kind }), faces: [], ...(kind === "edge" ? { edges: [] } : kind === "body" ? { bodies: [] } : {}) }] });
    if (kind !== "body") store.set({ pickTarget: { field: `set${sets.length}`, accept: [kind] } });
  };
  return (
    <details class="sets-box" open={sets.length > 0}>
      <summary>Conjuntos ({sets.length})</summary>
      {sets.map((g, i) => {
        const kind = setKind(g);
        return (
          <div class="kw-item" key={g.id}>
            <div class="row">
              <input aria-label={`Nome do conjunto ${i + 1}`} value={g.name} onChange={(e) => setSet(i, { name: (e.target as HTMLInputElement).value })} />
              <button class="icon" aria-label={`Apagar o conjunto ${g.name}`} onClick={() => remove(i)}>✕</button>
            </div>
            {kind === "face" && <RefList field={`set${i}`} label="Faces" accept={["face"]} refs={g.faces} onChange={(faces) => setSet(i, { faces })} />}
            {kind === "edge" && <RefList field={`set${i}`} label="Arestas" accept={["edge"]} refs={g.edges ?? []} onChange={(edges) => setSet(i, { edges })} />}
            {kind === "body" && <>
              <fieldset class="checklist">
                <legend class="field-label">Corpos</legend>
                {inst.map((b) => <Check key={b.path} label={b.name} value={!!g.bodies?.includes(b.path)} onChange={(on) => setSet(i, { bodies: on ? [...(g.bodies ?? []), b.path] : (g.bodies ?? []).filter((x) => x !== b.path) })} />)}
                {!inst.length && <p class="muted">Sem instâncias resolvidas.</p>}
              </fieldset>
              <select aria-label={`Material do conjunto ${g.name}`} value={g.material?.name ?? ""} onChange={(e) => { const m = lib.find((x) => x.name === (e.target as HTMLSelectElement).value); setSet(i, { material: m ? { ...m } : undefined }); }}>
                <option value="">Material do estudo</option>
                {lib.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
              </select>
            </>}
          </div>
        );
      })}
      <div class="row">
        <button class="small" onClick={() => add("face")}>+ faces</button>
        <button class="small" onClick={() => add("edge")}>+ arestas</button>
        {assembly && <button class="small" onClick={() => add("body")}>+ corpos</button>}
      </div>
      <p class="field-hint">Um conjunto agrupa faces ou arestas com nome (ex.: «Apoios») e usa-se em várias condições; mudar o conjunto muda todas.{assembly ? " Um conjunto de corpos dá o mesmo material a vários corpos; o material escolhido num corpo em «Corpos e contacto» prevalece." : ""}</p>
    </details>
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
              <ExprInput label={sd.mode === "count" ? "Elementos" : "Tamanho"} unit={sd.mode === "count" ? "" : "mm"} value={sd.value} onChange={(value) => setSeed(i, { value: value ?? 1 })} />
              <button class="icon" aria-label={`Retirar seed ${i + 1}`} onClick={() => set({ seeds: seeds.filter((_, k) => k !== i) })}>✕</button>
            </div>
            <div class="row">
              <ExprInput label="Razão maior/menor" unit="" allowEmpty value={sd.bias} onChange={(bias) => setSeed(i, { bias })} />
              <Select label="Elementos pequenos" value={sd.biasAt ?? "start"} options={SEED_AT} onChange={(biasAt) => setSeed(i, { biasAt })} />
            </div>
            <RefList field={`seed${i}`} label="Arestas" accept={["edge", "face"]} refs={sd.edges} onChange={(edges) => setSeed(i, { edges })} />
          </div>
        ))}
        <button class="small" onClick={() => { set({ seeds: [...seeds, { edges: [], mode: "count", value: 10 }] }); store.set({ pickTarget: { field: `seed${seeds.length}`, accept: ["edge", "face"] } }); }}>+ seed</button>
        <p class="field-hint">Com a seleção de arestas ligada, clique nas arestas no 3D e ajuste ao vivo: +/− ou Shift+roda mudam o n.º (ou o tamanho), B muda a distribuição. Uma face escolhida conta como as suas arestas. Nas malhas mapeadas o n.º de elementos passa às arestas opostas; a distribuição também, no mesmo sentido. Confira o resultado na pré-visualização.</p>
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


export function CfdEditor({ s, up, section }: { s: CfdStudy; up: (p: Partial<CfdStudy>) => void; section: SimSection }) {
  return (
    <>
      {section === "study" && <div class="row">
        <Select label="Solver" value={s.solver} options={[["openfoam", "OpenFOAM (simpleFoam + snappyHexMesh)"], ["su2", "SU2 (incompressível, malha Gmsh)"]]} onChange={(solver) => up({ solver })} />
        <Select label="Regime" value={s.regime} options={[["internal", "Interno (o corpo é o fluido)"], ["external", "Externo (o corpo é um obstáculo)"]]} onChange={(regime) => up({ regime })} />
      </div>}
      {section === "conditions" && <><div class="row">
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
      </>}
      {section === "mesh" && <><div class="row">
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
      </>}
    </>
  );
}

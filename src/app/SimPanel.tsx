// Painel de simulação da peça (pré-processador F1): estudos FEM (CalculiX) e CFD (OpenFOAM, SU2),
// condições nas faces pelo nome topológico, malha, exportação do caso e cálculo no agente local.
import { useState } from "preact/hooks";
import { type Study } from "../doc/study.ts";
import { type SimSection, desktopAgent, store, useStoreKeys } from "./store.ts";
import { ConvergencePanel } from "./ConvergencePanel.tsx";
import { activeStudy, runActiveStudy, updateStudy } from "./sim-actions.ts";
import { Check, Field, Select } from "./forms.tsx";
import { agentStatus, exportStudyCase, resultView } from "./sim-client.ts";
import { layerShown, toggleLayer } from "../sim/result.ts";
import { AssemblyBodies, CfdEditor, FemEditor } from "./SimEditors.tsx";
import { CheckPanel } from "./SimCheck.tsx";
import { BEHAVIOUR, ConvergencePlot, JobProgress, num, pct, QualityReport, ResultExports, SimLegend, SweepPlot, TimePlot } from "./SimResults.tsx";

const SECTION_TITLE: Record<SimSection, string> = {
  study: "Estudo", material: "Material", conditions: "Cargas e apoios", contact: "Contacto entre corpos", mesh: "Malha",
  probes: "Sondas", convergence: "Convergência da malha", check: "Verificação do modelo", run: "Resolver", results: "Resultados",
};

/**
 * Editor da secção escolhida na árvore do modelo (espaços FEM e CFD), à direita da vista: o estudo
 * e a secção vêm do store (a barra do espaço de trabalho e a árvore mudam-nos).
 */
export function SimPanel() {
  // `project`/`active`/`simStudy`: lidos por `activeAssembly`/`activeStudy`
  const st = useStoreKeys("workspace", "simSection", "doc", "project", "active", "simStudy");
  const physics = st.workspace === "cfd" ? "cfd" : "fem";
  const asm = store.activeAssembly() ?? null;
  const s = activeStudy(physics);
  const up = (patch: Partial<Study>) => s && updateStudy(s.id, patch);
  const sec = st.simSection;
  const docId = asm?.id ?? st.doc.id;
  const title = s?.physics === "cfd" && sec === "conditions" ? "Fluido e fronteiras" : SECTION_TITLE[sec];
  return (
    <div class="knowledge-panel sim-panel section-panel" key={`${s?.id ?? ""}:${sec}`}>
      <div class="pm-head">
        <span class="pm-title">{title}</span>
        {s && <span class="muted">{s.name}</span>}
      </div>
      {s && sec === "study" && <Field label="Nome"><input value={s.name} onChange={(e) => up({ name: (e.target as HTMLInputElement).value })} /></Field>}
      {s?.physics === "fem" && <FemEditor s={s} up={up} assembly={!!asm} section={sec} />}
      {s?.physics === "fem" && asm && sec === "contact" && <AssemblyBodies s={s} up={up} />}
      {s?.physics === "fem" && !asm && sec === "contact" && <p class="field-hint">O contacto entre corpos existe nos estudos de montagem.</p>}
      {s?.physics === "fem" && sec === "mesh" && <MeshPreviewBox s={s} doc={docId} />}
      {s?.physics === "cfd" && <CfdEditor s={s} up={up} section={sec} />}
      {s && sec === "convergence" && <ConvergencePanel s={s} />}
      {s && sec === "check" && <CheckPanel s={s} assembly={!!asm} up={up} />}
      {s && (sec === "run" || sec === "results") && <RunBox s={s} doc={docId} part={sec} />}
      {!s && <p class="field-hint">{asm
        ? "Os estudos da montagem analisam vários corpos de uma vez: cada instância com o seu material e as faces planas coincidentes entre corpos coladas (contacto colado, *TIE no CalculiX). As faces das condições escolhem-se nos componentes."
        : "Os estudos preparam o modelo de análise dentro do CAD: condições ligadas às faces pelo nome topológico, malha e ficheiros dos solvers abertos. Crie um estudo no separador «Estudo» da barra."}</p>}
    </div>
  );
}

/** Pré-visualizar a malha do estudo (Gmsh no agente) e a qualidade, dentro da secção Malha. */
function MeshPreviewBox({ s, doc }: { s: Study; doc: string }) {
  const st = useStoreKeys("simResult", "simBusy", "agent");
  const res = st.simResult?.studyId === s.id && st.simResult.doc === doc ? st.simResult.result : null;
  return (
    <>
      <div class="row">
        <button class="small primary" disabled={!!st.simBusy || !st.agent.token} onClick={() => void runActiveStudy(true)}>{st.simBusy === "mesh" ? "A gerar a malha…" : "Pré-visualizar malha"}</button>
      </div>
      {st.simBusy === "mesh" && <JobProgress />}
      {res?.quality && (
        <div class="kw-item ok">
          <table class="info-table">{res.summary.map(([k, x]) => <tr key={k}><td>{k}</td><td>{x}</td></tr>)}</table>
          {res.warnings.map((w) => <p key={w} class="error-text">{w}</p>)}
          <QualityReport q={res.quality} />
          <ResultExports r={res} name={s.name} />
        </div>
      )}
    </>
  );
}

/** Ligação ao agente local (endereço, token, solvers encontrados): partilhada com o painel Cálculos. */
export function AgentBox() {
  const st = useStoreKeys("agent");
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
        <Field label="Endereço"><input value={a.url} onChange={(e) => store.setAgentUrl((e.target as HTMLInputElement).value)} /></Field>
        <Field label="Token"><input type="password" autocomplete="off" value={a.token} onInput={(e) => store.set({ agent: { ...a, token: (e.target as HTMLInputElement).value.trim() } })} /></Field>
        <button class="small" onClick={async () => { const x = await agentStatus(a.url, a.token); setStatus(x.ok ? Object.entries(x.tools ?? {}).map(([k, t]) => `${k} ${t ? "✓" : "✗"}`).join(" · ") : x.error ?? "erro"); }}>Testar ligação</button>
      </details>
  );
}

function RunBox({ s, doc, part }: { s: Study; doc: string; part: "run" | "results" }) {
  const st = useStoreKeys("simBusy", "agent", "simResult", "simView", "simHidden");
  const busy = !!st.simBusy;
  const a = st.agent;
  const res = st.simResult?.studyId === s.id && st.simResult.doc === doc ? st.simResult : null;
  const run = (meshOnly = false) => runActiveStudy(meshOnly);
  const r = res?.result;
  const view = resultView(r);
  const v = st.simView;
  return (
    <>
      {part === "run" && <>
      <div class="row">
        <button class="small" onClick={() => void exportStudyCase(s.id)}>Exportar caso (.zip)</button>
        <a class="small button" href="cad-runner.mjs" download="cad-runner.mjs">Agente local (cad-runner.mjs)</a>
      </div>
      <AgentBox />
      <p class="field-hint">{s.convergence?.enabled ? "A convergência da malha está ligada: este cálculo corre também as malhas do estudo (secção «Convergência»)." : "A convergência da malha configura-se na secção «Convergência»."}</p>
      <div class="row">
        {s.physics === "fem" && <button class="small" disabled={busy || !a.token} onClick={() => void run(true)}>Pré-visualizar malha</button>}
        <button class="small primary" disabled={busy || !a.token} onClick={() => void run()}>{st.simBusy === "run" ? "A calcular…" : "Calcular no agente local"}</button>
      </div>
      {busy && <JobProgress />}
      {r && <p class="muted">Resultado disponível em «Resultados».</p>}
      </>}
      {part === "results" && !r && <p class="field-hint">Ainda sem resultados deste estudo: calcule em «Resolver» (ou F5).</p>}
      {part === "results" && r && (
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
          <ResultExports r={r} name={s.name} />
          <Check label="Mostrar resultados no 3D" value={!st.simHidden} onChange={(x) => store.set({ simHidden: !x })} />
          <details><summary>Hipóteses</summary><ul>{(r.hypotheses ?? r.fem?.hypotheses ?? []).map((h) => <li key={h}>{h}</li>)}</ul></details>
        </div>
      )}
      <p class="field-hint">Resultados de apoio à decisão de engenharia, com as hipóteses e limites indicados: não são certificação nem decisão de uma autoridade ou de um organismo notificado.</p>
    </>
  );
}

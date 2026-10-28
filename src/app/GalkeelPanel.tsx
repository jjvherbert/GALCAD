// Painel "Galkeel": análise integrada de painéis do casco. Escolhem-se as faces no modelo; a geometria
// é medida pelo núcleo, as pressões e espessuras vêm dos módulos da galkeel-calculadora (ISO 12215-5,
// edição 2008, legada) e, se pedido, um estudo FEM verifica a tensão com a mesma pressão. Sai um
// relatório (HTML/JSON) e, com a aplicação aberta dentro da galkeel-app, os resultados vão para o caso
// pelo mesmo contrato das calculadoras (sempre com veredito indeterminado).
import { useState } from "preact/hooks";
import type { TopoRef } from "../doc/types.ts";
import type { FemStudy } from "../doc/study.ts";
import { type Laminate, type PanelInput, type PanelResult, type VesselRecord, EDITION, HYPOTHESES, analysePanel, femCheck, femStudyForPanels, galkeelPayloads, scantlingReport } from "../galkeel/scantling.ts";
import { browserCalc, calcAvailable } from "../galkeel/calc-browser.ts";
import { externalParts, store, useStore } from "./store.ts";
import { Field, RefList, Select } from "./forms.tsx";
import { download } from "./fileio.ts";
import { runStudyFor } from "./sim-client.ts";

const VESSEL: VesselRecord = { craft: "motor", category: "C", LH: 7.5, LWL: 6.5, Bc: 2.2, beta04: 18, V: 25, mLDC: 2000, xAft: 0, forward: 1, zWL: 0, Zside: 0.8 };
const LAMINATE: Laminate = { layup: "mat_roving_wr_cp", psi: 0.33, k5: 1, name: "PRFV mat/roving" };
const TOOL = "CAD protótipo — análise integrada de painéis";

function NumField({ label, value, onChange, step = "any" }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; step?: string }) {
  return <Field label={label}><input type="number" step={step} value={value ?? ""} onChange={(e) => { const t = (e.target as HTMLInputElement).value; onChange(t === "" ? undefined : Number(t)); }} /></Field>;
}

export function GalkeelPanel() {
  if (!calcAvailable) return (
    <div class="knowledge-panel galkeel-panel">
      <div class="tree-head"><b>Galkeel</b><button class="small" onClick={() => store.set({ sidePanel: null })}>← Árvore</button></div>
      <p class="field-hint">Esta compilação não inclui a galkeel-calculadora (submódulo privado da Galkeel): a análise integrada de painéis está indisponível. O resto da aplicação não muda.</p>
    </div>
  );
  return <GalkeelPanelInner />;
}

function GalkeelPanelInner() {
  const st = useStore();
  const g = st.doc.galkeel ?? { vessel: VESSEL, laminate: LAMINATE, panels: [] };
  const v = g.vessel, lam = g.laminate;
  const save = (patch: Partial<typeof g>, label = "Análise Galkeel") => store.commitDoc("part", { ...st.doc, galkeel: { ...g, ...patch } }, label, true);
  const setV = (p: Partial<VesselRecord>) => save({ vessel: { ...v, ...p } });
  const setP = (i: number, p: Partial<PanelInput>) => save({ panels: g.panels.map((x, k) => (k === i ? { ...x, ...p } : x)) });
  const [results, setResults] = useState<PanelResult[] | null>(null);
  const [busy, setBusy] = useState("");
  const [sent, setSent] = useState("");
  const studies = (st.doc.studies ?? []).filter((s): s is FemStudy => s.physics === "fem" && s.analysis === "static");
  const embedded = typeof window !== "undefined" && window.parent !== window;
  const calc = browserCalc();
  const meta = () => ({ model: st.doc.name, calcVersion: calc.version, tool: TOOL, date: new Date().toISOString().slice(0, 10), caseRef: g.caseRef });

  const analyse = async (withFem: boolean) => {
    setBusy(withFem ? "fem" : "calc"); setSent("");
    try {
      if (!g.panels.length) throw new Error("Escolha pelo menos um painel (faces do casco)");
      const geo = (await store.kernel.panels(st.doc, externalParts(st.project, st.doc), g.panels.map((p) => p.face))).panels;
      let res = g.panels.map((p, i) => analysePanel(calc, v, lam, p, geo[i]));
      if (withFem) {
        const base = studies.find((s) => s.id === g.femStudy) ?? studies[0];
        if (!base) throw new Error("Não há estudo FEM estático na peça (crie um com os apoios do casco)");
        const derived = femStudyForPanels(base, res);
        const doc = { ...st.doc, studies: [...(st.doc.studies ?? []), derived] } as typeof st.doc & { id: string };
        const a = st.agent;
        const { result } = await runStudyFor(doc as never, derived.id, a.url, a.token);
        const m = Object.fromEntries(result.metrics.map((x) => [x.key, x.value]));
        res = res.map((r, i) => (m[`probe${i + 1}`] !== undefined ? femCheck(r, m[`probe${i + 1}`], `probe${i + 1}`) : r));
        store.set({ message: `FEM: ${result.solver}, ${result.cells} elementos` });
      }
      setResults(res);
    } catch (e) {
      store.set({ error: (e as Error).message });
    } finally {
      setBusy("");
    }
  };
  const send = () => {
    if (!results) return;
    // só para a página que embebe a aplicação no mesmo origin (galkeel-app → public/cad)
    for (const m of galkeelPayloads(results, v, lam, meta())) window.parent.postMessage(m, window.location.origin);
    setSent(`${results.length} resultado(s) enviados ao caso`);
  };

  return (
    <div class="knowledge-panel galkeel-panel">
      <div class="tree-head">
        <b>Galkeel — {st.doc.name}</b>
        <button class="small" onClick={() => store.set({ sidePanel: null })}>← Árvore</button>
      </div>
      <p class="field-hint">Painéis do casco: geometria medida no modelo, pressões e espessura FRP pela galkeel-calculadora ({calc.version}), verificação FEM opcional. {EDITION}.</p>
      <details open>
        <summary><b>Embarcação</b></summary>
        <div class="row">
          <Select label="Tipo" value={v.craft} options={[["motor", "Motor"], ["sail", "Vela"]]} onChange={(craft) => setV({ craft })} />
          <Select label="Categoria" value={v.category} options={[["A", "A"], ["B", "B"], ["C", "C"], ["D", "D"]]} onChange={(category) => setV({ category })} />
        </div>
        <div class="row3">
          <NumField label="LH (m)" value={v.LH} onChange={(LH) => setV({ LH: LH ?? 0 })} />
          <NumField label="LWL (m)" value={v.LWL} onChange={(LWL) => setV({ LWL: LWL ?? 0 })} />
          <NumField label="mLDC (kg)" value={v.mLDC} onChange={(mLDC) => setV({ mLDC: mLDC ?? 0 })} />
        </div>
        {v.craft === "motor"
          ? <div class="row3"><NumField label="Bc (m)" value={v.Bc} onChange={(Bc) => setV({ Bc: Bc ?? 0 })} /><NumField label="β0,4 (°)" value={v.beta04} onChange={(beta04) => setV({ beta04: beta04 ?? 0 })} /><NumField label="V (nós)" value={v.V} onChange={(V) => setV({ V: V ?? 0 })} /></div>
          : <NumField label="GZmax até 60° (m, opcional)" value={v.GZmax60} onChange={(GZmax60) => setV({ GZmax60 })} />}
        <div class="row3">
          <NumField label="X ré da LWL (mm)" value={v.xAft} onChange={(xAft) => setV({ xAft: xAft ?? 0 })} />
          <Select label="Vante" value={String(v.forward)} options={[["1", "+X"], ["-1", "−X"]]} onChange={(f) => setV({ forward: Number(f) as 1 | -1 })} />
          <NumField label="Z da LA (mm)" value={v.zWL} onChange={(zWL) => setV({ zWL: zWL ?? 0 })} />
        </div>
        <NumField label="Altura do costado acima da LA, Z (m)" value={v.Zside} onChange={(Zside) => setV({ Zside: Zside ?? 0 })} />
        <Field label="Caso Galkeel (referência)"><input value={g.caseRef ?? ""} placeholder="GK-2026-0001" onChange={(e) => save({ caseRef: (e.target as HTMLInputElement).value.trim() || undefined })} /></Field>
      </details>
      <details open>
        <summary><b>Laminado</b></summary>
        <div class="row3">
          <Select label="Reforço" value={lam.layup} options={[["mat_roving_wr_cp", "Mat/roving/WR/CP"], ["sprayed", "Projetado"]]} onChange={(layup) => save({ laminate: { ...lam, layup } })} />
          <NumField label="ψ (teor de fibra)" value={lam.psi} step="0.01" onChange={(psi) => save({ laminate: { ...lam, psi: psi ?? 0.3 } })} />
          <NumField label="k5" value={lam.k5} step="0.1" onChange={(k5) => save({ laminate: { ...lam, k5: k5 ?? 1 } })} />
        </div>
      </details>
      <h3>Painéis</h3>
      <RefList field="galkeel.panels" label="Faces dos painéis" accept={["face"]} refs={g.panels.map((p): TopoRef => ({ kind: "face", name: p.face }))}
        onChange={(refs) => save({ panels: refs.map((r) => g.panels.find((p) => p.face === r.name) ?? { face: r.name, target: "auto", label: `Painel ${g.panels.length + 1}` }) }, "Painéis Galkeel")} />
      {g.panels.map((p, i) => (
        <div class="kw-item" key={p.face}>
          <div class="row">
            <input aria-label={`Nome do painel ${i + 1}`} value={p.label ?? ""} onChange={(e) => setP(i, { label: (e.target as HTMLInputElement).value })} />
            <select aria-label={`Zona do painel ${i + 1}`} value={p.target} onChange={(e) => setP(i, { target: (e.target as HTMLSelectElement).value as PanelInput["target"] })}>
              <option value="auto">Zona automática</option><option value="bottom">Fundo</option><option value="side">Costado</option><option value="deck">Convés</option>
            </select>
          </div>
          <div class="row4">
            <NumField label="b (mm)" value={p.b} onChange={(b) => setP(i, { b })} />
            <NumField label="l (mm)" value={p.l} onChange={(l) => setP(i, { l })} />
            <NumField label="c (mm)" value={p.c} onChange={(c) => setP(i, { c })} />
            <NumField label="t real (mm)" value={p.thickness} onChange={(thickness) => setP(i, { thickness })} />
          </div>
        </div>
      ))}
      <p class="field-hint">b, l e c: dimensões do painel entre apoios (vazio = medidas na face). t real: espessura do laminado.</p>
      <button class="small primary" disabled={!!busy || !g.panels.length} onClick={() => void analyse(false)}>{busy === "calc" ? "A calcular…" : "Analisar painéis"}</button>
      <div class="row">
        <select aria-label="Estudo FEM de verificação" value={g.femStudy ?? ""} onChange={(e) => save({ femStudy: (e.target as HTMLSelectElement).value || undefined })}>
          {studies.length ? studies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>) : <option value="">— sem estudo FEM estático —</option>}
        </select>
        <button class="small" disabled={!!busy || !studies.length || !st.agent.token} title={st.agent.token ? "" : "Ligue o agente local no painel Simulação"} onClick={() => void analyse(true)}>{busy === "fem" ? "A calcular FEM…" : "+ Verificar com FEM"}</button>
      </div>
      {results && (
        <div class="kw-item ok">
          <div class="table-scroll">
            <table class="info-table data">
              <tr><th>Painel</th><th>Zona</th><th>b×l (mm)</th><th>c</th><th>P (kN/m²)</th><th>t req. (mm)</th><th>t real</th><th>real/req.</th><th>FEM σ/σd</th></tr>
              {results.map((r) => (
                <tr key={r.face}>
                  <td>{r.label}</td><td>{{ bottom: "Fundo", side: "Costado", deck: "Convés" }[r.target]}</td>
                  <td>{r.geometry.b.toFixed(0)}×{r.geometry.l.toFixed(0)}</td><td>{r.geometry.c.toFixed(1)}</td>
                  <td>{r.pressureKPa.toFixed(2)}</td><td><b>{r.governingThicknessMm.toFixed(2)}</b></td>
                  <td>{r.actualThicknessMm?.toFixed(2) ?? "—"}</td><td class={r.ratio !== undefined && r.ratio < 1 ? "error-text" : ""}>{r.ratio?.toFixed(2) ?? "—"}</td>
                  <td class={r.fem && r.fem.utilisation > 1 ? "error-text" : ""}>{r.fem ? `${r.fem.stressMPa.toFixed(1)}/${r.sigmaD.toFixed(1)}` : "—"}</td>
                </tr>
              ))}
            </table>
          </div>
          <details><summary>Avisos ({results.reduce((n, r) => n + r.warnings.length, 0)})</summary><ul>{results.flatMap((r) => r.warnings.map((w) => <li key={r.face + w}><b>{r.label}:</b> {w}</li>))}</ul></details>
          <details><summary>Hipóteses e limitações</summary><ul>{HYPOTHESES.map((h) => <li key={h}>{h}</li>)}</ul></details>
          <div class="row">
            <button class="small" onClick={() => download(`escantilhonamento-${st.doc.name.replace(/[^\w-]+/g, "_")}.html`, scantlingReport(results, v, lam, meta()), "text/html")}>Relatório (HTML/PDF)</button>
            <button class="small" onClick={() => download(`escantilhonamento-${st.doc.name.replace(/[^\w-]+/g, "_")}.json`, JSON.stringify(galkeelPayloads(results, v, lam, meta()), null, 1), "application/json")}>JSON</button>
            {embedded && <button class="small primary" onClick={send}>Enviar ao caso (Galkeel)</button>}
          </div>
          {sent && <p class="muted" role="status">{sent}</p>}
          <p class="field-hint">Resultado indicativo, veredito indeterminado: não é declaração de conformidade nem certificação. Confirmar apoios, laminado real e a edição aplicável com o técnico responsável.</p>
        </div>
      )}
    </div>
  );
}

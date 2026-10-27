// Painel "Cálculos": biblioteca de cálculos de engenharia (atmosfera, asa finita, perfil NACA, colunas,
// placas) com referência, hipóteses e caso de verificação; propriedades de secção lidas de uma face plana
// do modelo; e polares de perfis no XFOIL do agente local, com gráficos, ligação à asa finita e esboço
// do perfil no CAD. Tudo apoio ao projeto — não substitui ensaios, regulamentos nem certificação.
import { useState } from "preact/hooks";
import type { SketchEntity, TopoRef } from "../doc/types.ts";
import { addFeature } from "../doc/io.ts";
import { CALCS, type CalcDef, calcReport, formatOutput, runCalc } from "../calc/library.ts";
import { type XfoilRequest, type XfoilResult, nacaCoords } from "../sim/xfoil.ts";
import type { SectionProps } from "../kernel/panels.ts";
import { externalParts, store, useStore } from "./store.ts";
import { Field, RefList } from "./forms.tsx";
import { download } from "./fileio.ts";
import { runXfoilAgent } from "./sim-client.ts";
import { AgentBox } from "./SimPanel.tsx";

// valores escolhidos ficam enquanto a aplicação está aberta (o painel pode fechar e reabrir)
const memo: { id: string; values: Record<string, Record<string, number>>; xf: XfoilForm; polar: XfoilResult | null; section: { face: string; s: SectionProps } | null } = {
  id: "isa", values: {}, xf: { source: "naca", naca: "2412", coords: "", re: 1e6, mach: 0, ncrit: 9, from: -4, to: 14, step: 1, chord: 200 }, polar: null, section: null,
};
interface XfoilForm { source: "naca" | "coords"; naca: string; coords: string; re: number; mach: number; ncrit: number; from: number; to: number; step: number; chord: number }

function Num({ label, value, onChange, step = "any", hint }: { label: string; value: number; onChange: (v: number) => void; step?: string; hint?: string }) {
  return <Field label={label} hint={hint}><input type="number" step={step} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(Number((e.target as HTMLInputElement).value))} /></Field>;
}

/** Lê coordenadas coladas (.dat Selig: nome opcional na 1.ª linha, depois pares x y). */
export function parseDat(text: string): { name: string; coords: [number, number][] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pairs = lines.map((l) => l.split(/[\s,;]+/).map(Number));
  const name = pairs[0] && (pairs[0].length < 2 || pairs[0].some((x) => !Number.isFinite(x))) ? lines[0] : "Perfil";
  const coords = pairs.filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]] as [number, number]);
  return { name, coords };
}

/** Esboço do perfil (corda c no plano XY, bordo de ataque na origem): spline + segmento do bordo de fuga. */
export function airfoilSketch(coords: [number, number][], chord: number, name: string) {
  const entities: Record<string, SketchEntity> = {};
  const ids = coords.map(([x, y], i) => { const id = `p${i + 1}`; entities[id] = { type: "point", x: x * chord, y: y * chord }; return id; });
  entities.s1 = { type: "spline", pts: ids };
  entities.l1 = { type: "line", p1: ids[ids.length - 1], p2: ids[0] };
  return { type: "sketch" as const, name, plane: { kind: "std" as const, name: "XY" as const }, entities, constraints: [] };
}

function PolarPlot({ r }: { r: XfoilResult }) {
  const W = 300, H = 150, P = 32;
  const pts = r.polar;
  if (pts.length < 2) return null;
  const plot = (xs: number[], ys: number[], xl: string, yl: string, label: string) => {
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(0, ...ys), y1 = Math.max(...ys);
    const X = (x: number) => P + ((x - x0) / (x1 - x0 || 1)) * (W - P - 8), Y = (y: number) => H - 20 - ((y - y0) / (y1 - y0 || 1)) * (H - 32);
    return (
      <svg class="conv-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <line x1={P} y1={H - 20} x2={W - 4} y2={H - 20} class="axis" />
        <line x1={P} y1={6} x2={P} y2={H - 20} class="axis" />
        {y0 < 0 && <line x1={P} x2={W - 4} y1={Y(0)} y2={Y(0)} class="axis" />}
        <polyline points={xs.map((x, i) => `${X(x)},${Y(ys[i])}`).join(" ")} class="curve" />
        {xs.map((x, i) => <circle key={i} cx={X(x)} cy={Y(ys[i])} r={1.8} />)}
        <text x={P} y={H - 6}>{x0.toPrecision(3)}</text><text x={W - 40} y={H - 6}>{x1.toPrecision(3)} {xl}</text>
        <text x={2} y={12}>{yl} {y1.toPrecision(3)}</text><text x={2} y={H - 22}>{y0.toPrecision(2)}</text>
      </svg>
    );
  };
  return (
    <div class="row">
      {plot(pts.map((p) => p.alpha), pts.map((p) => p.cl), "α (°)", "CL", "CL em função de α")}
      {plot(pts.map((p) => p.cd), pts.map((p) => p.cl), "CD", "CL", "Polar de arrasto CL–CD")}
    </div>
  );
}

export function CalcPanel() {
  const st = useStore();
  const [id, setId] = useState(memo.id);
  const [values, setValues] = useState(memo.values);
  const [xf, setXf] = useState(memo.xf);
  const [polar, setPolar] = useState<XfoilResult | null>(memo.polar);
  const [section, setSection] = useState(memo.section);
  const [busy, setBusy] = useState(false);
  const def: CalcDef = CALCS.find((c) => c.id === id) ?? CALCS[0];
  const vals = { ...Object.fromEntries(def.inputs.map((i) => [i.key, i.default])), ...(values[def.id] ?? {}) };
  const choose = (next: string) => { memo.id = next; setId(next); };
  const setVals = (p: Record<string, number>, calc = def.id) => { const v = { ...values, [calc]: { ...(values[calc] ?? {}), ...p } }; memo.values = v; setValues(v); };
  const setX = (p: Partial<XfoilForm>) => { const v = { ...xf, ...p }; memo.xf = v; setXf(v); };
  let result: ReturnType<typeof runCalc> | null = null, error = "";
  try { result = runCalc(def.id, vals); } catch (e) { error = (e as Error).message; }

  const readSection = async (refs: TopoRef[]) => {
    const face = refs[0]?.name;
    if (!face) { memo.section = null; setSection(null); return; }
    try {
      const [g] = (await store.kernel.panels(st.doc, externalParts(st.project, st.doc), [face])).panels;
      if (!g.section) throw new Error("A face escolhida não é plana: escolha a face de topo de um perfil extrudido");
      const s = { face, s: g.section };
      memo.section = s; setSection(s);
      setVals({ A: +g.section.A.toPrecision(6), I: +g.section.I2.toPrecision(6) }, "column");
      store.set({ message: `Secção: A = ${g.section.A.toFixed(1)} mm², Imin = ${g.section.I2.toFixed(0)} mm⁴ → coluna` });
    } catch (e) {
      store.set({ error: (e as Error).message });
    }
  };

  const request = (): XfoilRequest => {
    const alpha = { from: xf.from, to: xf.to, step: xf.step };
    if (xf.source === "naca") return { airfoil: { naca: xf.naca.trim() }, re: xf.re, mach: xf.mach, ncrit: xf.ncrit, alpha };
    const d = parseDat(xf.coords);
    return { airfoil: { name: d.name, coords: d.coords }, re: xf.re, mach: xf.mach, ncrit: xf.ncrit, alpha };
  };
  const runPolar = async () => {
    setBusy(true);
    try {
      const r = await runXfoilAgent(request(), st.agent.url, st.agent.token);
      memo.polar = r; setPolar(r);
      store.set({ message: `XFOIL: ${r.polar.length} pontos em ${r.seconds.toFixed(1)} s` });
    } catch (e) {
      store.set({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const coordsNow = () => (xf.source === "naca" ? (/^\d{4}$/.test(xf.naca.trim()) ? nacaCoords(xf.naca.trim(), 60) : null) : parseDat(xf.coords).coords);
  const makeSketch = () => {
    const c = coordsNow();
    if (!c || c.length < 10) { store.set({ error: "Gerador de esboço: NACA de 4 dígitos ou coordenadas coladas" }); return; }
    const name = xf.source === "naca" ? `Perfil NACA ${xf.naca.trim()}` : parseDat(xf.coords).name;
    store.commit(addFeature(st.doc, airfoilSketch(c, xf.chord, name) as never).doc, `Esboço ${name}`);
    store.set({ message: `${name}: esboço com corda ${xf.chord} mm no plano XY (extrudir para uma asa ou secção)` });
  };
  const isaRe = () => {
    const r = runCalc("isa", values.isa ?? {});
    const re = r.outputs.find((o) => o.key === "Re")!.value as number, M = r.outputs.find((o) => o.key === "M")!.value as number;
    setX({ re: +re.toPrecision(3), mach: +Math.min(M, 0.7).toFixed(3) });
  };

  return (
    <div class="knowledge-panel calc-panel">
      <div class="tree-head">
        <b>Cálculos — {st.doc.name}</b>
        <button class="small" onClick={() => store.set({ sidePanel: null })}>← Árvore</button>
      </div>
      <Field label="Cálculo">
        <select aria-label="Cálculo" value={def.id} onChange={(e) => choose((e.target as HTMLSelectElement).value)}>
          {[...new Set(CALCS.map((c) => c.domain))].map((d) => (
            <optgroup key={d} label={d}>{CALCS.filter((c) => c.domain === d).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
          ))}
        </select>
      </Field>
      <p class="field-hint">{def.reference}</p>
      {def.id === "column" && (
        <>
          <RefList field="calc.section" label="Secção de uma face plana (opcional)" accept={["face"]} single refs={section ? [{ kind: "face", name: section.face }] : []} onChange={(r) => void readSection(r)} />
          {section && <p class="muted calc-section">A = {section.s.A.toFixed(1)} mm² · I1 = {section.s.I1.toFixed(0)} · I2 = {section.s.I2.toFixed(0)} mm⁴ · ρmin = {section.s.rmin.toFixed(2)} mm · W1 = {section.s.W1.toFixed(0)} · W2 = {section.s.W2.toFixed(0)} mm³</p>}
        </>
      )}
      <div class="calc-inputs">
        {def.inputs.map((i) => i.options
          ? <Field key={i.key} label={i.label} hint={i.help}><select aria-label={i.label} value={String(vals[i.key])} onChange={(e) => setVals({ [i.key]: Number((e.target as HTMLSelectElement).value) })}>{i.options.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}</select></Field>
          : <Num key={i.key} label={`${i.label} (${i.unit})`} value={vals[i.key]} hint={i.help} onChange={(x) => setVals({ [i.key]: x })} />)}
      </div>
      <div class="row">
        <button class="small" onClick={() => setVals(def.verify.inputs)}>Caso de verificação</button>
        {result && <button class="small" onClick={() => download(`calculo-${def.id}.html`, calcReport(result!, st.doc.name), "text/html")}>Relatório (HTML/PDF)</button>}
      </div>
      {error && <p class="error-text">{error}</p>}
      {result && (
        <div class="kw-item ok">
          <table class="info-table data calc-results">
            {result.outputs.map((o) => <tr key={o.key}><td>{o.label}</td><td style="text-align:right"><b>{String(formatOutput(o))}</b></td><td>{o.unit}</td></tr>)}
          </table>
          {result.warnings.map((w) => <p key={w} class="error-text">⚠ {w}</p>)}
          <details><summary>Hipóteses e limites</summary><ul>{def.hypotheses.map((h) => <li key={h}>{h}</li>)}</ul><p class="muted">Verificação: {def.verify.note}</p></details>
        </div>
      )}

      <h3>Perfis e XFOIL</h3>
      <div class="row">
        <select aria-label="Origem do perfil" value={xf.source} onChange={(e) => setX({ source: (e.target as HTMLSelectElement).value as XfoilForm["source"] })}>
          <option value="naca">Código NACA</option><option value="coords">Coordenadas (.dat)</option>
        </select>
        {xf.source === "naca" && <input aria-label="Código NACA" value={xf.naca} onChange={(e) => setX({ naca: (e.target as HTMLInputElement).value })} />}
      </div>
      {xf.source === "coords" && <textarea aria-label="Coordenadas do perfil" class="script-editor" style="min-height:90px" placeholder={"Nome\n1.0 0.0013\n…\n0.0 0.0\n…\n1.0 -0.0013"} value={xf.coords} onInput={(e) => setX({ coords: (e.target as HTMLTextAreaElement).value })} />}
      <div class="row3">
        <Num label="Reynolds" value={xf.re} onChange={(re) => setX({ re })} />
        <Num label="Mach" value={xf.mach} step="0.01" onChange={(mach) => setX({ mach })} />
        <Num label="Ncrit" value={xf.ncrit} onChange={(ncrit) => setX({ ncrit })} />
      </div>
      <div class="row3">
        <Num label="α de (°)" value={xf.from} onChange={(from) => setX({ from })} />
        <Num label="α até (°)" value={xf.to} onChange={(to) => setX({ to })} />
        <Num label="passo (°)" value={xf.step} onChange={(step) => setX({ step })} />
      </div>
      <AgentBox />
      <div class="row">
        <button class="small" onClick={isaRe} title="Reynolds e Mach do cálculo «Atmosfera padrão» (velocidade e corda)">Re e Mach da ISA</button>
        <button class="small primary" disabled={busy || !st.agent.token} title={st.agent.token ? "" : "Ligue o agente local no painel Simulação"} onClick={() => void runPolar()}>{busy ? "A calcular…" : "Calcular polar (XFOIL)"}</button>
      </div>
      <div class="row">
        <Num label="Corda do esboço (mm)" value={xf.chord} onChange={(chord) => setX({ chord })} />
        <button class="small" onClick={makeSketch}>Criar esboço do perfil</button>
      </div>
      {polar && (
        <div class="kw-item ok">
          <p><b>{polar.airfoil}</b> · Re {polar.re.toExponential(2)} · M {polar.mach} · Ncrit {polar.ncrit} · {polar.solver}</p>
          <table class="info-table data">
            <tr><td>CLα</td><td><b>{polar.summary.clAlphaDeg?.toFixed(4) ?? "—"}</b> /° ({polar.summary.clAlphaRad?.toFixed(3) ?? "—"} /rad)</td></tr>
            <tr><td>α de sustentação nula</td><td>{polar.summary.alpha0?.toFixed(2) ?? "—"}°</td></tr>
            <tr><td>CLmax</td><td>{polar.summary.clMax !== null ? `${polar.summary.clMax.toFixed(3)} a ${polar.summary.alphaClMax}°` : "não atingido"}</td></tr>
            <tr><td>CDmin</td><td>{polar.summary.cdMin.toFixed(5)} (CL {polar.summary.clAtCdMin.toFixed(3)})</td></tr>
            <tr><td>(L/D)max</td><td>{polar.summary.ldMax.toFixed(1)} a {polar.summary.alphaLdMax}°</td></tr>
          </table>
          <PolarPlot r={polar} />
          {polar.warnings.map((w) => <p key={w} class="error-text">⚠ {w}</p>)}
          <div class="row">
            <button class="small" disabled={polar.summary.clAlphaDeg === null} onClick={() => { setVals({ a0: +polar.summary.clAlphaDeg!.toFixed(5) }, "wing"); choose("wing"); }}>Usar CLα na asa finita</button>
            <button class="small" onClick={() => download(`polar-${polar.airfoil.replace(/[^\w-]+/g, "_")}.csv`, "alpha,CL,CD,CDp,CM,Xtr_top,Xtr_bot\n" + polar.polar.map((p) => [p.alpha, p.cl, p.cd, p.cdp, p.cm, p.xtrTop, p.xtrBot].join(",")).join("\n"), "text/csv")}>CSV</button>
          </div>
          <details><summary>Polar ({polar.polar.length} pontos)</summary>
            <div class="table-scroll"><table class="info-table data"><tr><th>α</th><th>CL</th><th>CD</th><th>CM</th><th>Xtr ext.</th><th>Xtr int.</th></tr>
              {polar.polar.map((p) => <tr key={p.alpha}><td>{p.alpha}</td><td>{p.cl.toFixed(4)}</td><td>{p.cd.toFixed(5)}</td><td>{p.cm.toFixed(4)}</td><td>{p.xtrTop.toFixed(3)}</td><td>{p.xtrBot.toFixed(3)}</td></tr>)}
            </table></div>
          </details>
          <details><summary>Hipóteses e limites</summary><ul>{polar.hypotheses.map((h) => <li key={h}>{h}</li>)}</ul></details>
        </div>
      )}
      <p class="field-hint">Cálculos de apoio ao projeto por métodos de manual e ferramentas abertas: não são certificação nem substituem os métodos e coeficientes do regulamento aplicável. O escantilhonamento naval está no painel Galkeel (galkeel-calculadora).</p>
    </div>
  );
}

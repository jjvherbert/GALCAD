// Sugestões do avaliador de malha (C9c): cartões por bloco/corpo com a razão, a métrica antes→depois e
// os elementos depois; pré-visualizar (fantasmas no 3D, sem mexer no estudo), aceitar (um passo de
// desfazer), ignorar (guardado no estudo) e «Aceitar todas» (patches fundidos, um só passo de desfazer).
// Mais o mapa de tamanho pretendido vs obtido por aresta (plano de seeds).
import { useEffect, useState } from "preact/hooks";
import type { FemStudy } from "../doc/study.ts";
import { evalExpr } from "../doc/expr.ts";
import type { SeedPreview } from "../kernel/sim-fem.ts";
import { applyPatch, groupByBlock, type MeshAdvice, mergePatches, sizeMap, type Suggestion } from "../sim/mesh-advice.ts";
import type { MeshReport } from "../sim/quality.ts";
import { store, useStoreKeys } from "./store.ts";
import { externalParts } from "./store-features.ts";
import { updateStudy } from "./sim-actions.ts";

const RULE_LABEL: Record<Suggestion["rule"], string> = {
  thin: "Espessura", tiny: "Aresta curta", arc: "Arco", hex: "Hexaedros", jacobian: "Jacobiano",
};

const n3 = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toPrecision(3));

function targetSize(s: FemStudy): number {
  try { return typeof s.mesh.size === "number" ? s.mesh.size : evalExpr(s.mesh.size); } catch { return NaN; }
}

function Card({ sug, s, ignored, previewing }: { sug: Suggestion; s: FemStudy; ignored: boolean; previewing: boolean }) {
  const m = sug.metric;
  return (
    <div class={`advice-card${ignored ? " ignored" : ""}`} data-rule={sug.rule}>
      <div class="advice-head"><span class="advice-rule">{RULE_LABEL[sug.rule]}</span> <span class="muted">{sug.region.label}</span></div>
      <p class="advice-why">{sug.why}</p>
      <p class="advice-metric muted">
        {m && <>{m.name}: {n3(m.before)}{m.unit}{m.after !== undefined && <> → {n3(m.after)}{m.unit}</>}</>}
        {m && sug.elements && " · "}
        {sug.elements && <>elementos nas arestas: {sug.elements.before} → {sug.elements.after}</>}
      </p>
      <div class="row advice-actions">
        <button class={`small${previewing ? " on" : ""}`} aria-pressed={previewing} onClick={() => store.set({ advicePreview: previewing ? null : sug.preview })}>Pré-visualizar</button>
        <button class="small primary" onClick={() => { store.set({ advicePreview: null }); updateStudy(s.id, { mesh: applyPatch(s.mesh, sug.patch) }, "Aceitar sugestão da malha"); }}>Aceitar</button>
        {!ignored && <button class="small" onClick={() => updateStudy(s.id, { adviceIgnored: [...(s.adviceIgnored ?? []), sug.id] }, "Ignorar sugestão da malha")}>Ignorar</button>}
      </div>
    </div>
  );
}

/** Painel de sugestões e mapa de tamanhos, depois da pré-visualização da malha (só peças). */
export function MeshAdvicePanel({ s, quality }: { s: FemStudy; quality: MeshReport }) {
  const st = useStoreKeys("active", "advicePreview");
  const [advice, setAdvice] = useState<MeshAdvice | null>(null);
  const [seeds, setSeeds] = useState<SeedPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [applied, setApplied] = useState(false);
  const part = st.active.kind === "part";
  const meshKey = JSON.stringify(s.mesh);

  useEffect(() => {
    if (!part) return;
    let live = true;
    const { doc, project } = store.state, parts = externalParts(project, doc);
    Promise.all([store.kernel.meshAdvice(doc, parts, s.id, quality.worst), store.kernel.meshSeeds(doc, parts, s.id)])
      .then(([a, p]) => { if (live) { setAdvice(a); setSeeds(p); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [part, s.id, quality, meshKey]);
  // sair do painel apaga os fantasmas
  useEffect(() => () => store.set({ advicePreview: null }), []);

  if (!part) return <p class="field-hint">As sugestões da malha ainda só existem para peças (numa montagem, abra a peça).</p>;
  if (error) return <p class="error-text">Sugestões da malha: {error}</p>;
  if (!advice) return <p class="muted">A avaliar a malha…</p>;

  const ignoredIds = new Set(s.adviceIgnored ?? []);
  const visible = advice.suggestions.filter((x) => !ignoredIds.has(x.id));
  const ignored = advice.suggestions.filter((x) => ignoredIds.has(x.id));
  const shown = showIgnored ? advice.suggestions : visible;
  const prev = st.advicePreview;
  const acceptAll = () => { store.set({ advicePreview: null }); updateStudy(s.id, { mesh: applyPatch(s.mesh, mergePatches(visible.map((x) => x.patch))) }, "Aceitar todas as sugestões da malha"); setApplied(true); };
  return (
    <details open class="mesh-advice">
      <summary>Sugestões da malha ({visible.length})</summary>
      <div class="row advice-bar">
        {visible.length > 0 && <button class="small primary" onClick={acceptAll}>Aceitar todas</button>}
        {applied && <button class="small" onClick={() => { store.undo(); setApplied(false); }}>Desfazer sugestão</button>}
        {ignored.length > 0 && <label class="check"><input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored((e.target as HTMLInputElement).checked)} /> Mostrar ignoradas ({ignored.length})</label>}
      </div>
      {shown.length === 0 && <p class="muted">Sem sugestões: a malha cumpre as regras do avaliador.</p>}
      {groupByBlock(shown).map((g) => (
        <div key={g.block} class="advice-group">
          <h4>{g.block}</h4>
          <div class="advice-cards">
            {g.items.map((x) => <Card key={x.id} sug={x} s={s} ignored={ignoredIds.has(x.id)} previewing={prev === x.preview} />)}
          </div>
        </div>
      ))}
      {advice.notes.map((n) => <p key={n} class="field-hint">{n}</p>)}
      {seeds && <SizeMap p={seeds} target={targetSize(s)} />}
    </details>
  );
}

/** Tamanho pretendido vs obtido por aresta: histograma da razão e as arestas mais afastadas. */
function SizeMap({ p, target }: { p: SeedPreview; target: number }) {
  const rows = sizeMap(p, target).filter((r) => Number.isFinite(r.ratio));
  if (!rows.length) return null;
  const edges = [0, 0.25, 0.5, 0.75, 0.9, 1.1, 1.5, 2, Infinity];
  const counts = edges.slice(0, -1).map((lo, i) => rows.filter((r) => r.ratio >= lo && r.ratio < edges[i + 1]).length);
  const peak = Math.max(...counts, 1);
  const worst = [...rows].sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio))).slice(0, 6);
  return (
    <details class="size-map">
      <summary>Tamanho pretendido vs obtido ({rows.length} arestas)</summary>
      <div class="histogram" aria-label="Histograma da razão tamanho obtido / pretendido">
        {counts.map((n, i) => <div key={i} class={`bar${edges[i] >= 0.9 && edges[i] < 1.1 ? " ok" : ""}`} title={`${edges[i]}–${edges[i + 1] === Infinity ? "∞" : edges[i + 1]}: ${n}`} style={{ height: `${(100 * n) / peak}%` }} />)}
      </div>
      <p class="muted">Razão obtido / pretendido de 0 a ≥ 2 (1 = o tamanho global de {n3(target)} mm).</p>
      <table class="info-table">
        <tbody>
          <tr><td>Aresta</td><td>elementos · tamanho obtido · razão</td></tr>
          {worst.map((r) => <tr key={r.tag}><td>{r.tag}{r.kind === "user" ? " (seed)" : r.kind === "propagated" ? " (propagada)" : ""}</td><td>{r.n} · {n3(r.h)} mm · {r.ratio.toFixed(2)}</td></tr>)}
        </tbody>
      </table>
      <p class="field-hint">Por aresta, a partir do plano de seeds (não por elemento do Gmsh): razões abaixo de 1 vêm de refinamento local, seeds ou arestas curtas; acima de 1, de seeds grossas.</p>
    </details>
  );
}

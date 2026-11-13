// Editor da casca (Mindlin) e do laminado: camadas do anexo C da ISO 12215-5 e regiões por faces.
import { useState } from "preact/hooks";
import type { FemStudy } from "../doc/study.ts";
import { type FibreKind, type LaminationProcess, type OrthoPly, type PlyType, PLY_TYPE_LABELS, PROCESS_LABELS, guidancePhi, isoPlyToOrtho, orthoPlyError } from "../sim/laminate.ts";
import { Check, ExprInput, Field, RefList, Select } from "./forms.tsx";

type Shell = NonNullable<FemStudy["shell"]>;
type Region = NonNullable<Shell["regions"]>[number];

const FIBRES: [FibreKind, string][] = [["glass", "Vidro E"], ["carbon", "Carbono"]];
const total = (plies: OrthoPly[]) => +plies.reduce((a, p) => a + p.t, 0).toFixed(3);
const num = (e: Event) => Number((e.target as HTMLInputElement).value);

/** Acrescentar uma camada do anexo C: fibra, tipo, gramagem e teor em fibra (por defeito o da Tabela C.7). */
function PlyAdder({ id, onAdd }: { id: string; onAdd: (p: OrthoPly[]) => void }) {
  const [fibre, setFibre] = useState<FibreKind>("glass");
  const [ply, setPly] = useState<PlyType>("csm");
  const [process, setProcess] = useState<LaminationProcess>("hand-simple");
  const [w, setW] = useState(0.45);
  const [theta, setTheta] = useState(0);
  const [phi, setPhi] = useState<number | null>(null);
  const guide = guidancePhi(fibre, ply, process);
  const usedPhi = phi ?? guide ?? 0.3;
  const plies = isoPlyToOrtho({ fibre, ply, w, phi: usedPhi }, theta);
  return (
    <div class="kw-item" aria-label={`Nova camada (${id})`}>
      <div class="row">
        <Select label="Fibra" value={fibre} options={FIBRES} onChange={(f) => { setFibre(f); if (f === "carbon" && ply === "rovimat") setPly("wr"); }} />
        <Select label="Tipo" value={ply} options={(Object.entries(PLY_TYPE_LABELS) as [PlyType, string][]).filter(([k]) => fibre === "glass" || k !== "rovimat")} onChange={setPly} />
      </div>
      <Select label="Processo (teor em fibra de referência)" value={process} options={Object.entries(PROCESS_LABELS) as [LaminationProcess, string][]} onChange={(p) => { setProcess(p); setPhi(null); }} />
      <div class="row3">
        <Field label="w (kg/m²)"><input type="number" min="0.05" step="0.05" value={w} onChange={(e) => setW(num(e))} /></Field>
        <Field label="φ (volume)"><input type="number" min="0.1" max="0.8" step="0.01" value={+usedPhi.toFixed(3)} onChange={(e) => setPhi(num(e))} /></Field>
        <Field label="θ (°)"><input type="number" step="15" value={theta} onChange={(e) => setTheta(num(e))} /></Field>
      </div>
      {plies
        ? <button class="small" onClick={() => onAdd(plies)}>+ camada ({+plies.reduce((a, p) => a + p.t, 0).toFixed(2)} mm)</button>
        : <p class="field-hint">Combinação sem dados no anexo C (verifique w e φ).</p>}
      {phi !== null && guide !== null && phi !== guide && <p class="field-hint">φ de referência (Tabela C.7): {guide}.</p>}
    </div>
  );
}

/** Tabela das camadas, da base para o topo: ângulo e espessura editáveis, ordem e remoção. */
function PlyTable({ id, plies, onChange }: { id: string; plies: OrthoPly[]; onChange: (p: OrthoPly[]) => void }) {
  const set = (k: number, p: Partial<OrthoPly>) => onChange(plies.map((x, i) => (i === k ? { ...x, ...p } : x)));
  const move = (k: number, d: number) => { const r = [...plies]; [r[k], r[k + d]] = [r[k + d], r[k]]; onChange(r); };
  if (!plies.length) return <p class="field-hint">Sem camadas: acrescente-as abaixo, da base (lado do molde) para o topo.</p>;
  return (
    <>
      <table class="vars plies" aria-label={`Camadas (${id})`}>
        <thead><tr><th>#</th><th>Camada</th><th>t (mm)</th><th>θ (°)</th><th>E1 (MPa)</th><th /></tr></thead>
        <tbody>
          {plies.map((p, k) => (
            <tr key={k} class={orthoPlyError(p) ? "invalid" : ""} title={orthoPlyError(p) ?? `E1 ${Math.round(p.e1)}, E2 ${Math.round(p.e2)}, G12 ${Math.round(p.g12)} MPa, ν12 ${p.nu12.toFixed(3)}`}>
              <td>{k + 1}</td>
              <td class="ply-label">{p.label ?? "Ortotrópica"}</td>
              <td><input type="number" min="0.01" step="0.1" aria-label={`Espessura da camada ${k + 1}`} value={+p.t.toFixed(3)} onChange={(e) => set(k, { t: num(e) })} /></td>
              <td><input type="number" step="15" aria-label={`Ângulo da camada ${k + 1}`} value={p.theta} onChange={(e) => set(k, { theta: num(e) })} /></td>
              <td>{Math.round(p.e1)}</td>
              <td class="ply-actions">
                <button class="icon" aria-label={`Subir camada ${k + 1}`} disabled={k === plies.length - 1} onClick={() => move(k, 1)}>↑</button>
                <button class="icon" aria-label={`Descer camada ${k + 1}`} disabled={k === 0} onClick={() => move(k, -1)}>↓</button>
                <button class="icon" aria-label={`Retirar camada ${k + 1}`} onClick={() => onChange(plies.filter((_, i) => i !== k))}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="field-hint">{plies.length} camadas, espessura total {total(plies)} mm (a primeira linha é a base).</p>
    </>
  );
}

/** Laminado: as camadas comuns e as regiões de faces com laminado próprio. */
function LaminateEditor({ s, sh, up }: { s: FemStudy; sh: Shell; up: (p: Partial<FemStudy>) => void }) {
  const setShell = (p: Partial<Shell>) => up({ shell: { ...sh, ...p } });
  // o laminado precisa de S6 (ordem 2): acerta-se a malha ao pôr a primeira camada
  const withOrder = (shell: Shell): Partial<FemStudy> => ({ shell, ...(s.mesh.order !== 2 ? { mesh: { ...s.mesh, order: 2 } } : {}) });
  const plies = sh.plies ?? [];
  const regions = sh.regions ?? [];
  const setRegion = (i: number, r: Partial<Region>) => setShell({ regions: regions.map((x, k) => (k === i ? { ...x, ...r } : x)) });
  return (
    <>
      <PlyTable id="laminado" plies={plies} onChange={(p) => setShell({ plies: p.length ? p : undefined, ...(p.length ? { thickness: String(total(p)) } : {}) })} />
      <PlyAdder id="laminado" onAdd={(p) => up(withOrder({ ...sh, plies: [...plies, ...p], thickness: String(total([...plies, ...p])) }))} />
      {regions.map((r, i) => (
        <div class="kw-item" key={i}>
          <div class="row"><b>Região {i + 1}</b><button class="icon" aria-label={`Retirar região ${i + 1}`} onClick={() => setShell({ regions: regions.length > 1 ? regions.filter((_, k) => k !== i) : undefined })}>✕</button></div>
          <RefList field={`shellRegion${i}`} label="Faces" accept={["face"]} refs={r.faces} onChange={(faces) => setRegion(i, { faces })} />
          <PlyTable id={`região ${i + 1}`} plies={r.plies} onChange={(p) => setRegion(i, { plies: p })} />
          <PlyAdder id={`região ${i + 1}`} onAdd={(p) => up(withOrder({ ...sh, regions: regions.map((x, k) => (k === i ? { ...x, plies: [...x.plies, ...p] } : x)) }))} />
        </div>
      ))}
      <button class="small" onClick={() => setShell({ regions: [...regions, { faces: [], plies: [] }] })}>+ região de faces</button>
      {regions.length > 0 && <p class="field-hint">As faces de uma região usam o laminado dela; as restantes usam o laminado comum (ou a espessura uniforme). Cada face só pode estar numa região.</p>}
    </>
  );
}

export function ShellEditor({ s, up }: { s: FemStudy; up: (p: Partial<FemStudy>) => void }) {
  const sh = s.shell;
  const laminate = !!(sh?.plies?.length || sh?.regions?.length);
  return (
    <fieldset class="checklist shell-editor">
      <legend class="field-label">Casca</legend>
      <Check label="Casca de Mindlin na superfície média da chapa" value={!!sh} onChange={(on) => up({ shell: on ? { thickness: "5" } : undefined })} />
      {sh && <>
        {!sh.plies?.length && <ExprInput label="Espessura" value={sh.thickness} onChange={(thickness) => up({ shell: { ...sh, thickness: thickness ?? "" } })} />}
        <LaminateEditor s={s} sh={sh} up={up} />
        {laminate && s.analysis !== "static" && <p class="field-hint warn">O laminado só corre em análise estática nesta versão.</p>}
        <p class="field-hint">Só CalculiX. Laminado: camadas do anexo C da ISO 12215-5 (CLT), malha de ordem 2 (S6), índice de rotura por camada (extensão máxima, C.6) nos resultados.</p>
      </>}
    </fieldset>
  );
}

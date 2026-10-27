// Estado de uma feature (erros, avisos, informação) e propriedades de massa do corpo.
import type { FeatureStatus } from "../kernel/rebuild.ts";
import type { MassProps, SheetInfo } from "../kernel/protocol.ts";
import { useStore } from "./store.ts";

const fmt = (v: number, d = 2) => v.toLocaleString("pt-PT", { maximumFractionDigits: d, minimumFractionDigits: 0 });

export function StatusBlock({ status, title }: { status?: FeatureStatus; title?: string }) {
  if (!status) return null;
  return (
    <div class="status-block">
      {status.state === "error" && <p class="err" role="alert">✕ {status.error}</p>}
      {status.warnings.map((w, i) => <p key={i} class="warn">⚠ {w}</p>)}
      {status.info && (
        <div class="info">
          <h3>{status.info.title || title}</h3>
          <table>
            <tbody>{status.info.rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody>
          </table>
          {status.info.note && <p class="note">{status.info.note}</p>}
        </div>
      )}
    </div>
  );
}

export function MassBlock({ mass, density, onDensity }: { mass: MassProps | null; density: number; onDensity: (d: number) => void }) {
  if (!mass) return <p class="muted">Ainda não há corpo.</p>;
  const size = mass.bbox.max.map((v, i) => v - mass.bbox.min[i]);
  return (
    <div class="info">
      <h3>Propriedades de massa</h3>
      <table>
        <tbody>
          <tr><td>Volume</td><td>{fmt(mass.volume / 1000, 3)} cm³</td></tr>
          <tr><td>Área de superfície</td><td>{fmt(mass.area / 100, 2)} cm²</td></tr>
          <tr>
            <td>
              Massa (ρ <input class="tiny" type="number" step="0.01" value={density} aria-label="Massa volúmica em g/cm³" onInput={(e) => onDensity(Number((e.target as HTMLInputElement).value) || 0)} /> g/cm³)
            </td>
            <td>{fmt((mass.volume / 1000) * density, 2)} g</td>
          </tr>
          <tr><td>Centro de massa</td><td>{mass.center.map((v) => fmt(v, 2)).join(" · ")} mm</td></tr>
          <tr><td>Caixa envolvente</td><td>{size.map((v) => fmt(v, 2)).join(" × ")} mm</td></tr>
          <tr><td>Sólidos</td><td>{mass.solids}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/** Corpos de superfície do resultado (área e arestas livres: 0 = fechado, pronto a costurar em sólido). */
export function SheetsBlock({ sheets }: { sheets: SheetInfo[] }) {
  const st = useStore();
  if (!sheets.length) return null;
  const name = (id: string) => st.doc.features.find((f) => f.id === id)?.name ?? id;
  return (
    <div class="sheets">
      <h3>Corpos de superfície ({sheets.length})</h3>
      <table class="mass">
        <tbody>
          {sheets.map((s) => (
            <tr key={s.id}><td>{name(s.id)}</td><td>{fmt(s.area / 100, 2)} cm² · {s.faces} face(s) · {s.freeEdges ? `${s.freeEdges} aresta(s) livre(s)` : "fechado"}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

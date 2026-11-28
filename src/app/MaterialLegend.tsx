// Legenda dos materiais na vista 3D (C1c): uma linha por material, com a cor e o número de corpos.
import type { MaterialColors } from "./material-colors.ts";

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

export function MaterialLegend({ colors }: { colors: MaterialColors }) {
  if (!colors.legend.length) return null;
  return (
    <div class="load-legend" role="group" aria-label="Legenda dos materiais">
      <b>Materiais</b>
      <ul>
        {colors.legend.map((m) => (
          <li key={m.name} data-material={m.name} data-missing={m.missing ? "" : undefined}>
            <i class={m.missing ? "legend-missing" : undefined} style={{ background: hex(m.color) }} aria-hidden="true" />
            <span>{m.name}</span>
            <span class="load-legend-v">{m.bodies} {m.bodies === 1 ? "corpo" : "corpos"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

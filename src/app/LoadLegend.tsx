// Legenda das setas de carga na vista 3D (C1c): uma linha por carga, com a cor da seta e a intensidade.
import { useStoreKeys } from "./store.ts";
import { sectionView } from "./workflow.ts";
import { loadGlyphSpecs } from "./sim-actions.ts";
import { GLYPH_LABELS, glyphMagnitude } from "./load-glyphs.ts";

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

export function LoadLegend() {
  const st = useStoreKeys("workspace", "simStudy", "doc", "project", "active", "result", "asmResult", "simSection", "simShowAll");
  // Só onde as cargas estão nítidas: «Apoios e cargas», as secções sem camadas e «Ver tudo».
  const view = sectionView(st.simSection, st.simShowAll);
  if (view && !view.layers.includes("conditions")) return null;
  const glyphs = loadGlyphSpecs();
  if (!glyphs.length) return null;
  return (
    <div class="load-legend" role="group" aria-label="Legenda das cargas">
      <b>Cargas</b>
      <ul>
        {glyphs.map((g) => (
          <li key={g.index} data-load={g.index}>
            <i style={{ background: hex(g.color) }} aria-hidden="true" />
            <span>C{g.index + 1} {GLYPH_LABELS[g.kind]}</span>
            <span class="load-legend-v">{glyphMagnitude(g)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

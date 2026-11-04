// Painel de propriedades da feature em edição (equivalente ao PropertyManager).
import { useEffect } from "preact/hooks";
import type { Feature } from "../doc/types.ts";
import { FEATURE_LABELS, featureLabel } from "../doc/features.ts";
import { store, useStoreKeys } from "./store.ts";
import { HelpCard, helpForFeature } from "./featurehelp.tsx";
import { featureUi } from "./feature-ui.tsx";
import { Field } from "./forms.tsx";
import { StatusBlock } from "./InfoPanel.tsx";

export function PropertyPanel() {
  const st = useStoreKeys("edit", "result", "busy");
  const e = st.edit!;
  const f = e.draft;
  const up = (patch: Partial<Feature>) => store.updateDraft(patch);
  const before = e.index;
  const status = st.result?.status[f.id];

  // feature nova sem referências: ativar logo a seleção no 3D (como no SolidWorks)
  useEffect(() => {
    if (!e.isNew) return;
    if ((f.type === "fillet" || f.type === "chamfer") && !f.refs.length) store.set({ pickTarget: { field: "refs", accept: ["edge", "face"] } });
    if ((f.type === "shell" || f.type === "draft" || f.type === "offsetSurface" || f.type === "deleteFace") && !f.faces.length) store.set({ pickTarget: { field: "faces", accept: ["face"] } });
    if ((f.type === "fill" || f.type === "ruled" || f.type === "extrapolate") && !f.edges.length) store.set({ pickTarget: { field: "edges", accept: ["edge"] } });
    if ((f.type === "untrim" || f.type === "replaceFace") && !f.faces.length) store.set({ pickTarget: { field: "faces", accept: ["face"] } });
    // esboço com contornos sobrepostos: pedir logo as regiões (como no SolidWorks)
    if ((f.type === "extrude" || f.type === "revolve") && f.sketch && st.result?.sketches[f.sketch]?.profiles.errors.length) store.set({ pickTarget: { field: "regions", accept: ["region"] } });
  }, [e.id]);

  const Ui = featureUi(f.type);

  return (
    <div class="property-panel">
      <header>
        <h2>{e.isNew ? `Nova ${featureLabel(f).toLowerCase()}` : featureLabel(f)}</h2>
        <div class="actions">
          <button class="primary" onClick={() => store.confirmEdit()} disabled={st.busy && !st.result} title="Confirmar (Enter)">✓ OK</button>
          <button onClick={() => store.cancelEdit()} title="Cancelar (Esc)">✕</button>
        </div>
      </header>
      {helpForFeature(f) && <HelpCard h={helpForFeature(f)!} />}
      <Field label="Nome"><input value={f.name} onInput={(ev) => up({ name: (ev.target as HTMLInputElement).value })} /></Field>
      <Ui f={f} up={up} before={before} />
      <StatusBlock status={status} title={FEATURE_LABELS[f.type]} />
    </div>
  );
}

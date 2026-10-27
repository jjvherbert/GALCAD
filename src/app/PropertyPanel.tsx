// Painel de propriedades da feature em edição (equivalente ao PropertyManager).
import { useEffect } from "preact/hooks";
import type { BodyOp, Feature, HoleKind } from "../doc/types.ts";
import { FEATURE_LABELS, TOOL_FEATURES, featureLabel } from "../doc/features.ts";
import { METRIC_SIZES, METRIC } from "../doc/holes.ts";
import { PLUGINS } from "../plugins/meta.ts";
import { store, useStore } from "./store.ts";
import { AxisSelect, Check, EndEditor, ExprInput, FeatureChecklist, Field, PlaneSelect, PointList, RefList, RegionList, Select, SheetList, SketchSelect } from "./forms.tsx";
import { StatusBlock } from "./InfoPanel.tsx";

const OPS: [BodyOp, string][] = [["add", "Adicionar material"], ["cut", "Remover material (corte)"], ["intersect", "Intersetar"], ["new", "Corpo separado"]];
const fmt = (v: number) => v.toLocaleString("pt-PT", { maximumFractionDigits: 3 });

export function PropertyPanel() {
  const st = useStore();
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
    if (f.type === "fill" && !f.edges.length) store.set({ pickTarget: { field: "edges", accept: ["edge"] } });
    // esboço com contornos sobrepostos: pedir logo as regiões (como no SolidWorks)
    if ((f.type === "extrude" || f.type === "revolve") && f.sketch && st.result?.sketches[f.sketch]?.profiles.errors.length) store.set({ pickTarget: { field: "regions", accept: ["region"] } });
  }, [e.id]);

  let body;
  switch (f.type) {
    case "extrude":
      body = (
        <>
          <SketchSelect label="Esboço" value={f.sketch} before={before} onChange={(sketch) => up({ sketch, regions: undefined })} />
          {f.sketch && <RegionList sketch={f.sketch} value={f.regions} onChange={(regions) => up({ regions })} />}
          <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
          <EndEditor field="end1" label="Direção 1" value={f.end} onChange={(end) => end && up({ end })} />
          <Check label="Inverter direção" value={f.flip} onChange={(flip) => up({ flip })} />
          {f.end.type !== "midplane" && <EndEditor field="end2" label="Direção 2" optional allowMid={false} value={f.end2} onChange={(end2) => up({ end2 })} />}
          <ExprInput label="Ângulo de saída (inclinação)" unit="°" allowEmpty value={f.draft} onChange={(draft) => up({ draft })} />
        </>
      );
      break;
    case "revolve":
      body = (
        <>
          <SketchSelect label="Esboço" value={f.sketch} before={before} onChange={(sketch) => up({ sketch, regions: undefined })} />
          {f.sketch && <RegionList sketch={f.sketch} value={f.regions} onChange={(regions) => up({ regions })} />}
          <AxisSelect field="axis" label="Eixo de revolução" value={f.axis} before={before} sketch={f.sketch} onChange={(axis) => up({ axis })} />
          <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
          <ExprInput label="Ângulo" unit="°" value={f.angle} onChange={(angle) => up({ angle: angle ?? "" })} />
          <Check label="Simétrico ao plano do esboço" value={f.midplane} onChange={(midplane) => up({ midplane })} />
          <Check label="Inverter sentido" value={f.flip} onChange={(flip) => up({ flip })} />
        </>
      );
      break;
    case "sweep":
      body = (
        <>
          <SketchSelect label="Perfil (contorno fechado)" value={f.profile} before={before} onChange={(profile) => up({ profile })} />
          <SketchSelect label="Caminho" value={f.path} before={before} onChange={(path) => up({ path })} />
          <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
          <Select label="Orientação do perfil" value={f.orientation ?? "frenet"} options={[["frenet", "Segue o caminho"], ["fixed", "Constante"]]} onChange={(orientation) => up({ orientation })} />
        </>
      );
      break;
    case "loft":
      body = (
        <>
          <FeatureChecklist label="Secções (pela ordem de escolha)" ordered value={f.sections} before={before} types={["sketch"]} onChange={(sections) => up({ sections })} />
          <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
          <Check label="Regrado (faces retas entre secções)" value={f.ruled} onChange={(ruled) => up({ ruled })} />
        </>
      );
      break;
    case "hole": {
      const size = f.size ? METRIC[f.size] : undefined;
      body = (
        <>
          <SketchSelect label="Esboço com os pontos de centro" value={f.sketch} before={before} onChange={(sketch) => up({ sketch })} />
          <Select<HoleKind> label="Tipo" value={f.kind} options={[["clearance", "Passagem (folga para parafuso)"], ["tapped", "Roscado (broca + rosca cosmética)"], ["simple", "Simples (diâmetro livre)"]]} onChange={(kind) => up({ kind })} />
          {f.kind !== "simple" && <Select label="Rosca ISO métrica" value={f.size ?? "M6"} options={METRIC_SIZES.map((s) => [s, `${s} × ${METRIC[s].pitch}`])} onChange={(s) => up({ size: s })} />}
          {f.kind === "clearance" && <Select label="Ajuste (ISO 273)" value={f.fit ?? "normal"} options={[["close", `Fino (⌀${fmt(size?.clearance.close ?? 0)})`], ["normal", `Médio (⌀${fmt(size?.clearance.normal ?? 0)})`], ["loose", `Largo (⌀${fmt(size?.clearance.loose ?? 0)})`]]} onChange={(fit) => up({ fit })} />}
          {f.kind === "tapped" && size && <p class="field-hint">Broca ⌀{fmt(size.tapDrill)} mm (D − P)</p>}
          {f.kind === "simple" && <ExprInput label="Diâmetro" value={f.diameter} onChange={(diameter) => up({ diameter })} />}
          <Select label="Fim" value={f.end.type} options={[["throughAll", "Passante (através de tudo)"], ["blind", "Cego (profundidade)"]]} onChange={(t) => up({ end: t === "blind" ? { type: "blind", depth: 10 } : { type: "throughAll" } })} />
          {f.end.type === "blind" && (
            <>
              <ExprInput label="Profundidade" value={f.end.depth} onChange={(depth) => up({ end: { type: "blind", depth: depth ?? "" } })} />
              <ExprInput label="Ângulo da ponta (0 = fundo plano)" unit="°" allowEmpty value={f.tipAngle} onChange={(tipAngle) => up({ tipAngle })} />
              {f.kind === "tapped" && <ExprInput label="Comprimento roscado" allowEmpty value={f.threadDepth} onChange={(threadDepth) => up({ threadDepth })} />}
            </>
          )}
          {f.kind !== "tapped" && (
            <Select label="Cabeça" value={f.head ?? "none"} options={[["none", "Nenhuma"], ["counterbore", "Rebaixo (parafuso cilíndrico)"], ["countersink", "Escareado (parafuso de cabeça escareada)"]]} onChange={(head) => up({ head })} />
          )}
          {f.kind !== "tapped" && f.head && f.head !== "none" && (
            <>
              <ExprInput label="Diâmetro da cabeça (vazio = tabela)" allowEmpty value={f.headDiameter} onChange={(headDiameter) => up({ headDiameter })} />
              {f.head === "counterbore" ? <ExprInput label="Profundidade do rebaixo (vazio = tabela)" allowEmpty value={f.headDepth} onChange={(headDepth) => up({ headDepth })} />
                : <ExprInput label="Ângulo do escareado (vazio = 90°)" unit="°" allowEmpty value={f.headAngle} onChange={(headAngle) => up({ headAngle })} />}
            </>
          )}
          <Check label="Inverter direção" value={f.flip} onChange={(flip) => up({ flip })} />
          <p class="field-hint">Os furos são colocados nos pontos isolados do esboço (pontos que não são extremos de linhas nem de construção).</p>
        </>
      );
      break;
    }
    case "fillet":
      body = (
        <>
          <RefList field="refs" label="Arestas (uma face = todas as suas arestas)" accept={["edge", "face"]} refs={f.refs} onChange={(refs) => up({ refs })} />
          <ExprInput label="Raio" value={f.radius} onChange={(radius) => up({ radius: radius ?? "" })} />
        </>
      );
      break;
    case "chamfer":
      body = (
        <>
          <RefList field="refs" label="Arestas" accept={["edge", "face"]} refs={f.refs} onChange={(refs) => up({ refs })} />
          <ExprInput label="Distância" value={f.distance} onChange={(distance) => up({ distance: distance ?? "" })} />
          <ExprInput label="Distância 2 (vazio = igual)" allowEmpty value={f.distance2} onChange={(distance2) => up({ distance2 })} />
        </>
      );
      break;
    case "shell":
      body = (
        <>
          <RefList field="faces" label="Faces a remover (abertas)" accept={["face"]} refs={f.faces} onChange={(faces) => up({ faces })} />
          <ExprInput label="Espessura" value={f.thickness} onChange={(thickness) => up({ thickness: thickness ?? "" })} />
          <Check label="Espessura para fora" value={f.outward} onChange={(outward) => up({ outward })} />
        </>
      );
      break;
    case "draft":
      body = (
        <>
          <RefList field="faces" label="Faces a inclinar" accept={["face"]} refs={f.faces} onChange={(faces) => up({ faces })} />
          <PlaneSelect field="neutral" label="Plano neutro" value={f.neutral} before={before} onChange={(neutral) => up({ neutral })} />
          <ExprInput label="Ângulo" unit="°" value={f.angle} onChange={(angle) => up({ angle: angle ?? "" })} />
          <Check label="Inverter direção de extração" value={f.flip} onChange={(flip) => up({ flip })} />
        </>
      );
      break;
    case "rib":
      body = (
        <>
          <SketchSelect label="Esboço (contorno aberto)" value={f.sketch} before={before} onChange={(sketch) => up({ sketch })} />
          <ExprInput label="Espessura" value={f.thickness} onChange={(thickness) => up({ thickness: thickness ?? "" })} />
          <Check label="Preferir o outro lado" value={f.flip} onChange={(flip) => up({ flip })} />
        </>
      );
      break;
    case "linearPattern":
      body = (
        <>
          <FeatureChecklist label="Features a repetir (nenhuma = corpo inteiro)" value={f.features} before={before} types={[...TOOL_FEATURES, "linearPattern", "circularPattern", "mirror"]} onChange={(features) => up({ features })} />
          <AxisSelect field="dir1" label="Direção 1" value={f.direction} before={before} onChange={(direction) => up({ direction })} />
          <ExprInput label="Instâncias" unit="" value={f.count} onChange={(count) => up({ count: count ?? "" })} />
          <ExprInput label="Espaçamento" value={f.spacing} onChange={(spacing) => up({ spacing: spacing ?? "" })} />
          <Check label="Inverter direção 1" value={f.flip} onChange={(flip) => up({ flip })} />
          <Check label="Segunda direção" value={!!f.direction2} onChange={(on) => up(on ? { direction2: { kind: "std", name: "Y" }, count2: 2, spacing2: 20 } : { direction2: undefined })} />
          {f.direction2 && (
            <>
              <AxisSelect field="dir2" label="Direção 2" value={f.direction2} before={before} onChange={(direction2) => up({ direction2 })} />
              <ExprInput label="Instâncias (direção 2)" unit="" value={f.count2} onChange={(count2) => up({ count2 })} />
              <ExprInput label="Espaçamento (direção 2)" value={f.spacing2} onChange={(spacing2) => up({ spacing2 })} />
              <Check label="Inverter direção 2" value={f.flip2} onChange={(flip2) => up({ flip2 })} />
            </>
          )}
        </>
      );
      break;
    case "circularPattern":
      body = (
        <>
          <FeatureChecklist label="Features a repetir (nenhuma = corpo inteiro)" value={f.features} before={before} types={[...TOOL_FEATURES, "linearPattern", "circularPattern", "mirror"]} onChange={(features) => up({ features })} />
          <AxisSelect field="axis" label="Eixo" value={f.axis} before={before} onChange={(axis) => up({ axis })} />
          <ExprInput label="Instâncias" unit="" value={f.count} onChange={(count) => up({ count: count ?? "" })} />
          <ExprInput label="Ângulo total" unit="°" value={f.angle} onChange={(angle) => up({ angle: angle ?? "" })} />
        </>
      );
      break;
    case "mirror":
      body = (
        <>
          <FeatureChecklist label="Features a espelhar (nenhuma = corpo inteiro)" value={f.features} before={before} types={[...TOOL_FEATURES, "linearPattern", "circularPattern", "mirror"]} onChange={(features) => up({ features })} />
          <PlaneSelect field="plane" label="Plano de espelho" value={f.plane} before={before} onChange={(plane) => up({ plane })} />
        </>
      );
      break;
    case "plane":
      body = (
        <>
          <PlaneSelect field="base" label="Plano ou face de referência" value={f.base} before={before} onChange={(base) => up({ base })} />
          <ExprInput label="Distância" value={f.offset} onChange={(offset) => up({ offset: offset ?? 0 })} />
          <ExprInput label="Ângulo (opcional)" unit="°" allowEmpty value={f.angle} onChange={(angle) => up({ angle })} />
          {f.angle !== undefined && f.angle !== "" && <AxisSelect field="axis" label="Eixo de rotação" value={f.axis ?? { kind: "std", name: "X" }} before={before} onChange={(axis) => up({ axis })} />}
          <Check label="Inverter normal" value={f.flip} onChange={(flip) => up({ flip })} />
        </>
      );
      break;
    case "axis":
      body = (
        <>
          <Select label="Definição" value={f.mode} options={[["twoPlanes", "Interseção de dois planos"], ["edge", "Aresta reta ou circular"], ["twoPoints", "Dois pontos"]]} onChange={(mode) => up({ mode })} />
          {f.mode === "twoPlanes" && (
            <>
              <PlaneSelect field="p1" label="Plano 1" value={f.planes?.[0] ?? { kind: "std", name: "XZ" }} before={before} onChange={(p) => up({ planes: [p, f.planes?.[1] ?? { kind: "std", name: "YZ" }] })} />
              <PlaneSelect field="p2" label="Plano 2" value={f.planes?.[1] ?? { kind: "std", name: "YZ" }} before={before} onChange={(p) => up({ planes: [f.planes?.[0] ?? { kind: "std", name: "XZ" }, p] })} />
            </>
          )}
          {f.mode === "edge" && <RefList field="edge" label="Aresta" accept={["edge"]} single refs={f.edge ? [f.edge] : []} onChange={(r) => up({ edge: r[0] })} />}
          {f.mode === "twoPoints" && (["Ponto 1", "Ponto 2"] as const).map((lbl, i) => (
            <div class="row3" key={lbl}>
              {[0, 1, 2].map((k) => (
                <ExprInput key={k} label={`${lbl} ${"XYZ"[k]}`} value={(f.points ?? [[0, 0, 0], [0, 0, 1]])[i][k]} onChange={(val) => {
                  const pts = structuredClone(f.points ?? [[0, 0, 0], [0, 0, 1]]) as [number, number, number][];
                  pts[i][k] = Number(val) || 0;
                  up({ points: pts as never });
                }} />
              ))}
            </div>
          ))}
        </>
      );
      break;
    case "csys":
      body = (
        <>
          <div class="row3">{[0, 1, 2].map((k) => <ExprInput key={k} label={`Origem ${"XYZ"[k]}`} value={f.origin[k]} onChange={(val) => { const o = [...f.origin] as typeof f.origin; o[k] = val ?? 0; up({ origin: o }); }} />)}</div>
          <div class="row3">{[0, 1, 2].map((k) => <ExprInput key={k} unit="°" label={`Rotação ${"XYZ"[k]}`} value={f.rotation[k]} onChange={(val) => { const o = [...f.rotation] as typeof f.rotation; o[k] = val ?? 0; up({ rotation: o }); }} />)}</div>
        </>
      );
      break;
    case "import":
      body = (
        <>
          <Field label="Ficheiro"><input value={f.fileName} readOnly /></Field>
          <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
        </>
      );
      break;
    case "plugin": {
      const p = PLUGINS.find((x) => x.id === f.plugin);
      const kind = p?.kinds[f.kind];
      body = (
        <>
          <p class="muted">{p?.name} · {kind?.label}</p>
          {kind && Object.entries(kind.params).map(([k, d]) => (
            <ExprInput key={k} label={d.label} unit={d.unit ?? ""} value={f.params[k]} onChange={(val) => up({ params: { ...f.params, [k]: val ?? d.value } })} />
          ))}
          <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
        </>
      );
      break;
    }
    case "surfaceExtrude":
      body = (
        <>
          <SketchSelect label="Esboço (contornos abertos ou fechados)" value={f.sketch} before={before} onChange={(sketch) => up({ sketch })} />
          <Select label="Fim" value={f.end.type} options={[["blind", "Cega (profundidade)"], ["midplane", "Plano médio"]]} onChange={(t) => up({ end: { type: t, depth: f.end.depth } })} />
          <ExprInput label="Profundidade" value={f.end.depth} onChange={(depth) => up({ end: { type: f.end.type, depth: depth ?? "" } })} />
          <Check label="Inverter direção" value={f.flip} onChange={(flip) => up({ flip })} />
        </>
      );
      break;
    case "surfaceRevolve":
      body = (
        <>
          <SketchSelect label="Esboço" value={f.sketch} before={before} onChange={(sketch) => up({ sketch })} />
          <AxisSelect field="axis" label="Eixo de revolução" value={f.axis} before={before} sketch={f.sketch} onChange={(axis) => up({ axis })} />
          <ExprInput label="Ângulo" unit="°" value={f.angle} onChange={(angle) => up({ angle: angle ?? "" })} />
          <Check label="Simétrico ao plano do esboço" value={f.midplane} onChange={(midplane) => up({ midplane })} />
        </>
      );
      break;
    case "surfaceSweep":
      body = (
        <>
          <SketchSelect label="Perfil (aberto ou fechado)" value={f.profile} before={before} onChange={(profile) => up({ profile })} />
          <SketchSelect label="Caminho" value={f.path} before={before} onChange={(path) => up({ path })} />
          <Select label="Orientação do perfil" value={f.orientation ?? "frenet"} options={[["frenet", "Segue o caminho"], ["fixed", "Constante"]]} onChange={(orientation) => up({ orientation })} />
        </>
      );
      break;
    case "surfaceLoft":
      body = (
        <>
          <FeatureChecklist label="Secções (pela ordem de escolha)" ordered value={f.sections} before={before} types={["sketch"]} onChange={(sections) => up({ sections })} />
          <Check label="Regrado (faces retas entre secções)" value={f.ruled} onChange={(ruled) => up({ ruled })} />
        </>
      );
      break;
    case "fill":
      body = (
        <>
          <RefList field="edges" label="Arestas do contorno (fechado)" accept={["edge"]} refs={f.edges} onChange={(edges) => up({ edges })} />
          <Select label="Continuidade com as faces vizinhas" value={f.continuity} options={[["contact", "Contacto (G0)"], ["tangent", "Tangente (G1)"], ["curvature", "Curvatura (G2)"]]} onChange={(continuity) => up({ continuity })} />
          <p class="field-hint">Tangente/curvatura usam a face vizinha de cada aresta. Com faces quase perpendiculares ao preenchimento a continuidade pode não ser cumprida: confirme com as riscas de zebra.</p>
        </>
      );
      break;
    case "offsetSurface":
      body = (
        <>
          <RefList field="faces" label="Faces a deslocar" accept={["face"]} refs={f.faces} onChange={(faces) => up({ faces })} />
          <ExprInput label="Distância (negativa = sentido oposto à normal)" value={f.distance} onChange={(distance) => up({ distance: distance ?? "" })} />
        </>
      );
      break;
    case "knit":
      body = (
        <>
          <SheetList field="sheets" label="Corpos de superfície" value={f.sheets} before={before} onChange={(sheets) => up({ sheets })} />
          <ExprInput label="Tolerância de costura" allowEmpty value={f.tolerance} onChange={(tolerance) => up({ tolerance })} />
          <Check label="Criar sólido (se fechar um volume)" value={f.makeSolid} onChange={(makeSolid) => up({ makeSolid })} />
          {f.makeSolid && <Select label="Operação" value={f.op ?? "add"} options={OPS} onChange={(op) => up({ op })} />}
        </>
      );
      break;
    case "thicken":
      body = (
        <>
          <SheetList field="sheet" single label="Corpo de superfície" value={f.sheet ? [f.sheet] : []} before={before} onChange={([sheet]) => up({ sheet: sheet ?? "" })} />
          <ExprInput label="Espessura" value={f.thickness} onChange={(thickness) => up({ thickness: thickness ?? "" })} />
          <Select label="Lado" value={f.side} options={[["front", "Na direção da normal"], ["back", "Oposto à normal"], ["both", "Dos dois lados (simétrico)"]]} onChange={(side) => up({ side })} />
          <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
        </>
      );
      break;
    case "trimSurface": {
      const t = f.tool;
      body = (
        <>
          <SheetList field="sheet" single label="Superfície a aparar" value={f.sheet ? [f.sheet] : []} before={before} onChange={([sheet]) => up({ sheet: sheet ?? "" })} />
          <Select label="Ferramenta" value={t.kind} options={[["plane", "Plano"], ["sheet", "Outra superfície"], ["sketch", "Esboço (projetado na normal)"]]}
            onChange={(kind) => up({ tool: kind === "plane" ? { kind, plane: { kind: "std", name: "XY" } } : kind === "sheet" ? { kind, sheet: "" } : { kind, sketch: "" } })} />
          {t.kind === "plane" && <PlaneSelect field="toolPlane" label="Plano de corte" value={t.plane} before={before} onChange={(plane) => up({ tool: { kind: "plane", plane } })} />}
          {t.kind === "sheet" && <SheetList field="toolSheet" single label="Superfície de corte" value={t.sheet ? [t.sheet] : []} before={before} exclude={[f.sheet]} onChange={([sheet]) => up({ tool: { kind: "sheet", sheet: sheet ?? "" } })} />}
          {t.kind === "sketch" && <SketchSelect label="Esboço de corte" value={t.sketch} before={before} onChange={(sketch) => up({ tool: { kind: "sketch", sketch } })} />}
          <PointList field="keep" label="Partes a manter" value={f.keep} onChange={(keep) => up({ keep })} />
        </>
      );
      break;
    }
    case "deleteFace":
      body = (
        <>
          <RefList field="faces" label="Faces a apagar" accept={["face"]} refs={f.faces} onChange={(faces) => up({ faces })} />
          <p class="field-hint">O sólido com faces apagadas passa a corpo de superfície aberto (para refazer a zona com superfícies e costurar de novo).</p>
        </>
      );
      break;
    default:
      body = <p>Sem propriedades.</p>;
  }

  return (
    <div class="property-panel">
      <header>
        <h2>{e.isNew ? `Nova ${featureLabel(f).toLowerCase()}` : featureLabel(f)}</h2>
        <div class="actions">
          <button class="primary" onClick={() => store.confirmEdit()} disabled={st.busy && !st.result} title="Confirmar (Enter)">✓ OK</button>
          <button onClick={() => store.cancelEdit()} title="Cancelar (Esc)">✕</button>
        </div>
      </header>
      <Field label="Nome"><input value={f.name} onInput={(ev) => up({ name: (ev.target as HTMLInputElement).value })} /></Field>
      {body}
      <StatusBlock status={status} title={FEATURE_LABELS[f.type]} />
    </div>
  );
}

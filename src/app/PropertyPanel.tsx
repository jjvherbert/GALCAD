// Painel de propriedades da feature em edição (equivalente ao PropertyManager).
import { useEffect } from "preact/hooks";
import type { BlendSide, BodyOp, Continuity, CurveDef, Feature, HoleKind, SectionTangent } from "../doc/types.ts";
import { FEATURE_LABELS, SHEET_SOURCES, TOOL_FEATURES, featureLabel } from "../doc/features.ts";
import { METRIC_SIZES, METRIC } from "../doc/holes.ts";
import { PLUGINS } from "../plugins/meta.ts";
import { store, useStore } from "./store.ts";
import { AxisSelect, Check, CurveList, EndEditor, ExprInput, FeatureChecklist, Field, PathSelect, PlaneSelect, PointList, PointsEditor, RefList, RegionList, Select, SheetList, SketchSelect, SweepOptionsEditor, TargetEditor } from "./forms.tsx";
import { StatusBlock } from "./InfoPanel.tsx";

const OPS: [BodyOp, string][] = [["add", "Adicionar material"], ["cut", "Remover material (corte)"], ["intersect", "Intersetar"], ["new", "Corpo separado"]];
const fmt = (v: number) => v.toLocaleString("pt-PT", { maximumFractionDigits: 3 });
const CONT: [Continuity, string][] = [["contact", "Contacto (G0)"], ["tangent", "Tangente (G1)"], ["curvature", "Curvatura (G2)"]];
const CURVE_KINDS: [CurveDef["kind"], string][] = [["points", "Spline por pontos"], ["projected", "Esboço projetado em faces"], ["intersection", "Interseção de superfícies"], ["composite", "Curva composta (arestas)"], ["helix", "Hélice"], ["extend", "Curva prolongada (extrapolar)"]];

/** Tangência de um extremo da multi-secção (face de suporte, tensão, inverter). */
function TangentEditor({ field, label, value, onChange }: { field: string; label: string; value: SectionTangent | undefined; onChange: (v: SectionTangent | undefined) => void }) {
  return (
    <fieldset class="checklist">
      <legend class="field-label">{label}</legend>
      <RefList field={field} single label="Face de suporte (vazio = sem tangência)" accept={["face"]} refs={value ? [value.face] : []} onChange={(r) => onChange(r[0] ? { ...value, face: r[0] } : undefined)} />
      {value && (
        <>
          <ExprInput label="Tensão" unit="" allowEmpty value={value.weight} onChange={(weight) => onChange({ ...value, weight })} />
          <Check label="Inverter sentido" value={value.flip} onChange={(flip) => onChange({ ...value, flip })} />
        </>
      )}
    </fieldset>
  );
}

/** Um lado da concordância. */
function BlendSideEditor({ field, label, value, onChange, before }: { field: string; label: string; value: BlendSide; onChange: (v: BlendSide) => void; before: number }) {
  return (
    <fieldset class="checklist">
      <legend class="field-label">{label}</legend>
      <CurveList field={`${field}.curve`} single label="Curva" value={[value.curve]} before={before} onChange={([curve]) => onChange({ ...value, curve })} />
      <RefList field={`${field}.support`} single label="Face de suporte (por defeito, a da aresta)" accept={["face"]} refs={value.support ? [value.support] : []} onChange={(r) => onChange({ ...value, support: r[0] })} />
      <Select<Continuity> label="Continuidade" value={value.continuity} options={CONT} onChange={(continuity) => onChange({ ...value, continuity })} />
      {value.continuity !== "contact" && <ExprInput label="Tensão" unit="" allowEmpty value={value.tension} onChange={(tension) => onChange({ ...value, tension })} />}
      {value.continuity !== "contact" && <Check label="Inverter sentido de saída" value={value.flip} onChange={(flip) => onChange({ ...value, flip })} />}
    </fieldset>
  );
}

function newCurveDef(kind: CurveDef["kind"]): CurveDef {
  switch (kind) {
    case "points": return { kind, points: [[0, 0, 0], [50, 20, 10], [100, 0, 0]] };
    case "projected": return { kind, sketch: "", onto: { kind: "faces", faces: [] } };
    case "intersection": return { kind, a: { kind: "sheet", sheet: "" }, b: { kind: "plane", plane: { kind: "std", name: "XY" } } };
    case "composite": return { kind, edges: [] };
    case "helix": return { kind, axis: { kind: "std", name: "Z" }, radius: 10, pitch: 5, height: 30 };
    case "extend": return { kind, curve: { kind: "curve", feature: "" }, end: 10, continuity: "tangent" };
  }
}

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
    if ((f.type === "fill" || f.type === "ruled" || f.type === "extrapolate") && !f.edges.length) store.set({ pickTarget: { field: "edges", accept: ["edge"] } });
    if ((f.type === "untrim" || f.type === "replaceFace") && !f.faces.length) store.set({ pickTarget: { field: "faces", accept: ["face"] } });
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
          <PathSelect label="Caminho (esboço ou curva 3D)" value={f.path} before={before} onChange={(path) => up({ path })} />
          <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
          <SweepOptionsEditor value={f} before={before} onChange={up} />
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
          <FeatureChecklist label="Features ou superfícies a repetir (nenhuma = corpo inteiro)" value={f.features} before={before} types={[...TOOL_FEATURES, ...SHEET_SOURCES]} onChange={(features) => up({ features })} />
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
          <FeatureChecklist label="Features ou superfícies a repetir (nenhuma = corpo inteiro)" value={f.features} before={before} types={[...TOOL_FEATURES, ...SHEET_SOURCES]} onChange={(features) => up({ features })} />
          <AxisSelect field="axis" label="Eixo" value={f.axis} before={before} onChange={(axis) => up({ axis })} />
          <ExprInput label="Instâncias" unit="" value={f.count} onChange={(count) => up({ count: count ?? "" })} />
          <ExprInput label="Ângulo total" unit="°" value={f.angle} onChange={(angle) => up({ angle: angle ?? "" })} />
        </>
      );
      break;
    case "mirror":
      body = (
        <>
          <FeatureChecklist label="Features ou superfícies a espelhar (nenhuma = corpo inteiro)" value={f.features} before={before} types={[...TOOL_FEATURES, ...SHEET_SOURCES]} onChange={(features) => up({ features })} />
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
          <PathSelect label="Caminho (esboço ou curva 3D)" value={f.path} before={before} onChange={(path) => up({ path })} />
          <SweepOptionsEditor value={f} before={before} onChange={up} />
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
          <Select label="Continuidade com as faces vizinhas" value={f.continuity} options={CONT} onChange={(continuity) => up({ continuity })} />
          <p class="field-hint">Tangente/curvatura usam a face vizinha de cada aresta. O desvio de tangência é medido no fim e há aviso acima de 1°.</p>
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
          {!f.makeSolid && (
            <>
              <Check label="Verificar ligação (erro se ficar em partes)" value={f.checkConnected} onChange={(checkConnected) => up({ checkConnected })} />
              <Check label="Verificar tangência (erro acima de 0,5°)" value={f.checkTangency} onChange={(checkTangency) => up({ checkTangency })} />
              <Check label="Simplificar (unir faces da mesma superfície)" value={f.simplify} onChange={(simplify) => up({ simplify })} />
            </>
          )}
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
          {t.kind === "sheet" && <Check label="Aparar mútuo (as duas aparam-se e ficam costuradas)" value={f.mutual} onChange={(mutual) => up({ mutual })} />}
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
          <Select label="Modo" value={f.mode ?? "delete"} options={[["delete", "Apagar (o sólido passa a superfície)"], ["patch", "Apagar e remendar (o sólido mantém-se)"]]} onChange={(mode) => up({ mode })} />
          {f.mode === "patch" && <Select<Continuity> label="Continuidade do remendo" value={f.continuity ?? "tangent"} options={CONT} onChange={(continuity) => up({ continuity })} />}
          <p class="field-hint">{f.mode === "patch" ? "Cada buraco é preenchido com uma placa e o resultado é costurado de novo num sólido. Não prolonga as faces vizinhas (não reconstrói cantos vivos)." : "O sólido com faces apagadas passa a corpo de superfície aberto (para refazer a zona com superfícies e costurar de novo)."}</p>
        </>
      );
      break;
    case "curve": {
      const c = f.def;
      const set = (def: CurveDef) => up({ def });
      body = (
        <>
          <Select label="Tipo de curva" value={c.kind} options={CURVE_KINDS} onChange={(k) => set(newCurveDef(k))} />
          {c.kind === "points" && (
            <>
              <PointsEditor value={c.points} onChange={(points) => set({ ...c, points })} />
              <Check label="Fechada" value={c.closed} onChange={(closed) => set({ ...c, closed })} />
            </>
          )}
          {c.kind === "projected" && (
            <>
              <SketchSelect label="Esboço a projetar" value={c.sketch} before={before} onChange={(sketch) => set({ ...c, sketch })} />
              <TargetEditor field="onto" label="Projetar em" value={c.onto} before={before} onChange={(onto) => set({ ...c, onto })} />
              <p class="field-hint">Projeção segundo a normal do plano do esboço.</p>
            </>
          )}
          {c.kind === "intersection" && (
            <>
              <TargetEditor field="ta" label="Superfície A" value={c.a} before={before} onChange={(a) => set({ ...c, a })} />
              <TargetEditor field="tb" label="Superfície B" value={c.b} before={before} onChange={(b) => set({ ...c, b })} />
            </>
          )}
          {c.kind === "composite" && <RefList field="edges" label="Arestas (encadeadas)" accept={["edge"]} refs={c.edges} onChange={(edges) => set({ ...c, edges })} />}
          {c.kind === "helix" && (
            <>
              <AxisSelect field="axis" label="Eixo" value={c.axis} before={before} onChange={(axis) => set({ ...c, axis })} />
              <ExprInput label="Raio" value={c.radius} onChange={(radius) => set({ ...c, radius: radius ?? "" })} />
              <ExprInput label="Passo" value={c.pitch} onChange={(pitch) => set({ ...c, pitch: pitch ?? "" })} />
              <ExprInput label="Altura" value={c.height} onChange={(height) => set({ ...c, height: height ?? "" })} />
              <ExprInput label="Ângulo inicial" unit="°" allowEmpty value={c.startAngle} onChange={(startAngle) => set({ ...c, startAngle })} />
              <Check label="Esquerda (anti-horária)" value={c.lefthand} onChange={(lefthand) => set({ ...c, lefthand })} />
            </>
          )}
          {c.kind === "extend" && (
            <>
              <CurveList field="extend" single label="Curva a prolongar" value={[c.curve]} before={before} onChange={([curve]) => set({ ...c, curve })} />
              <ExprInput label="Prolongamento no início" allowEmpty value={c.start} onChange={(start) => set({ ...c, start })} />
              <ExprInput label="Prolongamento no fim" allowEmpty value={c.end} onChange={(end) => set({ ...c, end })} />
              <Select label="Continuidade" value={c.continuity ?? "tangent"} options={[["tangent", "Tangente (reta)"], ["curvature", "Curvatura (parábola osculadora)"]]} onChange={(continuity) => set({ ...c, continuity })} />
            </>
          )}
          <p class="field-hint">As curvas 3D servem de caminho de varrimento, limites de superfícies e arestas de referência.</p>
        </>
      );
      break;
    }
    case "boundary":
      body = (
        <>
          <CurveList field="dir1" label="Direção 1 (≥ 2 curvas, por ordem)" value={f.dir1} before={before} onChange={(dir1) => up({ dir1 })} />
          <Select<Continuity> label="Continuidade nos limites da direção 1" value={f.cont1 ?? "contact"} options={CONT} onChange={(cont1) => up({ cont1 })} />
          <CurveList field="dir2" label="Direção 2 (0 ou ≥ 2 curvas)" value={f.dir2} before={before} onChange={(dir2) => up({ dir2 })} />
          <Select<Continuity> label="Continuidade nos limites da direção 2" value={f.cont2 ?? "contact"} options={CONT} onChange={(cont2) => up({ cont2 })} />
          <p class="field-hint">Com as duas direções, a primeira e a última curva de cada uma fecham o contorno e as do meio guiam a forma. A tangência/curvatura aplica-se a curvas que são arestas de faces existentes.</p>
        </>
      );
      break;
    case "ruled":
      body = (
        <>
          <RefList field="edges" label="Arestas" accept={["edge"]} refs={f.edges} onChange={(edges) => up({ edges })} />
          <Select label="Tipo" value={f.mode} options={[["normal", "Normal à superfície"], ["tangent", "Tangente à superfície"], ["angle", "A um ângulo da superfície"], ["direction", "Numa direção"]]} onChange={(mode) => up({ mode })} />
          {f.mode === "angle" && <ExprInput label="Ângulo (0° tangente, 90° normal)" unit="°" allowEmpty value={f.angle} onChange={(angle) => up({ angle })} />}
          {f.mode !== "direction" && <RefList field="face" single label="Face de referência (necessária em arestas entre duas faces)" accept={["face"]} refs={f.face ? [f.face] : []} onChange={(r) => up({ face: r[0] })} />}
          {f.mode === "direction" && <AxisSelect field="direction" label="Direção" value={f.direction ?? { kind: "std", name: "Z" }} before={before} onChange={(direction) => up({ direction })} />}
          <ExprInput label="Distância" value={f.distance} onChange={(distance) => up({ distance: distance ?? "" })} />
          <Check label="Inverter" value={f.flip} onChange={(flip) => up({ flip })} />
        </>
      );
      break;
    case "untrim":
      body = (
        <>
          <RefList field="faces" label="Faces a desaparar" accept={["face"]} refs={f.faces} onChange={(faces) => up({ faces })} />
          <p class="field-hint">A face volta aos limites naturais da superfície; nas superfícies infinitas (plano, cilindro em altura) fica a caixa UV da face, sem furos nem recortes.</p>
        </>
      );
      break;
    case "replaceFace":
      body = (
        <>
          <RefList field="faces" label="Faces do sólido a substituir" accept={["face"]} refs={f.faces} onChange={(faces) => up({ faces })} />
          <SheetList field="sheet" single label="Superfície de substituição" value={f.sheet ? [f.sheet] : []} before={before} onChange={([sheet]) => up({ sheet: sheet ?? "" })} />
          <p class="field-hint">O sólido estende-se ou apara-se até à superfície, que tem de cobrir toda a face. Pressupõe faces laterais aproximadamente paralelas à normal da face substituída.</p>
        </>
      );
      break;
    case "multiSection":
      body = (
        <>
          <CurveList field="sections" label="Secções (por ordem)" value={f.sections} before={before} onChange={(sections) => up({ sections })} />
          <CurveList field="guides" label="Guias (opcional; cortam todas as secções)" value={f.guides ?? []} before={before} onChange={(guides) => up({ guides })} />
          <CurveList field="spine" single label="Spine (opcional, sem guias)" value={f.spine ? [f.spine] : []} before={before} onChange={([spine]) => up({ spine })} />
          {f.spine && <button class="small" onClick={() => up({ spine: undefined })}>Retirar spine</button>}
          <TangentEditor field="startTangent" label="Tangência na primeira secção" value={f.startTangent} onChange={(startTangent) => up({ startTangent })} />
          <TangentEditor field="endTangent" label="Tangência na última secção" value={f.endTangent} onChange={(endTangent) => up({ endTangent })} />
          <p class="field-hint">Com guias, a superfície passa exatamente pelas secções e pelas guias (superfície de Gordon). Sem guias nem tangências é um loft suave do OCC; a tangência pedida é medida no fim.</p>
        </>
      );
      break;
    case "blend":
      body = (
        <>
          <BlendSideEditor field="side1" label="Lado 1" value={f.side1} before={before} onChange={(side1) => up({ side1 })} />
          <BlendSideEditor field="side2" label="Lado 2" value={f.side2} before={before} onChange={(side2) => up({ side2 })} />
          <p class="field-hint">G1: Hermite cúbica; G2: quíntica com a curvatura normal das faces de suporte. A tensão escala as tangentes (1 = corda entre as curvas).</p>
        </>
      );
      break;
    case "circleSweep":
      body = (
        <>
          <Select label="Modo" value={f.mode} options={[["threeGuides", "Três guias"], ["twoGuidesRadius", "Duas guias e raio"], ["centerRadius", "Centro e raio (tubo)"]]} onChange={(mode) => up({ mode })} />
          <CurveList field="guides" label={f.mode === "centerRadius" ? "Curva central" : "Guias (por ordem)"} value={f.guides} before={before} onChange={(guides) => up({ guides })} />
          {f.mode !== "threeGuides" && <ExprInput label="Raio" value={f.radius} onChange={(radius) => up({ radius: radius ?? "" })} />}
          {f.mode === "twoGuidesRadius" && <Check label="Outra solução (centro do outro lado)" value={f.flip} onChange={(flip) => up({ flip })} />}
          {f.mode === "twoGuidesRadius" && <Check label="Arco maior" value={f.long} onChange={(long) => up({ long })} />}
        </>
      );
      break;
    case "extrapolate":
      body = (
        <>
          <SheetList field="sheet" single label="Corpo de superfície" value={f.sheet ? [f.sheet] : []} before={before} onChange={([sheet]) => up({ sheet: sheet ?? "" })} />
          <RefList field="edges" label="Arestas livres a prolongar" accept={["edge"]} refs={f.edges} onChange={(edges) => up({ edges })} />
          <ExprInput label="Comprimento" value={f.length} onChange={(length) => up({ length: length ?? "" })} />
          <Select label="Continuidade" value={f.continuity} options={[["tangent", "Tangente (G1, regrada)"], ["curvature", "Curvatura (G2)"]]} onChange={(continuity) => up({ continuity })} />
          <Check label="Juntar ao corpo" value={f.assemble !== false} onChange={(assemble) => up({ assemble })} />
        </>
      );
      break;
    case "heal":
      body = (
        <>
          <SheetList field="sheets" label="Corpos de superfície a curar" value={f.sheets} before={before} onChange={(sheets) => up({ sheets })} />
          <ExprInput label="Distância de fusão (folgas a fechar)" value={f.distance} onChange={(distance) => up({ distance: distance ?? "" })} />
          <ExprInput label="Ângulo para assinalar quase-tangência" unit="°" allowEmpty value={f.tangency} onChange={(tangency) => up({ tangency })} />
          <Check label="Simplificar (unir faces da mesma superfície)" value={f.simplify} onChange={(simplify) => up({ simplify })} />
          <p class="field-hint">Fecha folgas, corrige as faces (ShapeFix) e costura. As arestas quase tangentes são só assinaladas: a cura não deforma as superfícies.</p>
        </>
      );
      break;
    case "freeform": {
      const src = f.source;
      const net = status?.net;
      const sel = st.poleSel && net && st.poleSel[0] < net.nu && st.poleSel[1] < net.nv ? st.poleSel : null;
      const mv = sel ? f.moves.find((m) => m.i === sel[0] && m.j === sel[1]) : undefined;
      const d = mv?.d ?? [0, 0, 0];
      body = (
        <>
          <Select label="Origem" value={src.kind} options={[["patch", "Patch novo num plano"], ["face", "Converter uma face"]]}
            onChange={(kind) => up({ source: kind === "patch" ? { kind, plane: { kind: "std", name: "XY" }, width: 100, height: 100, nu: 5, nv: 5 } : { kind, face: { kind: "face", name: "" } }, moves: [] })} />
          {src.kind === "patch" && (
            <>
              <PlaneSelect field="plane" label="Plano (centro = origem do plano)" value={src.plane} before={before} onChange={(plane) => up({ source: { ...src, plane } })} />
              <ExprInput label="Largura" value={src.width} onChange={(width) => up({ source: { ...src, width: width ?? "" } })} />
              <ExprInput label="Altura" value={src.height} onChange={(height) => up({ source: { ...src, height: height ?? "" } })} />
              <div class="row">
                <Field label="Polos em U"><input type="number" min="2" max="30" value={src.nu} onChange={(ev) => up({ source: { ...src, nu: Number((ev.target as HTMLInputElement).value) || 2 } })} /></Field>
                <Field label="Polos em V"><input type="number" min="2" max="30" value={src.nv} onChange={(ev) => up({ source: { ...src, nv: Number((ev.target as HTMLInputElement).value) || 2 } })} /></Field>
                <Field label="Grau"><input type="number" min="1" max="5" value={src.degree ?? 3} onChange={(ev) => up({ source: { ...src, degree: Number((ev.target as HTMLInputElement).value) || 3 } })} /></Field>
              </div>
            </>
          )}
          {src.kind === "face" && <RefList field="face" single label="Face a converter" accept={["face"]} refs={src.face.name ? [src.face] : []} onChange={(r) => up({ source: { ...src, face: r[0] ?? { kind: "face", name: "" } }, moves: [] })} />}
          <Select label="Arrastar polos" value={st.poleAxis} options={[["free", "Livre (plano do ecrã)"], ["X", "Só em X"], ["Y", "Só em Y"], ["Z", "Só em Z"]]} onChange={(poleAxis) => store.set({ poleAxis })} />
          {sel ? (
            <fieldset class="checklist">
              <legend class="field-label">Polo ({sel[0] + 1}, {sel[1] + 1}) — deslocamento</legend>
              <div class="row3">
                {[0, 1, 2].map((k) => (
                  <Field key={k} label={"dXdYdZ".slice(k * 2, k * 2 + 2)}>
                    <input type="number" step="0.5" value={d[k]} onChange={(ev) => { const n = [...d] as [number, number, number]; n[k] = Number((ev.target as HTMLInputElement).value) || 0; store.movePole(sel[0], sel[1], n, true); }} />
                  </Field>
                ))}
              </div>
              <button class="small" onClick={() => store.movePole(sel[0], sel[1], [0, 0, 0], true)}>Repor este polo</button>
            </fieldset>
          ) : <p class="field-hint">Arraste os polos (roxo) no 3D; um clique seleciona o polo para editar o deslocamento.</p>}
          <p class="muted">{f.moves.length} polo(s) deslocado(s){net ? ` · rede ${net.nu} × ${net.nv}` : ""}</p>
          {f.moves.length > 0 && <button class="small" onClick={() => up({ moves: [] })}>Repor todos os polos</button>}
        </>
      );
      break;
    }
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

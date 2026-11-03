// Registo da UI de cada tipo de feature no painel de propriedades.
// O mapa é tipado por tipo: um tipo da lista sem formulário não compila.
// Por agora cobre as features sólidas e de referência; as de superfície/GSD seguem no PropertyPanel.
import type { FunctionComponent } from "preact";
import type { BodyOp, Feature, FeatureOf, FeatureType, HoleKind } from "../doc/types.ts";
import { SHEET_SOURCES, TOOL_FEATURES } from "../doc/features.ts";
import { METRIC_SIZES, METRIC } from "../doc/holes.ts";
import { PLUGINS } from "../plugins/meta.ts";
import { AxisSelect, Check, EndEditor, ExprInput, FeatureChecklist, Field, PathSelect, PlaneSelect, RefList, RegionList, Select, SketchSelect, SweepOptionsEditor } from "./forms.tsx";

export type FeatureUiProps<K extends FeatureType> = {
  f: FeatureOf<K>;
  up: (patch: Partial<Feature>) => void;
  /** Índice da feature na árvore: os seletores só oferecem features anteriores. */
  before: number;
};
export type FeatureUi<K extends FeatureType> = FunctionComponent<FeatureUiProps<K>>;

export const OPS: [BodyOp, string][] = [["add", "Adicionar material"], ["cut", "Remover material (corte)"], ["intersect", "Intersetar"], ["new", "Corpo separado"]];
const fmt = (v: number) => v.toLocaleString("pt-PT", { maximumFractionDigits: 3 });

type SolidUiType =
  | "extrude" | "revolve" | "sweep" | "loft" | "hole" | "fillet" | "chamfer" | "shell" | "draft" | "rib"
  | "linearPattern" | "circularPattern" | "mirror" | "plane" | "axis" | "csys" | "import" | "plugin";

const SOLID_UI: { readonly [K in SolidUiType]: FeatureUi<K> } = {
  extrude: ({ f, up, before }) => (
    <>
      <SketchSelect label="Esboço" value={f.sketch} before={before} onChange={(sketch) => up({ sketch, regions: undefined })} />
      {f.sketch && <RegionList sketch={f.sketch} value={f.regions} onChange={(regions) => up({ regions })} />}
      <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
      <EndEditor field="end1" label="Direção 1" value={f.end} onChange={(end) => end && up({ end })} />
      <Check label="Inverter direção" value={f.flip} onChange={(flip) => up({ flip })} />
      {f.end.type !== "midplane" && <EndEditor field="end2" label="Direção 2" optional allowMid={false} value={f.end2} onChange={(end2) => up({ end2 })} />}
      <ExprInput label="Ângulo de saída (inclinação)" unit="°" allowEmpty value={f.draft} onChange={(draft) => up({ draft })} />
    </>
  ),
  revolve: ({ f, up, before }) => (
    <>
      <SketchSelect label="Esboço" value={f.sketch} before={before} onChange={(sketch) => up({ sketch, regions: undefined })} />
      {f.sketch && <RegionList sketch={f.sketch} value={f.regions} onChange={(regions) => up({ regions })} />}
      <AxisSelect field="axis" label="Eixo de revolução" value={f.axis} before={before} sketch={f.sketch} onChange={(axis) => up({ axis })} />
      <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
      <ExprInput label="Ângulo" unit="°" value={f.angle} onChange={(angle) => up({ angle: angle ?? "" })} />
      <Check label="Simétrico ao plano do esboço" value={f.midplane} onChange={(midplane) => up({ midplane })} />
      <Check label="Inverter sentido" value={f.flip} onChange={(flip) => up({ flip })} />
    </>
  ),
  sweep: ({ f, up, before }) => (
    <>
      <SketchSelect label="Perfil (contorno fechado)" value={f.profile} before={before} onChange={(profile) => up({ profile })} />
      <PathSelect label="Caminho (esboço ou curva 3D)" value={f.path} before={before} onChange={(path) => up({ path })} />
      <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
      <SweepOptionsEditor value={f} before={before} onChange={up} />
    </>
  ),
  loft: ({ f, up, before }) => (
    <>
      <FeatureChecklist label="Secções (pela ordem de escolha)" ordered value={f.sections} before={before} types={["sketch"]} onChange={(sections) => up({ sections })} />
      <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
      <Check label="Regrado (faces retas entre secções)" value={f.ruled} onChange={(ruled) => up({ ruled })} />
    </>
  ),
  hole: ({ f, up, before }) => {
    const size = f.size ? METRIC[f.size] : undefined;
    return (
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
  },
  fillet: ({ f, up }) => (
    <>
      <RefList field="refs" label="Arestas (uma face = todas as suas arestas)" accept={["edge", "face"]} refs={f.refs} onChange={(refs) => up({ refs })} />
      <ExprInput label="Raio" value={f.radius} onChange={(radius) => up({ radius: radius ?? "" })} />
    </>
  ),
  chamfer: ({ f, up }) => (
    <>
      <RefList field="refs" label="Arestas" accept={["edge", "face"]} refs={f.refs} onChange={(refs) => up({ refs })} />
      <ExprInput label="Distância" value={f.distance} onChange={(distance) => up({ distance: distance ?? "" })} />
      <ExprInput label="Distância 2 (vazio = igual)" allowEmpty value={f.distance2} onChange={(distance2) => up({ distance2 })} />
    </>
  ),
  shell: ({ f, up }) => (
    <>
      <RefList field="faces" label="Faces a remover (abertas)" accept={["face"]} refs={f.faces} onChange={(faces) => up({ faces })} />
      <ExprInput label="Espessura" value={f.thickness} onChange={(thickness) => up({ thickness: thickness ?? "" })} />
      <Check label="Espessura para fora" value={f.outward} onChange={(outward) => up({ outward })} />
    </>
  ),
  draft: ({ f, up, before }) => (
    <>
      <RefList field="faces" label="Faces a inclinar" accept={["face"]} refs={f.faces} onChange={(faces) => up({ faces })} />
      <PlaneSelect field="neutral" label="Plano neutro" value={f.neutral} before={before} onChange={(neutral) => up({ neutral })} />
      <ExprInput label="Ângulo" unit="°" value={f.angle} onChange={(angle) => up({ angle: angle ?? "" })} />
      <Check label="Inverter direção de extração" value={f.flip} onChange={(flip) => up({ flip })} />
    </>
  ),
  rib: ({ f, up, before }) => (
    <>
      <SketchSelect label="Esboço (contorno aberto)" value={f.sketch} before={before} onChange={(sketch) => up({ sketch })} />
      <ExprInput label="Espessura" value={f.thickness} onChange={(thickness) => up({ thickness: thickness ?? "" })} />
      <Check label="Preferir o outro lado" value={f.flip} onChange={(flip) => up({ flip })} />
    </>
  ),
  linearPattern: ({ f, up, before }) => (
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
  ),
  circularPattern: ({ f, up, before }) => (
    <>
      <FeatureChecklist label="Features ou superfícies a repetir (nenhuma = corpo inteiro)" value={f.features} before={before} types={[...TOOL_FEATURES, ...SHEET_SOURCES]} onChange={(features) => up({ features })} />
      <AxisSelect field="axis" label="Eixo" value={f.axis} before={before} onChange={(axis) => up({ axis })} />
      <ExprInput label="Instâncias" unit="" value={f.count} onChange={(count) => up({ count: count ?? "" })} />
      <ExprInput label="Ângulo total" unit="°" value={f.angle} onChange={(angle) => up({ angle: angle ?? "" })} />
    </>
  ),
  mirror: ({ f, up, before }) => (
    <>
      <FeatureChecklist label="Features ou superfícies a espelhar (nenhuma = corpo inteiro)" value={f.features} before={before} types={[...TOOL_FEATURES, ...SHEET_SOURCES]} onChange={(features) => up({ features })} />
      <PlaneSelect field="plane" label="Plano de espelho" value={f.plane} before={before} onChange={(plane) => up({ plane })} />
    </>
  ),
  plane: ({ f, up, before }) => (
    <>
      <PlaneSelect field="base" label="Plano ou face de referência" value={f.base} before={before} onChange={(base) => up({ base })} />
      <ExprInput label="Distância" value={f.offset} onChange={(offset) => up({ offset: offset ?? 0 })} />
      <ExprInput label="Ângulo (opcional)" unit="°" allowEmpty value={f.angle} onChange={(angle) => up({ angle })} />
      {f.angle !== undefined && f.angle !== "" && <AxisSelect field="axis" label="Eixo de rotação" value={f.axis ?? { kind: "std", name: "X" }} before={before} onChange={(axis) => up({ axis })} />}
      <Check label="Inverter normal" value={f.flip} onChange={(flip) => up({ flip })} />
    </>
  ),
  axis: ({ f, up, before }) => (
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
  ),
  csys: ({ f, up }) => (
    <>
      <div class="row3">{[0, 1, 2].map((k) => <ExprInput key={k} label={`Origem ${"XYZ"[k]}`} value={f.origin[k]} onChange={(val) => { const o = [...f.origin] as typeof f.origin; o[k] = val ?? 0; up({ origin: o }); }} />)}</div>
      <div class="row3">{[0, 1, 2].map((k) => <ExprInput key={k} unit="°" label={`Rotação ${"XYZ"[k]}`} value={f.rotation[k]} onChange={(val) => { const o = [...f.rotation] as typeof f.rotation; o[k] = val ?? 0; up({ rotation: o }); }} />)}</div>
    </>
  ),
  import: ({ f, up }) => (
    <>
      <Field label="Ficheiro"><input value={f.fileName} readOnly /></Field>
      <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
    </>
  ),
  plugin: ({ f, up }) => {
    const p = PLUGINS.find((x) => x.id === f.plugin);
    const kind = p?.kinds[f.kind];
    return (
      <>
        <p class="muted">{p?.name} · {kind?.label}</p>
        {kind && Object.entries(kind.params).map(([k, d]) => (
          <ExprInput key={k} label={d.label} unit={d.unit ?? ""} value={f.params[k]} onChange={(val) => up({ params: { ...f.params, [k]: val ?? d.value } })} />
        ))}
        <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
      </>
    );
  },
};

/** Formulário registado para o tipo, ou `undefined` se ainda estiver no switch do PropertyPanel. */
export const featureUi = (type: FeatureType): FeatureUi<FeatureType> | undefined =>
  Object.hasOwn(SOLID_UI, type) ? (SOLID_UI[type as SolidUiType] as FeatureUi<FeatureType>) : undefined;

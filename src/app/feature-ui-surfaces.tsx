// UI das features de superfície/GSD no painel de propriedades (ver feature-ui.tsx).
import type { BlendSide, Continuity, SectionTangent } from "../doc/types.ts";
import type { FeatureUi } from "./feature-ui.tsx";
import { AxisSelect, Check, CurveList, ExprInput, FeatureChecklist, OPS, PathSelect, PlaneSelect, PointList, RefList, Select, SheetList, SketchSelect, SweepOptionsEditor } from "./forms.tsx";

const CONT: [Continuity, string][] = [["contact", "Contacto (G0)"], ["tangent", "Tangente (G1)"], ["curvature", "Curvatura (G2)"]];

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

export type SurfaceUiType =
  | "surfaceExtrude" | "surfaceRevolve" | "surfaceSweep" | "surfaceLoft" | "fill" | "offsetSurface" | "knit" | "thicken"
  | "trimSurface" | "deleteFace" | "boundary" | "ruled" | "untrim" | "replaceFace" | "multiSection" | "blend"
  | "circleSweep" | "extrapolate" | "heal";

export const SURFACE_UI: { readonly [K in SurfaceUiType]: FeatureUi<K> } = {
  surfaceExtrude: ({ f, up, before }) => (
    <>
      <SketchSelect label="Esboço (contornos abertos ou fechados)" value={f.sketch} before={before} onChange={(sketch) => up({ sketch })} />
      <Select label="Fim" value={f.end.type} options={[["blind", "Cega (profundidade)"], ["midplane", "Plano médio"]]} onChange={(t) => up({ end: { type: t, depth: f.end.depth } })} />
      <ExprInput label="Profundidade" value={f.end.depth} onChange={(depth) => up({ end: { type: f.end.type, depth: depth ?? "" } })} />
      <Check label="Inverter direção" value={f.flip} onChange={(flip) => up({ flip })} />
    </>
  ),
  surfaceRevolve: ({ f, up, before }) => (
    <>
      <SketchSelect label="Esboço" value={f.sketch} before={before} onChange={(sketch) => up({ sketch })} />
      <AxisSelect field="axis" label="Eixo de revolução" value={f.axis} before={before} sketch={f.sketch} onChange={(axis) => up({ axis })} />
      <ExprInput label="Ângulo" unit="°" value={f.angle} onChange={(angle) => up({ angle: angle ?? "" })} />
      <Check label="Simétrico ao plano do esboço" value={f.midplane} onChange={(midplane) => up({ midplane })} />
    </>
  ),
  surfaceSweep: ({ f, up, before }) => (
    <>
      <SketchSelect label="Perfil (aberto ou fechado)" value={f.profile} before={before} onChange={(profile) => up({ profile })} />
      <PathSelect label="Caminho (esboço ou curva 3D)" value={f.path} before={before} onChange={(path) => up({ path })} />
      <SweepOptionsEditor value={f} before={before} onChange={up} />
    </>
  ),
  surfaceLoft: ({ f, up, before }) => (
    <>
      <FeatureChecklist label="Secções (pela ordem de escolha)" ordered value={f.sections} before={before} types={["sketch"]} onChange={(sections) => up({ sections })} />
      <Check label="Regrado (faces retas entre secções)" value={f.ruled} onChange={(ruled) => up({ ruled })} />
    </>
  ),
  fill: ({ f, up }) => (
    <>
      <RefList field="edges" label="Arestas do contorno (fechado)" accept={["edge"]} refs={f.edges} onChange={(edges) => up({ edges })} />
      <Select label="Continuidade com as faces vizinhas" value={f.continuity} options={CONT} onChange={(continuity) => up({ continuity })} />
      <p class="field-hint">Tangente/curvatura usam a face vizinha de cada aresta. O desvio de tangência é medido no fim e há aviso acima de 1°.</p>
    </>
  ),
  offsetSurface: ({ f, up }) => (
    <>
      <RefList field="faces" label="Faces a deslocar" accept={["face"]} refs={f.faces} onChange={(faces) => up({ faces })} />
      <ExprInput label="Distância (negativa = sentido oposto à normal)" value={f.distance} onChange={(distance) => up({ distance: distance ?? "" })} />
    </>
  ),
  knit: ({ f, up, before }) => (
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
  ),
  thicken: ({ f, up, before }) => (
    <>
      <SheetList field="sheet" single label="Corpo de superfície" value={f.sheet ? [f.sheet] : []} before={before} onChange={([sheet]) => up({ sheet: sheet ?? "" })} />
      <ExprInput label="Espessura" value={f.thickness} onChange={(thickness) => up({ thickness: thickness ?? "" })} />
      <Select label="Lado" value={f.side} options={[["front", "Na direção da normal"], ["back", "Oposto à normal"], ["both", "Dos dois lados (simétrico)"]]} onChange={(side) => up({ side })} />
      <Select label="Operação" value={f.op} options={OPS} onChange={(op) => up({ op })} />
    </>
  ),
  trimSurface: ({ f, up, before }) => {
    const t = f.tool;
    return (
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
  },
  deleteFace: ({ f, up }) => (
    <>
      <RefList field="faces" label="Faces a apagar" accept={["face"]} refs={f.faces} onChange={(faces) => up({ faces })} />
      <Select label="Modo" value={f.mode ?? "delete"} options={[["delete", "Apagar (o sólido passa a superfície)"], ["patch", "Apagar e remendar (o sólido mantém-se)"]]} onChange={(mode) => up({ mode })} />
      {f.mode === "patch" && <Select<Continuity> label="Continuidade do remendo" value={f.continuity ?? "tangent"} options={CONT} onChange={(continuity) => up({ continuity })} />}
      <p class="field-hint">{f.mode === "patch" ? "Cada buraco é preenchido com uma placa e o resultado é costurado de novo num sólido. Não prolonga as faces vizinhas (não reconstrói cantos vivos)." : "O sólido com faces apagadas passa a corpo de superfície aberto (para refazer a zona com superfícies e costurar de novo)."}</p>
    </>
  ),
  boundary: ({ f, up, before }) => (
    <>
      <CurveList field="dir1" label="Direção 1 (≥ 2 curvas, por ordem)" value={f.dir1} before={before} onChange={(dir1) => up({ dir1 })} />
      <Select<Continuity> label="Continuidade nos limites da direção 1" value={f.cont1 ?? "contact"} options={CONT} onChange={(cont1) => up({ cont1 })} />
      <CurveList field="dir2" label="Direção 2 (0 ou ≥ 2 curvas)" value={f.dir2} before={before} onChange={(dir2) => up({ dir2 })} />
      <Select<Continuity> label="Continuidade nos limites da direção 2" value={f.cont2 ?? "contact"} options={CONT} onChange={(cont2) => up({ cont2 })} />
      <p class="field-hint">Com as duas direções, a primeira e a última curva de cada uma fecham o contorno e as do meio guiam a forma. A tangência/curvatura aplica-se a curvas que são arestas de faces existentes.</p>
    </>
  ),
  ruled: ({ f, up, before }) => (
    <>
      <RefList field="edges" label="Arestas" accept={["edge"]} refs={f.edges} onChange={(edges) => up({ edges })} />
      <Select label="Tipo" value={f.mode} options={[["normal", "Normal à superfície"], ["tangent", "Tangente à superfície"], ["angle", "A um ângulo da superfície"], ["direction", "Numa direção"]]} onChange={(mode) => up({ mode })} />
      {f.mode === "angle" && <ExprInput label="Ângulo (0° tangente, 90° normal)" unit="°" allowEmpty value={f.angle} onChange={(angle) => up({ angle })} />}
      {f.mode !== "direction" && <RefList field="face" single label="Face de referência (necessária em arestas entre duas faces)" accept={["face"]} refs={f.face ? [f.face] : []} onChange={(r) => up({ face: r[0] })} />}
      {f.mode === "direction" && <AxisSelect field="direction" label="Direção" value={f.direction ?? { kind: "std", name: "Z" }} before={before} onChange={(direction) => up({ direction })} />}
      <ExprInput label="Distância" value={f.distance} onChange={(distance) => up({ distance: distance ?? "" })} />
      <Check label="Inverter" value={f.flip} onChange={(flip) => up({ flip })} />
    </>
  ),
  untrim: ({ f, up }) => (
    <>
      <RefList field="faces" label="Faces a desaparar" accept={["face"]} refs={f.faces} onChange={(faces) => up({ faces })} />
      <p class="field-hint">A face volta aos limites naturais da superfície; nas superfícies infinitas (plano, cilindro em altura) fica a caixa UV da face, sem furos nem recortes.</p>
    </>
  ),
  replaceFace: ({ f, up, before }) => (
    <>
      <RefList field="faces" label="Faces do sólido a substituir" accept={["face"]} refs={f.faces} onChange={(faces) => up({ faces })} />
      <SheetList field="sheet" single label="Superfície de substituição" value={f.sheet ? [f.sheet] : []} before={before} onChange={([sheet]) => up({ sheet: sheet ?? "" })} />
      <p class="field-hint">O sólido estende-se ou apara-se até à superfície, que tem de cobrir toda a face. Pressupõe faces laterais aproximadamente paralelas à normal da face substituída.</p>
    </>
  ),
  multiSection: ({ f, up, before }) => (
    <>
      <CurveList field="sections" label="Secções (por ordem)" value={f.sections} before={before} onChange={(sections) => up({ sections })} />
      <CurveList field="guides" label="Guias (opcional; cortam todas as secções)" value={f.guides ?? []} before={before} onChange={(guides) => up({ guides })} />
      <CurveList field="spine" single label="Spine (opcional, sem guias)" value={f.spine ? [f.spine] : []} before={before} onChange={([spine]) => up({ spine })} />
      {f.spine && <button class="small" onClick={() => up({ spine: undefined })}>Retirar spine</button>}
      <TangentEditor field="startTangent" label="Tangência na primeira secção" value={f.startTangent} onChange={(startTangent) => up({ startTangent })} />
      <TangentEditor field="endTangent" label="Tangência na última secção" value={f.endTangent} onChange={(endTangent) => up({ endTangent })} />
      <p class="field-hint">Com guias, a superfície passa exatamente pelas secções e pelas guias (superfície de Gordon). Sem guias nem tangências é um loft suave do OCC; a tangência pedida é medida no fim.</p>
    </>
  ),
  blend: ({ f, up, before }) => (
    <>
      <BlendSideEditor field="side1" label="Lado 1" value={f.side1} before={before} onChange={(side1) => up({ side1 })} />
      <BlendSideEditor field="side2" label="Lado 2" value={f.side2} before={before} onChange={(side2) => up({ side2 })} />
      <p class="field-hint">G1: Hermite cúbica; G2: quíntica com a curvatura normal das faces de suporte. A tensão escala as tangentes (1 = corda entre as curvas).</p>
    </>
  ),
  circleSweep: ({ f, up, before }) => (
    <>
      <Select label="Modo" value={f.mode} options={[["threeGuides", "Três guias"], ["twoGuidesRadius", "Duas guias e raio"], ["centerRadius", "Centro e raio (tubo)"]]} onChange={(mode) => up({ mode })} />
      <CurveList field="guides" label={f.mode === "centerRadius" ? "Curva central" : "Guias (por ordem)"} value={f.guides} before={before} onChange={(guides) => up({ guides })} />
      {f.mode !== "threeGuides" && <ExprInput label="Raio" value={f.radius} onChange={(radius) => up({ radius: radius ?? "" })} />}
      {f.mode === "twoGuidesRadius" && <Check label="Outra solução (centro do outro lado)" value={f.flip} onChange={(flip) => up({ flip })} />}
      {f.mode === "twoGuidesRadius" && <Check label="Arco maior" value={f.long} onChange={(long) => up({ long })} />}
    </>
  ),
  extrapolate: ({ f, up, before }) => (
    <>
      <SheetList field="sheet" single label="Corpo de superfície" value={f.sheet ? [f.sheet] : []} before={before} onChange={([sheet]) => up({ sheet: sheet ?? "" })} />
      <RefList field="edges" label="Arestas livres a prolongar" accept={["edge"]} refs={f.edges} onChange={(edges) => up({ edges })} />
      <ExprInput label="Comprimento" value={f.length} onChange={(length) => up({ length: length ?? "" })} />
      <Select label="Continuidade" value={f.continuity} options={[["tangent", "Tangente (G1, regrada)"], ["curvature", "Curvatura (G2)"]]} onChange={(continuity) => up({ continuity })} />
      <Check label="Juntar ao corpo" value={f.assemble !== false} onChange={(assemble) => up({ assemble })} />
    </>
  ),
  heal: ({ f, up, before }) => (
    <>
      <SheetList field="sheets" label="Corpos de superfície a curar" value={f.sheets} before={before} onChange={(sheets) => up({ sheets })} />
      <ExprInput label="Distância de fusão (folgas a fechar)" value={f.distance} onChange={(distance) => up({ distance: distance ?? "" })} />
      <ExprInput label="Ângulo para assinalar quase-tangência" unit="°" allowEmpty value={f.tangency} onChange={(tangency) => up({ tangency })} />
      <Check label="Simplificar (unir faces da mesma superfície)" value={f.simplify} onChange={(simplify) => up({ simplify })} />
      <p class="field-hint">Fecha folgas, corrige as faces (ShapeFix) e costura. As arestas quase tangentes são só assinaladas: a cura não deforma as superfícies.</p>
    </>
  ),
};

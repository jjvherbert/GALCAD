// PMI semântico no STEP AP242: acrescenta ao ficheiro escrito pelo OCCT (as faces com PMI vêm com o
// nome "PMI#k") as entidades da representação semântica segundo as CAx-IF Recommended Practices for
// the Representation and Presentation of PMI (AP242): SHAPE_ASPECT + GEOMETRIC_ITEM_SPECIFIC_USAGE
// por elemento, DATUM_FEATURE/DATUM, DIMENSIONAL_SIZE/LOCATION com o valor nominal e
// PLUS_MINUS_TOLERANCE (afastamentos ou LIMITS_AND_FITS ISO 286), tolerâncias geométricas com
// DATUM_SYSTEM, modificadores e zona cilíndrica; estados de superfície, notas e atributos como
// atributos definidos pelo utilizador (PROPERTY_DEFINITION 'user defined attribute').
// Só semântica: não escreve a apresentação gráfica (texto/linhas de chamada) — ver as hipóteses.
// Puro: opera sobre o texto do ficheiro.
import type { Attribute, GdtCharacteristic, PmiItem } from "../doc/pmi.ts";

/** Item com as faces já como índices em `pmiFaces` e o valor medido (cotas). */
export interface ResolvedPmi { item: PmiItem; faces: number[]; nominal?: number }

const TOL_ENTITY: Record<GdtCharacteristic, string> = {
  straightness: "STRAIGHTNESS_TOLERANCE", flatness: "FLATNESS_TOLERANCE", circularity: "ROUNDNESS_TOLERANCE", cylindricity: "CYLINDRICITY_TOLERANCE",
  profileLine: "LINE_PROFILE_TOLERANCE", profileSurface: "SURFACE_PROFILE_TOLERANCE",
  parallelism: "PARALLELISM_TOLERANCE", perpendicularity: "PERPENDICULARITY_TOLERANCE", angularity: "ANGULARITY_TOLERANCE",
  position: "POSITION_TOLERANCE", concentricity: "COAXIALITY_TOLERANCE", symmetry: "SYMMETRY_TOLERANCE",
  circularRunout: "CIRCULAR_RUNOUT_TOLERANCE", totalRunout: "TOTAL_RUNOUT_TOLERANCE",
};

/** Real no formato do STEP (sempre com ponto decimal). */
export const real = (x: number) => {
  const s = Number.isInteger(x) ? `${x}.` : String(+x.toPrecision(12));
  return /e/i.test(s) ? s.replace(/^(-?\d+)(e)/i, "$1.$2").toUpperCase() : s;
};
/** Texto STEP (apóstrofos duplicados; não-ASCII com a codificação \X2\ do ISO 10303-21). */
export const text = (s: string) => `'${[...s].map((ch) => {
  const c = ch.codePointAt(0)!;
  if (ch === "'") return "''";
  if (ch === "\\") return "\\\\";
  if (c >= 32 && c < 127) return ch;
  return c <= 0xffff ? `\\X2\\${c.toString(16).toUpperCase().padStart(4, "0")}\\X0\\` : `\\X4\\${c.toString(16).toUpperCase().padStart(8, "0")}\\X0\\`;
}).join("")}'`;

/** Entidades do DATA (#id → texto) e o id máximo. */
function entities(step: string): { map: Map<number, string>; max: number } {
  const data = step.slice(step.indexOf("DATA;") + 5, step.lastIndexOf("ENDSEC;"));
  const map = new Map<number, string>();
  let max = 0;
  for (const m of data.matchAll(/#(\d+)\s*=\s*([\s\S]*?);\s*(?=#\d+\s*=|$)/g)) {
    const id = Number(m[1]);
    map.set(id, m[2].replace(/\s*\n\s*/g, " "));
    if (id > max) max = id;
  }
  return { map, max };
}

export function addSemanticPmi(step: string, items: ResolvedPmi[], attributes: { attr: Attribute; face?: number }[] = []): { step: string; written: number; warnings: string[] } {
  const warnings: string[] = [];
  const { map, max } = entities(step);
  const find = (re: RegExp) => [...map].find(([, v]) => re.test(v));
  // faces "PMI#k"
  const face = new Map<number, number>();
  for (const [id, v] of map) { const m = /^ADVANCED_FACE\('PMI#(\d+)'/.exec(v); if (m) face.set(Number(m[1]), id); }
  // representação do sólido, a sua forma de definição (PDS) e o contexto com as unidades
  const sr = find(/^ADVANCED_BREP_SHAPE_REPRESENTATION\(/) ?? find(/^MANIFOLD_SURFACE_SHAPE_REPRESENTATION\(/);
  if (!sr) throw new Error("STEP sem representação B-rep para o PMI");
  const ctx = Number(/#(\d+)\s*\)\s*$/.exec(sr[1])![1]);
  const sdr = [...map].find(([, v]) => new RegExp(`^SHAPE_DEFINITION_REPRESENTATION\\(#(\\d+),#${sr[0]}\\)`).test(v.replace(/\s/g, "")));
  if (!sdr) throw new Error("STEP sem SHAPE_DEFINITION_REPRESENTATION do sólido");
  const pds = Number(/#(\d+)/.exec(sdr[1])![1]);
  const units = [...(/GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\(([^)]*)\)/.exec(map.get(ctx) ?? "")?.[1] ?? "").matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  const lu = units.find((u) => /LENGTH_UNIT/.test(map.get(u) ?? ""));
  const au = units.find((u) => /PLANE_ANGLE_UNIT/.test(map.get(u) ?? ""));
  if (!lu) throw new Error("STEP sem unidade de comprimento no contexto");
  const radians = au !== undefined && /RADIAN/.test(map.get(au) ?? "");

  let next = max;
  const out: string[] = [];
  const add = (body: string) => { next++; out.push(`#${next} = ${body};`); return next; };
  const len = (x: number) => add(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(${real(x)}),#${lu})`);
  const aspect = (name: string, faces: number[], entity = "SHAPE_ASPECT", extra = "") => {
    const sa = add(`${entity}(${text(name)},'',#${pds},.T.${extra})`);
    for (const k of faces) {
      const f = face.get(k);
      if (f === undefined) { warnings.push(`${name}: face PMI#${k} não encontrada no STEP`); continue; }
      add(`GEOMETRIC_ITEM_SPECIFIC_USAGE('','',#${sa},#${sr[0]},#${f})`);
    }
    return sa;
  };
  // datums primeiro (as tolerâncias referem-nos)
  const datum = new Map<string, number>();
  for (const r of items) {
    if (r.item.kind !== "datum") continue;
    const df = aspect(r.item.label, r.faces, "DATUM_FEATURE");
    const d = add(`DATUM(${text(r.item.label)},'',#${pds},.F.,${text(r.item.label)})`);
    add(`SHAPE_ASPECT_RELATIONSHIP('','',#${df},#${d})`);
    datum.set(r.item.label, d);
  }
  let written = datum.size;
  for (const r of items) {
    const it = r.item;
    if (it.kind === "dimension") {
      const v = it.nominal ?? r.nominal;
      if (v === undefined) { warnings.push(`Cota ${it.id}: sem valor nominal`); continue; }
      let dim: number, rep: number;
      if (it.type === "diameter" || it.type === "radius") {
        dim = add(`DIMENSIONAL_SIZE(#${aspect(it.id, r.faces)},'${it.type}')`);
        rep = add(`( LENGTH_MEASURE_WITH_UNIT() MEASURE_REPRESENTATION_ITEM() MEASURE_WITH_UNIT(POSITIVE_LENGTH_MEASURE(${real(v)}),#${lu}) REPRESENTATION_ITEM('nominal value') )`);
      } else if (it.type === "distance") {
        if (r.faces.length !== 2) { warnings.push(`Cota ${it.id}: a distância precisa de duas faces`); continue; }
        dim = add(`DIMENSIONAL_LOCATION('linear distance',$,#${aspect(`${it.id}.1`, [r.faces[0]])},#${aspect(`${it.id}.2`, [r.faces[1]])})`);
        rep = add(`( LENGTH_MEASURE_WITH_UNIT() MEASURE_REPRESENTATION_ITEM() MEASURE_WITH_UNIT(POSITIVE_LENGTH_MEASURE(${real(v)}),#${lu}) REPRESENTATION_ITEM('nominal value') )`);
      } else {
        if (r.faces.length !== 2 || au === undefined) { warnings.push(`Cota ${it.id}: o ângulo precisa de duas faces e de unidade angular`); continue; }
        dim = add(`ANGULAR_LOCATION('angular location',$,#${aspect(`${it.id}.1`, [r.faces[0]])},#${aspect(`${it.id}.2`, [r.faces[1]])},.EQUAL.)`);
        const a = radians ? (v * Math.PI) / 180 : v;
        rep = add(`( MEASURE_REPRESENTATION_ITEM() MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(${real(a)}),#${au}) PLANE_ANGLE_MEASURE_WITH_UNIT() REPRESENTATION_ITEM('nominal value') )`);
      }
      add(`DIMENSIONAL_CHARACTERISTIC_REPRESENTATION(#${dim},#${add(`SHAPE_DIMENSION_REPRESENTATION('',(#${rep}),#${ctx})`)})`);
      if (it.tol?.kind === "deviation") {
        if (it.type === "angle") {
          const k = radians ? Math.PI / 180 : 1;
          const lo = add(`PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(${real(it.tol.lower * k)}),#${au})`), up = add(`PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(${real(it.tol.upper * k)}),#${au})`);
          add(`PLUS_MINUS_TOLERANCE(#${add(`TOLERANCE_VALUE(#${lo},#${up})`)},#${dim})`);
        } else {
          const lo = len(it.tol.lower), up = len(it.tol.upper);
          add(`PLUS_MINUS_TOLERANCE(#${add(`TOLERANCE_VALUE(#${lo},#${up})`)},#${dim})`);
        }
      } else if (it.tol?.kind === "fit") {
        const m = /^(js|JS|[A-Za-z])(\d{1,2})$/.exec(it.tol.code);
        if (m) {
          const hole = m[1] === m[1].toUpperCase();
          add(`PLUS_MINUS_TOLERANCE(#${add(`LIMITS_AND_FITS(${text(m[1])},'${hole ? "hole" : "shaft"}',${text(m[2])},'ISO 286')`)},#${dim})`);
        } else warnings.push(`Cota ${it.id}: classe ${it.tol.code} inválida`);
      }
      written++;
    } else if (it.kind === "gdt") {
      const sa = aspect(it.id, r.faces);
      const mag = len(it.value);
      const parts = [`GEOMETRIC_TOLERANCE(${text(it.id)},'',#${mag},#${sa})`, `${TOL_ENTITY[it.characteristic]}()`];
      if (it.datums.length) {
        const drc = it.datums.flatMap((d) => {
          const id = datum.get(d);
          if (id === undefined) { warnings.push(`Tolerância ${it.id}: referência ${d} inexistente`); return []; }
          return [add(`DATUM_REFERENCE_COMPARTMENT('','',#${pds},.F.,#${id},$)`)];
        });
        const ds = add(`DATUM_SYSTEM('','',#${pds},.F.,(${drc.map((x) => `#${x}`).join(",")}))`);
        parts.push(`GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE((#${ds}))`);
      }
      if (it.modifier) parts.push(`GEOMETRIC_TOLERANCE_WITH_MODIFIERS((.${it.modifier === "M" ? "MAXIMUM" : "LEAST"}_MATERIAL_REQUIREMENT.))`);
      // sem datums nem modificadores: a entidade simples (ex. FLATNESS_TOLERANCE('','',#mag,#sa))
      const tol = parts.length === 2 ? add(`${TOL_ENTITY[it.characteristic]}(${text(it.id)},'',#${mag},#${sa})`)
        // entidade complexa: os tipos por ordem alfabética (ISO 10303-21 §11.2.5.3)
        : add(`( ${[...parts].sort((a, b) => a.split("(")[0].localeCompare(b.split("(")[0])).join(" ")} )`);
      if (it.diameter) add(`TOLERANCE_ZONE('','',#${pds},.F.,(#${tol}),#${add("TOLERANCE_ZONE_FORM('cylindrical or circular')")})`);
      written++;
    } else if (it.kind === "roughness" || it.kind === "note") {
      const sa = aspect(it.id, r.faces);
      const items2 = it.kind === "roughness"
        ? [`DESCRIPTIVE_REPRESENTATION_ITEM('surface texture Ra',${text(`${it.ra} um`)})`, `DESCRIPTIVE_REPRESENTATION_ITEM('material removal',${text(it.process === "remove" ? "required" : it.process === "noremove" ? "prohibited" : "any")})`]
        : [`DESCRIPTIVE_REPRESENTATION_ITEM('note',${text(it.text)})`];
      const ids = items2.map((x) => add(x));
      const pd = add(`PROPERTY_DEFINITION('user defined attribute','',#${sa})`);
      add(`PROPERTY_DEFINITION_REPRESENTATION(#${pd},#${add(`REPRESENTATION(${text(it.kind === "roughness" ? "surface texture (ISO 21920)" : "note")},(${ids.map((x) => `#${x}`).join(",")}),#${ctx})`)})`);
      written++;
    }
  }
  // atributos (tags): no corpo (forma do produto) ou numa face
  for (const { attr, face: k } of attributes) {
    const target = attr.target.kind === "face" && k !== undefined ? aspect(`attr:${attr.key}`, [k]) : pds;
    const dri = add(`DESCRIPTIVE_REPRESENTATION_ITEM(${text(attr.key)},${text(attr.value)})`);
    const pd = add(`PROPERTY_DEFINITION('user defined attribute',${text(attr.target.kind === "feature" ? `feature ${attr.target.feature}` : "")},#${target})`);
    add(`PROPERTY_DEFINITION_REPRESENTATION(#${pd},#${add(`REPRESENTATION('user defined attributes',(#${dri}),#${ctx})`)})`);
  }
  const end = step.lastIndexOf("ENDSEC;");
  return { step: `${step.slice(0, end)}${out.join("\n")}\n${step.slice(end)}`, written, warnings };
}

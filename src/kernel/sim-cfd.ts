// Estudos: caso CFD (domínio, condições de fronteira, malha) e STL por patch para o OpenFOAM.
import { type CfdStudy } from "../doc/study.ts";
import { evalParam } from "../doc/variables.ts";
import { type Ctx, type StepReport } from "./context.ts";
import { T, type TopoDS_Shape, bbox, distance, explore, oc, v3, vertexAt, volume } from "./occ.ts";
import { type CfdCase, type V3 } from "../sim/case.ts";
import { bodyOf, caseFaces, tagsOf, n3 } from "./sim-common.ts";

/** Ponto dentro do sólido (para o snappyHexMesh nos casos internos). */
function pointInside(solid: TopoDS_Shape, b: { min: number[]; max: number[] }): V3 {
  const c = volume(solid).center as V3;
  const inside = (p: V3) => distance(vertexAt(p), solid) < 1e-9 && distance(vertexAt(p), T(oc().TopoDS.Shell(explore(solid, "shell")[0]))) > 1e-6;
  if (inside(c)) return c;
  // procura numa grelha grosseira dentro da caixa
  for (let n = 3; n <= 9; n += 2) for (let i = 1; i < n; i++) for (let j = 1; j < n; j++) for (let k = 1; k < n; k++) {
    const p: V3 = [0, 1, 2].map((q) => b.min[q] + ((b.max[q] - b.min[q]) * [i, j, k][q]) / n) as V3;
    if (inside(p)) return p;
  }
  throw new Error("Não foi possível encontrar um ponto dentro do volume de fluido");
}

export function cfdCase(ctx: Ctx, s: CfdStudy, report: StepReport): CfdCase {
  const solid = bodyOf(ctx);
  const faces = caseFaces(ctx, solid);
  const b = bbox(solid);
  const L = Math.max(...b.max.map((x, i) => x - b.min[i]));
  const groups: Record<string, number[]> = {};
  let velocity: V3, domain: CfdCase["domain"], insidePoint: V3;
  if (s.regime === "internal") {
    groups.inlet = tagsOf(ctx, faces, solid, s.inlet?.faces ?? [], "Entrada", report);
    groups.outlet = tagsOf(ctx, faces, solid, s.outlet?.faces ?? [], "Saída", report);
    const used = new Set([...groups.inlet, ...groups.outlet]);
    if (groups.inlet.some((t) => groups.outlet.includes(t))) throw new Error("Uma face não pode ser entrada e saída");
    groups.walls = faces.map((f) => f.tag).filter((t) => !used.has(t));
    velocity = n3(s.inlet!.velocity, ctx.scope, "Velocidade de entrada");
    insidePoint = pointInside(solid, b);
  } else {
    groups.body = faces.map((f) => f.tag);
    velocity = n3(s.freestream?.velocity ?? [1, 0, 0], ctx.scope, "Velocidade");
    const [up, down, side] = s.freestream?.domain ?? [3, 6, 2];
    // domínio alinhado com a direção principal do escoamento (eixo de maior componente)
    const ax = [0, 1, 2].reduce((m, k) => (Math.abs(velocity[k]) > Math.abs(velocity[m]) ? k : m), 0);
    const sign = Math.sign(velocity[ax]) || 1;
    const min = b.min.map((x) => x - side * L) as V3, max = b.max.map((x) => x + side * L) as V3;
    if (sign > 0) { min[ax] = b.min[ax] - up * L; max[ax] = b.max[ax] + down * L; } else { min[ax] = b.min[ax] - down * L; max[ax] = b.max[ax] + up * L; }
    domain = { min, max };
    insidePoint = min.map((x, k) => x + 0.05 * (max[k] - x)) as V3;
  }
  const U = Math.hypot(...velocity);
  if (!(U > 0)) throw new Error("Velocidade: tem de ser não nula");
  // comprimento característico: diâmetro hidráulico da entrada (interno) ou maior dimensão (externo)
  let refLength = L;
  if (s.regime === "internal") {
    const inl = faces.filter((f) => groups.inlet.includes(f.tag));
    const A = inl.reduce((a, f) => a + f.area, 0);
    const P = explore(solid, "face").filter((_, i) => groups.inlet.includes(i + 1)).reduce((a, f) => {
      const p = new (oc().GProp_GProps)(); oc().BRepGProp.LinearProperties(f, p, false, false); const m = p.Mass(); p.delete(); return a + m;
    }, 0);
    refLength = P > 0 ? (4 * A) / P : L;
  }
  const reynolds = (U * refLength * 1e-3) / s.fluid.nu;
  if (s.turbulence === "laminar" && reynolds > (s.regime === "internal" ? 2300 : 5e5)) report.warnings.push(`Re ≈ ${reynolds.toExponential(2)}: provavelmente turbulento (escolha um modelo de turbulência)`);
  const size = evalParam(s.mesh.size, ctx.scope, "Tamanho das células");
  if (size <= 0) throw new Error("Tamanho das células: tem de ser positivo");
  return {
    format: "cadp-sim-case", version: 1, physics: "cfd", solver: s.solver, title: s.name, regime: s.regime, fluid: s.fluid, turbulence: s.turbulence,
    groups, faces, velocity, domain, insidePoint, iterations: s.iterations, bbox: { min: b.min as V3, max: b.max as V3 },
    mesh: { size, surfaceLevel: s.mesh.surfaceLevel ?? [1, 2], layers: s.mesh.layers ?? 3 }, refLength, reynolds,
    hypotheses: [
      `Escoamento incompressível em regime permanente (${s.solver === "openfoam" ? "simpleFoam" : "SU2 INC_RANS/INC_NAVIER_STOKES"}), fluido newtoniano: ${s.fluid.name} (ρ = ${s.fluid.rho} kg/m³, ν = ${s.fluid.nu} m²/s)`,
      `Turbulência: ${s.turbulence === "laminar" ? "laminar" : s.turbulence === "kOmegaSST" ? "RANS k-ω SST" : "RANS k-ε"}; Re ≈ ${reynolds.toExponential(2)} (comprimento ${refLength.toFixed(2)} mm)`,
      s.regime === "internal" ? "Entrada com velocidade uniforme, saída à pressão 0, paredes sem escorregamento" : `Domínio em caixa (${(s.freestream?.domain ?? [3, 6, 2]).join(" × ")} × dimensão) com escoamento livre uniforme e paredes laterais com escorregamento`,
      `Malha: ${s.solver === "openfoam" ? `snappyHexMesh (fundo ${size} mm, níveis ${(s.mesh.surfaceLevel ?? [1, 2]).join("–")}, ${s.mesh.layers ?? 3} camadas)` : `tetraédrica Gmsh ${size} mm`} — confirmar a independência da malha`,
      "Apoio à decisão de engenharia: não é certificação nem decisão de uma autoridade ou de um organismo notificado",
    ],
  };
}

/** STL ASCII (em metros) de cada patch, a partir da triangulação exata das faces do OCC. */
export function stlPatches(ctx: Ctx, solid: TopoDS_Shape, c: CfdCase): Record<string, string> {
  const o = oc();
  const size = Math.max(...c.bbox.max.map((x, i) => x - c.bbox.min[i]));
  T(new o.BRepMesh_IncrementalMesh(solid, size * 1e-3, false, 0.2, false));
  const all = explore(solid, "face");
  const out: Record<string, string> = {};
  for (const [name, tags] of Object.entries(c.groups)) {
    const L = [`solid ${name}`];
    for (const tag of tags) {
      const f = T(o.TopoDS.Face(all[tag - 1]));
      const loc = T(new o.TopLoc_Location());
      const tri = o.BRep_Tool.Triangulation(f, loc, 0);
      if (!tri || (tri as unknown as { IsNull?: () => boolean }).IsNull?.()) continue;
      const trsf = loc.Transformation();
      const rev = f.Orientation() === o.TopAbs_Orientation.TopAbs_REVERSED;
      const P = (k: number) => { const p = tri.Node(k).Transformed(trsf); const r: V3 = [p.X() * 1e-3, p.Y() * 1e-3, p.Z() * 1e-3]; p.delete(); return r; };
      for (let k = 1; k <= tri.NbTriangles(); k++) {
        const t = tri.Triangle(k);
        let [a, b2, cc] = [t.Value(1), t.Value(2), t.Value(3)];
        if (rev) [b2, cc] = [cc, b2];
        const A = P(a), B = P(b2), C = P(cc);
        const n = v3.norm(v3.cross(v3.sub(B, A), v3.sub(C, A)));
        L.push(`  facet normal ${n.join(" ")}`, "    outer loop", ...[A, B, C].map((p) => `      vertex ${p.map((x) => x.toPrecision(9)).join(" ")}`), "    endloop", "  endfacet");
      }
    }
    L.push(`endsolid ${name}`);
    out[name] = L.join("\n") + "\n";
  }
  return out;
}

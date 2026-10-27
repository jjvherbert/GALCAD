// Forma livre (Fase 4.3): superfície B-spline com controlo direto dos polos. O patch nasce plano num
// plano de referência (ou de uma face convertida) e os deslocamentos guardados por índice são
// aplicados aos polos; a rede de controlo resultante vai no relatório para a interface a desenhar.
import type { Feature, FreeformFeature, Vec3 } from "../../doc/types.ts";
import { evalParam } from "../../doc/variables.ts";
import { type Ctx, type StepReport, faceOwner, faces as resolveFaces, planeFrame } from "../context.ts";
import { ShapeIndex, nameFresh } from "../naming.ts";
import { T, type TopoDS_Shape, faceProps, gpPnt, makeShell, oc, v3 } from "../occ.ts";

type Step<F> = (ctx: Ctx, f: F, report: StepReport) => Ctx;
type BSpline = InstanceType<ReturnType<typeof oc>["Geom_BSplineSurface"]>;

/** Nós uniformes fixados nas pontas (clamped) para n polos de grau p. */
function clampedKnots(n: number, p: number) {
  const o = oc();
  const inner = n - p - 1;
  const k = T(new o.NCollection_Array1_double(1, inner + 2)), m = T(new o.NCollection_Array1_int(1, inner + 2));
  for (let i = 0; i < inner + 2; i++) { k.SetValue(i + 1, i / (inner + 1)); m.SetValue(i + 1, i === 0 || i === inner + 1 ? p + 1 : 1); }
  return { k, m };
}

/** Patch plano nu × nv de polos (grau ≤ 3) no plano dado, centrado na origem do plano. */
function planarPatch(o3: Vec3, x: Vec3, y: Vec3, w: number, h: number, nu: number, nv: number, deg: number): BSpline {
  const o = oc();
  const du = Math.min(deg, nu - 1), dv = Math.min(deg, nv - 1);
  const poles = T(new o.NCollection_Array2_gp_Pnt(1, nu, 1, nv));
  // polos igualmente espaçados: com nós uniformes clamped o patch fica plano e quase uniforme
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const p = v3.add(o3, v3.add(v3.mul(x, w * (i / (nu - 1) - 0.5)), v3.mul(y, h * (j / (nv - 1) - 0.5))));
    poles.SetValue(i + 1, j + 1, gpPnt(p));
  }
  const U = clampedKnots(nu, du), V = clampedKnots(nv, dv);
  return T(new o.Geom_BSplineSurface(poles, U.k, V.k, U.m, V.m, du, dv, false, false));
}

/** B-spline a partir de uma face: a própria superfície se for limitada, senão uma grelha interpolada na caixa UV da face. */
function faceSpline(face: TopoDS_Shape, nu: number, nv: number): BSpline {
  const o = oc();
  const fc = T(o.TopoDS.Face(face));
  const surf = T(o.BRep_Tool.Surface(fc));
  const type = faceProps(face).type;
  if (type === "bspline" || type === "bezier") return T(o.GeomConvert.SurfaceToBSplineSurface(surf));
  const box = o.BRepTools.UVBounds(fc, 0, 0, 0, 0);
  const ad = T(new o.BRepAdaptor_Surface(fc, true));
  const pts = T(new o.NCollection_Array2_gp_Pnt(1, nu, 1, nv));
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const p = ad.Value(box.UMin + ((box.UMax - box.UMin) * i) / (nu - 1), box.VMin + ((box.VMax - box.VMin) * j) / (nv - 1));
    pts.SetValue(i + 1, j + 1, T(p));
  }
  const fit = T(new o.GeomAPI_PointsToBSplineSurface());
  fit.Interpolate(pts, false);
  if (!fit.IsDone()) throw new Error("Não foi possível converter a face em B-spline");
  return T(fit.Surface());
}

export const freeform: Step<FreeformFeature & Feature> = (ctx, f, report) => {
  const o = oc();
  const src = f.source;
  let surf: BSpline;
  let replaces: { owner: string; face: TopoDS_Shape } | null = null;
  if (src.kind === "patch") {
    const fr = planeFrame(ctx, src.plane, report);
    const w = evalParam(src.width, ctx.scope, "Largura"), h = evalParam(src.height, ctx.scope, "Altura");
    if (w <= 0 || h <= 0) throw new Error("Largura e altura têm de ser positivas");
    if (src.nu < 2 || src.nv < 2 || src.nu > 30 || src.nv > 30) throw new Error("Número de polos: entre 2 e 30 em cada direção");
    surf = planarPatch(fr.o, fr.x, fr.y, w, h, src.nu, src.nv, src.degree ?? 3);
  } else {
    const nf = resolveFaces(ctx, [src.face], report)[0];
    if (!nf) throw new Error("Escolha a face a converter");
    surf = faceSpline(nf.face, src.nu ?? 6, src.nv ?? 6);
    const owner = faceOwner(ctx, nf.face);
    if (owner && owner !== "body") replaces = { owner, face: nf.face };
  }
  const nu = surf.NbUPoles(), nv = surf.NbVPoles();
  const missing = f.moves.filter((m) => m.i < 0 || m.j < 0 || m.i >= nu || m.j >= nv);
  if (missing.length) report.warnings.push(`${missing.length} deslocamento(s) de polos inexistentes ignorado(s) (a rede tem ${nu} × ${nv} polos)`);
  for (const m of f.moves) {
    if (missing.includes(m)) continue;
    const p = T(surf.Pole(m.i + 1, m.j + 1));
    surf.SetPole(m.i + 1, m.j + 1, gpPnt([p.X() + m.d[0], p.Y() + m.d[1], p.Z() + m.d[2]]));
  }
  const poles: number[] = [];
  for (let i = 1; i <= nu; i++) for (let j = 1; j <= nv; j++) { const p = T(surf.Pole(i, j)); poles.push(p.X(), p.Y(), p.Z()); }
  report.net = { nu, nv, poles };
  report.info = {
    title: "Forma livre",
    rows: [["Polos", `${nu} × ${nv}`], ["Graus", `${surf.UDegree()} × ${surf.VDegree()}`], ["Polos deslocados", String(f.moves.length - missing.length)]],
    note: src.kind === "face" ? "A face é convertida pela sua superfície completa (sem recortes): os limites aparados não são mantidos." : undefined,
  };
  const mk = T(new o.BRepBuilderAPI_MakeFace(surf, 1e-7));
  if (!mk.IsDone()) throw new Error("Não foi possível criar a face");
  // a face convertida de um corpo de superfície é substituída; a de um sólido é copiada
  if (replaces) {
    const sh = ctx.sheets.get(replaces.owner)!;
    const gone = new ShapeIndex<true>();
    gone.set(replaces.face, true);
    const rest = sh.faces.filter((x) => !gone.has(x.face));
    if (rest.length) ctx.sheets.set(replaces.owner, { shape: makeShell(rest.map((r) => r.face)), faces: rest });
    else ctx.sheets.delete(replaces.owner);
  }
  ctx.sheets.set(f.id, nameFresh(T(mk.Face()), f.id, () => `${f.id}:ff`));
  return ctx;
};

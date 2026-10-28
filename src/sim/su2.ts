// Adaptador SU2 (8.x, LGPL-2.1): configuração do solver incompressível (laminar ou RANS SST) para a
// malha de fluido do Gmsh (`gmsh mesh.geo -3 -format su2 -o mesh.su2`, em metros).
import type { CfdCase } from "./case.ts";

export function su2Config(c: CfdCase): string {
  const U = Math.hypot(...c.velocity);
  const dir = c.velocity.map((x) => x / U);
  const rans = c.turbulence !== "laminar";
  const internal = c.regime === "internal";
  const wall = internal ? "walls" : "body";
  const mu = c.fluid.rho * c.fluid.nu;
  return [
    `% Gerado pelo CAD protótipo — ${c.title}`,
    ...c.hypotheses.map((h) => `% ${h}`),
    `SOLVER= ${rans ? "INC_RANS" : "INC_NAVIER_STOKES"}`,
    ...(rans ? [`KIND_TURB_MODEL= ${c.turbulence === "kOmegaSST" ? "SST" : "SA"}`] : []),
    "MATH_PROBLEM= DIRECT",
    "RESTART_SOL= NO",
    "INC_NONDIM= DIMENSIONAL",
    "INC_DENSITY_MODEL= CONSTANT",
    `INC_DENSITY_INIT= ${c.fluid.rho}`,
    `INC_VELOCITY_INIT= ( ${(internal ? [0, 0, 0] : c.velocity).join(", ")} )`,
    "INC_ENERGY_EQUATION= NO",
    "VISCOSITY_MODEL= CONSTANT_VISCOSITY",
    `MU_CONSTANT= ${mu.toExponential(6)}`,
    ...(rans ? ["FREESTREAM_TURBULENCEINTENSITY= 0.05", "FREESTREAM_TURB2LAMVISCRATIO= 10.0"] : []),
    `MARKER_HEATFLUX= ( ${wall}, 0.0 )`,
    ...(internal
      ? ["INC_INLET_TYPE= VELOCITY_INLET", `MARKER_INLET= ( inlet, 293.15, ${U}, ${dir.join(", ")} )`, "INC_OUTLET_TYPE= PRESSURE_OUTLET", "MARKER_OUTLET= ( outlet, 0.0 )",
        // médias por área na entrada e na saída: caudal e queda de pressão (SURFACE_PRESSURE_DROP)
        "MARKER_ANALYZE= ( inlet, outlet )", "MARKER_ANALYZE_AVERAGE= AREA"]
      : ["MARKER_FAR= ( farfield )", "MARKER_MONITORING= ( body )"]),
    `MARKER_PLOTTING= ( ${wall} )`,
    "NUM_METHOD_GRAD= WEIGHTED_LEAST_SQUARES",
    "CFL_NUMBER= 20.0",
    "CFL_ADAPT= YES",
    "CONV_NUM_METHOD_FLOW= FDS",
    "MUSCL_FLOW= YES",
    "SLOPE_LIMITER_FLOW= NONE",
    ...(rans ? ["CONV_NUM_METHOD_TURB= SCALAR_UPWIND", "MUSCL_TURB= NO"] : []),
    "LINEAR_SOLVER= FGMRES",
    "LINEAR_SOLVER_PREC= ILU",
    "LINEAR_SOLVER_ERROR= 1E-6",
    "LINEAR_SOLVER_ITER= 10",
    `ITER= ${c.iterations}`,
    "CONV_FIELD= RMS_PRESSURE",
    "CONV_RESIDUAL_MINVAL= -8",
    "MESH_FILENAME= mesh.su2",
    "MESH_FORMAT= SU2",
    "OUTPUT_FILES= ( RESTART, PARAVIEW, SURFACE_PARAVIEW )",
    "SCREEN_OUTPUT= ( INNER_ITER, RMS_PRESSURE, RMS_VELOCITY-X, RMS_VELOCITY-Y, RMS_VELOCITY-Z )",
    `HISTORY_OUTPUT= ( ITER, RMS_RES, ${internal ? "FLOW_COEFF" : "AERO_COEFF"} )`,
    "",
  ].join("\n");
}

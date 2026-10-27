// Adaptador OpenFOAM (linha OpenCFD/Keysight, openfoam.com: sintaxe da v2606, compatível com versões
// anteriores desde a v1912): caso simpleFoam com malha snappyHexMesh a partir das superfícies STL de
// cada patch (exportadas em metros pelo núcleo). Interno: o corpo é o fluido; externo: o corpo é um
// obstáculo num domínio em caixa.
import type { CfdCase, V3 } from "./case.ts";

const head = (cls: string, object: string, location?: string) => `/*--------------------------------*- C++ -*----------------------------------*\\
  Gerado pelo CAD prototipo (ficheiros ASCII puros, como o OpenFOAM espera)
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       ${cls};${location ? `\n    location    "${location}";` : ""}
    object      ${object};
}
`;
const vec = (v: number[]) => `(${v.map((x) => +x.toPrecision(10)).join(" ")})`;
const m = (v: V3): V3 => v.map((x) => x * 1e-3) as V3;

/** Valores de entrada da turbulência (intensidade 5 %, escala 0,07 · comprimento característico). */
export function turbulenceInlet(U: number, refLengthMm: number) {
  const I = 0.05, Cmu = 0.09;
  const l = 0.07 * refLengthMm * 1e-3;
  const k = 1.5 * (U * I) ** 2;
  return { k, omega: Math.sqrt(k) / (Cmu ** 0.25 * l), epsilon: (Cmu ** 0.75 * k ** 1.5) / l };
}

export function openfoamCase(c: CfdCase, stl: Record<string, string>): Record<string, string> {
  const f: Record<string, string> = {};
  const internal = c.regime === "internal";
  const U = Math.hypot(...c.velocity);
  const turb = turbulenceInlet(U, c.refLength);
  const rans = c.turbulence !== "laminar";
  const walls = internal ? ["walls"] : ["body"];
  const surfaces = Object.keys(c.groups);
  for (const [name, text] of Object.entries(stl)) f[`constant/triSurface/${name}.stl`] = text;

  // --- malha de fundo -------------------------------------------------------------
  const s = c.mesh.size;
  let min: V3, max: V3;
  if (internal) {
    // caixa do corpo com duas células de folga
    min = c.bbox.min.map((x) => x - 2 * s) as V3;
    max = c.bbox.max.map((x) => x + 2 * s) as V3;
  } else ({ min, max } = c.domain!);
  const n = min.map((x, k) => Math.max(1, Math.ceil((max[k] - x) / s)));
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map((b) => b.map((t, k) => (t ? max[k] : min[k])));
  // faces do bloco: x−, x+, y−, y+, z−, z+
  const faces = [[0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7]];
  const ax = [0, 1, 2].reduce((a, k) => (Math.abs(c.velocity[k]) > Math.abs(c.velocity[a]) ? k : a), 0);
  const up = 2 * ax + (c.velocity[ax] >= 0 ? 0 : 1), down = 2 * ax + (c.velocity[ax] >= 0 ? 1 : 0);
  const patch = (name: string, type: string, idx: number[]) => `    ${name}\n    {\n        type ${type};\n        faces\n        (\n${idx.map((i) => `            (${faces[i].join(" ")})`).join("\n")}\n        );\n    }`;
  const boundary = internal
    ? [patch("background", "patch", [0, 1, 2, 3, 4, 5])]
    : [patch("inlet", "patch", [up]), patch("outlet", "patch", [down]), patch("sides", "patch", [0, 1, 2, 3, 4, 5].filter((i) => i !== up && i !== down))];
  f["system/blockMeshDict"] = `${head("dictionary", "blockMeshDict")}
scale   0.001;

vertices
(
${v.map((p) => `    ${vec(p)}`).join("\n")}
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (${n.join(" ")}) simpleGrading (1 1 1)
);

boundary
(
${boundary.join("\n")}
);
`;

  // --- snappyHexMesh ----------------------------------------------------------------
  const [l0, l1] = c.mesh.surfaceLevel;
  f["system/surfaceFeatureExtractDict"] = `${head("dictionary", "surfaceFeatureExtractDict")}
${surfaces.map((name) => `${name}.stl
{
    extractionMethod    extractFromSurface;
    extractFromSurfaceCoeffs
    {
        includedAngle   150;
    }
    writeObj            no;
}`).join("\n\n")}
`;
  f["system/snappyHexMeshDict"] = `${head("dictionary", "snappyHexMeshDict")}
castellatedMesh true;
snap            true;
addLayers       ${c.mesh.layers > 0 ? "true" : "false"};

geometry
{
${surfaces.map((name) => `    ${name}.stl\n    {\n        type triSurfaceMesh;\n        name ${name};\n    }`).join("\n")}
}

castellatedMeshControls
{
    maxLocalCells       2000000;
    maxGlobalCells      4000000;
    minRefinementCells  0;
    maxLoadUnbalance    0.10;
    nCellsBetweenLevels 3;
    features
    (
${surfaces.map((name) => `        { file "${name}.eMesh"; level ${l1}; }`).join("\n")}
    );
    refinementSurfaces
    {
${surfaces.map((name) => `        ${name}\n        {\n            level (${l0} ${l1});\n            patchInfo { type ${walls.includes(name) ? "wall" : "patch"}; }\n        }`).join("\n")}
    }
    resolveFeatureAngle 30;
    refinementRegions {}
    locationInMesh ${vec(m(c.insidePoint))};
    allowFreeStandingZoneFaces true;
}

snapControls
{
    nSmoothPatch    3;
    tolerance       2.0;
    nSolveIter      50;
    nRelaxIter      5;
    nFeatureSnapIter 10;
    implicitFeatureSnap false;
    explicitFeatureSnap true;
    multiRegionFeatureSnap false;
}

addLayersControls
{
    relativeSizes   true;
    layers
    {
${walls.map((w) => `        ${w} { nSurfaceLayers ${c.mesh.layers}; }`).join("\n")}
    }
    expansionRatio  1.2;
    finalLayerThickness 0.5;
    minThickness    0.1;
    nGrow           0;
    featureAngle    60;
    slipFeatureAngle 30;
    nRelaxIter      3;
    nSmoothSurfaceNormals 1;
    nSmoothNormals  3;
    nSmoothThickness 10;
    maxFaceThicknessRatio 0.5;
    maxThicknessToMedialRatio 0.3;
    minMedialAxisAngle 90;
    nBufferCellsNoExtrude 0;
    nLayerIter      50;
}

meshQualityControls
{
    maxNonOrtho     65;
    maxBoundarySkewness 20;
    maxInternalSkewness 4;
    maxConcave      80;
    minVol          1e-15;
    minTetQuality   1e-15;
    minArea         -1;
    minTwist        0.02;
    minDeterminant  0.001;
    minFaceWeight   0.05;
    minVolRatio     0.01;
    minTriangleTwist -1;
    nSmoothScale    4;
    errorReduction  0.75;
    relaxed
    {
        maxNonOrtho 75;
    }
}

mergeTolerance 1e-6;
`;

  // --- física -------------------------------------------------------------------------
  f["constant/transportProperties"] = `${head("dictionary", "transportProperties", "constant")}
transportModel  Newtonian;

nu              [0 2 -1 0 0 0 0] ${c.fluid.nu};

// rho = ${c.fluid.rho} kg/m3 (o simpleFoam usa a pressao cinematica p/rho)
`;
  f["constant/turbulenceProperties"] = `${head("dictionary", "turbulenceProperties", "constant")}
simulationType  ${rans ? "RAS" : "laminar"};
${rans ? `
RAS
{
    RASModel        ${c.turbulence};
    turbulence      on;
    printCoeffs     on;
}
` : ""}`;

  // --- condições de fronteira (0/) ---------------------------------------------------
  type Bc = Record<string, string>;
  const field = (name: string, cls: string, dims: string, internalValue: string, bcs: Bc) => `${head(cls, name, "0")}
dimensions      ${dims};

internalField   uniform ${internalValue};

boundaryField
{
${Object.entries(bcs).map(([p, b]) => `    ${p}\n    {\n        ${b}\n    }`).join("\n")}
}
`;
  const Uin = vec(c.velocity);
  const zero = internal ? "(0 0 0)" : Uin;
  const pat = internal ? { inlet: "", outlet: "", walls: "", background: "" } : { inlet: "", outlet: "", sides: "", body: "" };
  const bcs = (fn: (p: string) => string): Bc => Object.fromEntries(Object.keys(pat).map((p) => [p, fn(p)]));
  const isWall = (p: string) => p === "walls" || p === "body";
  f["0/U"] = field("U", "volVectorField", "[0 1 -1 0 0 0 0]", zero, bcs((p) =>
    p === "inlet" ? `type fixedValue;\n        value uniform ${Uin};` : isWall(p) ? "type noSlip;" : p === "sides" ? "type slip;" : p === "outlet" ? `type inletOutlet;\n        inletValue uniform (0 0 0);\n        value uniform ${zero};` : "type zeroGradient;"));
  f["0/p"] = field("p", "volScalarField", "[0 2 -2 0 0 0 0]", "0", bcs((p) => (p === "outlet" ? "type fixedValue;\n        value uniform 0;" : p === "sides" ? "type slip;" : "type zeroGradient;")));
  if (rans) {
    const scalar = (name: string, val: number, wall: string) => field(name, "volScalarField", name === "k" ? "[0 2 -2 0 0 0 0]" : name === "omega" ? "[0 0 -1 0 0 0 0]" : "[0 2 -3 0 0 0 0]", String(val),
      bcs((p) => (p === "inlet" ? `type fixedValue;\n        value uniform ${val};` : isWall(p) ? `type ${wall};\n        value uniform ${val};` : p === "sides" ? "type slip;" : p === "outlet" ? `type inletOutlet;\n        inletValue uniform ${val};\n        value uniform ${val};` : "type zeroGradient;")));
    f["0/k"] = scalar("k", turb.k, "kqRWallFunction");
    if (c.turbulence === "kOmegaSST") f["0/omega"] = scalar("omega", turb.omega, "omegaWallFunction");
    else f["0/epsilon"] = scalar("epsilon", turb.epsilon, "epsilonWallFunction");
    f["0/nut"] = field("nut", "volScalarField", "[0 2 -1 0 0 0 0]", "0", bcs((p) => (isWall(p) ? "type nutkWallFunction;\n        value uniform 0;" : p === "sides" ? "type slip;" : "type calculated;\n        value uniform 0;")));
  }

  // --- controlo, esquemas, solvers -------------------------------------------------
  const funcs = [
    ...["inlet", "outlet"].map((p) => `    flux_${p}\n    {\n        type            surfaceFieldValue;\n        libs            ("libfieldFunctionObjects.so");\n        writeControl    timeStep;\n        writeInterval   1;\n        log             true;\n        writeFields     false;\n        regionType      patch;\n        name            ${p};\n        operation       sum;\n        fields          (phi);\n    }\n    pAvg_${p}\n    {\n        type            surfaceFieldValue;\n        libs            ("libfieldFunctionObjects.so");\n        writeControl    timeStep;\n        writeInterval   1;\n        log             false;\n        writeFields     false;\n        regionType      patch;\n        name            ${p};\n        operation       areaAverage;\n        fields          (p);\n    }`),
    ...(internal ? [] : [`    forces_body\n    {\n        type            forces;\n        libs            ("libforces.so");\n        writeControl    timeStep;\n        writeInterval   1;\n        log             false;\n        patches         (body);\n        rho             rhoInf;\n        rhoInf          ${c.fluid.rho};\n        CofR            (0 0 0);\n    }`]),
  ];
  f["system/controlDict"] = `${head("dictionary", "controlDict")}
application     simpleFoam;
startFrom       latestTime;
startTime       0;
stopAt          endTime;
endTime         ${c.iterations};
deltaT          1;
writeControl    timeStep;
writeInterval   ${c.iterations};
purgeWrite      1;
writeFormat     ascii;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

functions
{
${funcs.join("\n")}
}
`;
  f["system/fvSchemes"] = `${head("dictionary", "fvSchemes")}
ddtSchemes      { default steadyState; }
gradSchemes     { default Gauss linear; grad(U) cellLimited Gauss linear 1; }
divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div(phi,k)      bounded Gauss upwind;
    div(phi,omega)  bounded Gauss upwind;
    div(phi,epsilon) bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear limited corrected 0.33; }
interpolationSchemes { default linear; }
snGradSchemes   { default limited corrected 0.33; }
wallDist        { method meshWave; }
`;
  f["system/fvSolution"] = `${head("dictionary", "fvSolution")}
solvers
{
    p
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-7;
        relTol          0.05;
    }
    "(U|k|omega|epsilon)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-8;
        relTol          0.1;
    }
}

SIMPLE
{
    nNonOrthogonalCorrectors 1;
    consistent      yes;
    residualControl
    {
        p               1e-4;
        U               1e-5;
        "(k|omega|epsilon)" 1e-5;
    }
}

relaxationFactors
{
    equations
    {
        U               0.9;
        ".*"            0.8;
    }
}
`;
  f["Allrun"] = `#!/bin/sh
# Gerado pelo CAD prototipo: malha (blockMesh + snappyHexMesh) e simpleFoam.
cd "\${0%/*}" || exit 1
set -e
blockMesh > log.blockMesh 2>&1
surfaceFeatureExtract > log.surfaceFeatureExtract 2>&1
snappyHexMesh -overwrite > log.snappyHexMesh 2>&1
checkMesh > log.checkMesh 2>&1 || true
simpleFoam > log.simpleFoam 2>&1
`;
  return f;
}

/** Última linha numérica de um ficheiro `.dat` de um function object (tempo e valores). */
export function lastDatRow(text: string): number[] | null {
  const rows = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (!rows.length) return null;
  return rows[rows.length - 1].replace(/[()]/g, " ").trim().split(/\s+/).map(Number);
}

// Biblioteca de materiais do utilizador: validação, leitura robusta do armazenamento e lista combinada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allMaterials, sanitizeMaterials, validateMaterial } from "../src/app/material-library.ts";
import { SIM_MATERIALS, type SimMaterial } from "../src/doc/study.ts";

const ok: SimMaterial = { name: "Aço do fornecedor X", E: 205000, nu: 0.29, density: 7.8, alpha: 11.5e-6, k: 45, yield: 355, tangent: 2000 };

test("validateMaterial: material completo e coerente é válido", () => {
  assert.deepEqual(validateMaterial(ok, []), []);
  assert.deepEqual(validateMaterial({ name: "Só elástico", E: 1000, nu: 0, density: 1 }, []), []);
});

test("validateMaterial: rejeita nomes vazios, reservados e repetidos (sem distinguir maiúsculas)", () => {
  assert.equal(validateMaterial({ ...ok, name: "  " }, []).length, 1);
  assert.equal(validateMaterial({ ...ok, name: "Personalizado" }, []).length, 1);
  assert.match(validateMaterial({ ...ok, name: SIM_MATERIALS[0].name.toUpperCase() }, [])[0], /referência/);
  assert.match(validateMaterial(ok, [{ ...ok, name: " aço do fornecedor x " }])[0], /material seu/);
});

test("validateMaterial: rejeita constantes fisicamente impossíveis", () => {
  const bad = (p: Partial<SimMaterial>) => validateMaterial({ ...ok, tangent: undefined, ...p }, []).length;
  assert.equal(bad({ E: 0 }), 1);
  assert.equal(bad({ E: NaN }), 1);
  assert.equal(bad({ nu: 0.5 }), 1);
  assert.equal(bad({ nu: -0.1 }), 1);
  assert.equal(bad({ density: 0 }), 1);
  assert.equal(bad({ k: 0 }), 1);
  assert.equal(bad({ yield: -1 }), 1);
  assert.equal(bad({ tangent: ok.E }), 1);
  assert.equal(validateMaterial({ ...ok, yield: undefined }, []).length, 1, "Et sem cedência");
});

test("validateMaterial: campos ilegíveis não repetem erro, os restantes continuam a ser verificados", () => {
  const m = { ...ok, E: NaN, nu: 0.6 };
  assert.deepEqual(validateMaterial(m, [], new Set(["E"])), ["ν tem de estar entre 0 e 0,5 (exclusive)."]);
  // Et depende de E: com E ilegível não se compara
  assert.deepEqual(validateMaterial({ ...ok, E: NaN }, [], new Set(["E"])), []);
});

test("sanitizeMaterials: descarta lixo, inválidos e repetidos; só guarda campos conhecidos", () => {
  assert.deepEqual(sanitizeMaterials(null), []);
  assert.deepEqual(sanitizeMaterials({ name: "x" }), []);
  const out = sanitizeMaterials([
    { ...ok, extra: "<script>", source: "  ficha  " },
    { ...ok, name: "AÇO DO FORNECEDOR X" },
    { name: "Sem E", nu: 0.3, density: 1 },
    { name: "Poisson", E: 1, nu: 0.7, density: 1 },
    { name: SIM_MATERIALS[0].name, E: 1, nu: 0.3, density: 1 },
    { name: "Texto", E: "210000", nu: 0.3, density: 1 },
    "x", 3,
  ]);
  assert.deepEqual(out, [{ ...ok, source: "ficha" }]);
});

test("validateMaterial: curva plástica multilinear coerente com a cedência e sem Et", () => {
  const c: SimMaterial = { ...ok, tangent: undefined, plasticCurve: [[355, 0], [400, 0.02], [420, 0.08]] };
  assert.deepEqual(validateMaterial(c, []), []);
  const errs = (p: Partial<SimMaterial>) => validateMaterial({ ...c, ...p }, []);
  assert.match(errs({ yield: 300 }).join(" "), /cedência tem de ser igual/);
  assert.match(errs({ tangent: 2000 }).join(" "), /não os dois/);
  assert.match(errs({ plasticCurve: [[355, 0.001], [400, 0.02]] }).join(" "), /εp = 0/);
  assert.match(errs({ plasticCurve: [[355, 0], [400, 0.02], [410, 0.02]] }).join(" "), /εp tem de crescer.*ponto 3/);
  assert.match(errs({ plasticCurve: [[355, 0], [340, 0.02]] }).join(" "), /amolecimento/);
  assert.deepEqual(errs({ plasticCurve: [[355, 0]] }), ["A curva plástica precisa de pelo menos 2 pontos."]);
  assert.match(errs({ plasticCurve: [[355, 0], [NaN, 0.02]] }).join(" "), /não são números/);
});

test("sanitizeMaterials: guarda a curva válida e descarta só a curva malformada", () => {
  const c = { ...ok, name: "Com curva", tangent: undefined, plasticCurve: [[355, 0], [400, 0.02]] };
  const out = sanitizeMaterials([c, { ...c, name: "Curva lixo", plasticCurve: [[1, "x"]] }, { ...c, name: "Curva não lista", plasticCurve: "355;0" }]);
  assert.deepEqual(out.map((m) => m.name), ["Com curva", "Curva lixo", "Curva não lista"]);
  assert.deepEqual(out[0].plasticCurve, [[355, 0], [400, 0.02]]);
  assert.equal(out[1].plasticCurve, undefined);
  assert.equal(out[2].plasticCurve, undefined);
  // curva bem formada mas incoerente com a cedência → material descartado
  assert.deepEqual(sanitizeMaterials([{ ...c, yield: 300 }]), []);
});

test("allMaterials: referência primeiro, depois os do utilizador, sem alterar a referência", () => {
  const before = SIM_MATERIALS.length;
  const all = allMaterials([ok]);
  assert.equal(all.length, before + 1);
  assert.equal(all[before], ok);
  assert.equal(SIM_MATERIALS.length, before);
});

test("materiais de referência: válidos e com α na escala de 10⁻⁶/K usada no formulário", () => {
  for (const m of SIM_MATERIALS) {
    const others = SIM_MATERIALS.filter((x) => x !== m);
    // a validação recusa nomes de referência; aqui interessa só a física
    const errs = validateMaterial({ ...m, name: `${m.name} #` }, others);
    assert.deepEqual(errs, [], m.name);
    if (m.alpha !== undefined) assert.ok(m.alpha > 1e-7 && m.alpha < 1e-4, `${m.name}: α=${m.alpha}`);
  }
});

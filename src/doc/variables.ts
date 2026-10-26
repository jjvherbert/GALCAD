// Variáveis globais e equações: resolução por ordem de dependências, com deteção de ciclos.
import { evalExpr, exprIdentifiers, isValidName, ExprError, type Scope } from "./expr.ts";
import type { Expr, Variable } from "./types.ts";

export interface ResolvedVariables {
  values: Map<string, number>;
  errors: Map<string, string>;
  scope: Scope;
}

export function resolveVariables(vars: Variable[]): ResolvedVariables {
  const values = new Map<string, number>();
  const errors = new Map<string, string>();
  const byName = new Map<string, Variable>();
  for (const v of vars) {
    if (!isValidName(v.name)) errors.set(v.name, `Nome inválido "${v.name}"`);
    else if (byName.has(v.name)) errors.set(v.name, `Nome repetido "${v.name}"`);
    else byName.set(v.name, v);
  }
  const state = new Map<string, "visiting" | "done">();

  const visit = (name: string, chain: string[]): number | undefined => {
    if (values.has(name)) return values.get(name);
    if (errors.has(name)) return undefined;
    const v = byName.get(name);
    if (!v) return undefined;
    if (state.get(name) === "visiting") {
      const cycle = [...chain.slice(chain.indexOf(name)), name].join(" → ");
      for (const n of chain.slice(chain.indexOf(name))) errors.set(n, `Dependência circular: ${cycle}`);
      return undefined;
    }
    state.set(name, "visiting");
    try {
      for (const dep of exprIdentifiers(v.expr)) {
        if (!byName.has(dep)) throw new ExprError(`Variável desconhecida "${dep}"`, 0);
        visit(dep, [...chain, name]);
        if (errors.has(dep)) throw new ExprError(`Depende de "${dep}", que tem erro`, 0);
      }
      if (errors.has(name)) return undefined;
      const value = evalExpr(v.expr, (n) => values.get(n));
      values.set(name, value);
      return value;
    } catch (e) {
      if (!errors.has(name)) errors.set(name, (e as Error).message);
      return undefined;
    } finally {
      state.set(name, "done");
    }
  };

  for (const name of byName.keys()) visit(name, []);
  return { values, errors, scope: (n) => values.get(n) };
}

/** Avalia um parâmetro de feature; mensagens de erro identificam o campo. */
export function evalParam(value: Expr | undefined, scope: Scope, label: string, fallback?: number): number {
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`${label}: valor em falta`);
  }
  try {
    return evalExpr(value, scope);
  } catch (e) {
    throw new Error(`${label}: ${(e as Error).message}`);
  }
}

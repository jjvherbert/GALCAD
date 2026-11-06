// Verificação do modelo do painel de simulação.
import { type Study } from "../doc/study.ts";
import { store } from "./store.ts";
import { Fragment } from "preact";
import { CAPABILITIES, checkStudy, solverVerdict, usedFeatures } from "../sim/modelcheck.ts";

const ICON = { erro: "✖", aviso: "⚠", info: "ℹ" } as const;
const SUPPORT = { sim: ["✓", "sim", "Suportado"], parcial: ["◐", "parcial", "Suportado com restrições"], nao: ["✕", "nao", "Não suportado"] } as const;
const SOLVER_NAME = { calculix: "CalculiX", code_aster: "code_aster", openradioss: "OpenRadioss" } as const;


/** Verificação dos dados do modelo e matriz de compatibilidade por solver (como o Model Check do Abaqus). */
export function CheckPanel({ s, assembly, up }: { s: Study; assembly: boolean; up: (p: Partial<Study>) => void }) {
  const items = checkStudy(s, assembly);
  const fem = s.physics === "fem" ? s : null;
  const used = fem ? usedFeatures(fem) : [];
  return (
    <>
      <p class="field-hint">Confere o modelo antes do solver: erros bloqueiam o cálculo, avisos não. Clique num item para ir à secção onde se corrige.</p>
      {items.length === 0 && <div class="kw-item ok"><b>✓ Sem problemas</b><p class="muted">Nada a assinalar nos dados do modelo (não substitui a verificação da malha e da convergência).</p></div>}
      <ul class="check-list">
        {items.map((i, k) => (
          <li key={k} class={`chk chk-${i.level}`}>
            <button onClick={() => store.set({ simSection: i.where === "sets" ? "conditions" : i.where })}><span class="chk-ic">{ICON[i.level]}</span><span>{i.text}</span></button>
          </li>
        ))}
      </ul>
      {fem && (
        <details class="solver-matrix" open>
          <summary>Compatibilidade por solver</summary>
          <div class="row verdicts">
            {(["calculix", "code_aster", "openradioss"] as const).map((sv) => {
              const v = solverVerdict(fem, sv);
              const [ic, cls, tip] = SUPPORT[v.support];
              return (
                <button key={sv} class={`verdict v-${cls} ${(fem.solver ?? "calculix") === sv ? "cur" : ""}`} title={v.reasons.join("\n") || tip} onClick={() => up({ solver: sv } as never)}>
                  <b>{ic} {SOLVER_NAME[sv]}</b><small>{(fem.solver ?? "calculix") === sv ? "em uso" : v.support === "sim" ? "usar" : v.support === "parcial" ? "com restrições" : "incompatível"}</small>
                </button>
              );
            })}
          </div>
          <table class="matrix">
            <thead><tr><th /><th>CalculiX</th><th>code_aster</th><th>OpenRadioss</th></tr></thead>
            <tbody>
              {CAPABILITIES.map((c, k) => (
                <Fragment key={c.feature}>
                  {(k === 0 || CAPABILITIES[k - 1].group !== c.group) && <tr key={`g${c.group}`} class="grp"><td colSpan={4}>{c.group}</td></tr>}
                  <tr key={c.feature} class={used.includes(c.feature) ? "used" : ""} title={c.note}>
                    <td>{c.feature}{used.includes(c.feature) && <i title="Usado neste estudo"> ●</i>}</td>
                    {(["calculix", "code_aster", "openradioss"] as const).map((sv) => <td key={sv} class={`sup-${SUPPORT[c[sv]][1]}`} title={SUPPORT[c[sv]][2]}>{SUPPORT[c[sv]][0]}</td>)}
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
          <p class="field-hint">● = usado neste estudo. A matriz descreve o que os adaptadores deste software implementam e verificam, não tudo o que cada solver sabe fazer.</p>
        </details>
      )}
    </>
  );
}

// Diálogo «Materiais…»: biblioteca de materiais do utilizador ao lado dos de referência (só leitura).
// Os estudos guardam uma cópia do material, por isso editar ou apagar aqui não altera estudos existentes.
import { useEffect, useRef, useState } from "preact/hooks";
import { store, useStoreKeys } from "./store.ts";
import { validateMaterial } from "./material-library.ts";
import { SIM_MATERIALS, type SimMaterial } from "../doc/study.ts";

type Key = "name" | "E" | "nu" | "density" | "alpha" | "k" | "yield" | "tangent" | "source";
type Draft = Record<Key, string>;
/** Campos do formulário: chave, rótulo, unidade, escala (valor guardado = texto × escala), obrigatório. */
const FIELDS: [Exclude<Key, "name" | "source">, string, string, number, boolean][] = [
  ["E", "Módulo de Young E", "MPa", 1, true],
  ["nu", "Coeficiente de Poisson ν", "", 1, true],
  ["density", "Massa volúmica ρ", "g/cm³", 1, true],
  ["alpha", "Dilatação térmica α", "10⁻⁶/K", 1e-6, false],
  ["k", "Condutividade k", "W/(m·K)", 1, false],
  ["yield", "Tensão de cedência", "MPa", 1, false],
  ["tangent", "Módulo tangente Et", "MPa", 1, false],
];

const fmt = (v: number | undefined, scale = 1) => (v === undefined ? "" : String(Number((v / scale).toPrecision(10))));
const toDraft = (m: SimMaterial): Draft => ({
  name: m.name, source: m.source ?? "",
  ...Object.fromEntries(FIELDS.map(([k, , , s]) => [k, fmt(m[k], s)])),
} as Draft);
const EMPTY: Draft = { name: "", E: "", nu: "", density: "", alpha: "", k: "", yield: "", tangent: "", source: "" };

/** Texto do formulário → material (aceita vírgula decimal) e erros de leitura dos números. */
function fromDraft(d: Draft): { m: SimMaterial; errors: string[]; unread: Set<keyof SimMaterial> } {
  const errors: string[] = [];
  const unread = new Set<keyof SimMaterial>();
  const m: SimMaterial = { name: d.name.trim(), E: NaN, nu: NaN, density: NaN };
  for (const [k, label, , scale, required] of FIELDS) {
    const t = d[k].trim().replace(",", ".");
    if (!t) { if (required) { errors.push(`${label}: valor em falta.`); unread.add(k); } continue; }
    const v = Number(t);
    if (!Number.isFinite(v)) { errors.push(`${label}: «${d[k].trim()}» não é um número.`); unread.add(k); continue; }
    m[k] = v * scale;
  }
  if (d.source.trim()) m.source = d.source.trim();
  return { m, errors, unread };
}

const summary = (m: SimMaterial) =>
  `E ${m.E.toLocaleString("pt-PT")} MPa · ν ${m.nu} · ρ ${m.density}${m.yield ? ` · cedência ${m.yield} MPa` : ""}`;

export function MaterialsDialog() {
  const { userMaterials: user } = useStoreKeys("userMaterials");
  /** Material do utilizador em edição (nome original), null = novo, undefined = sem formulário. */
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<string[]>([]);
  const initial = useRef<Draft>(EMPTY);
  const dirty = editing !== undefined && (Object.keys(draft) as Key[]).some((k) => draft[k] !== initial.current[k]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const discardOk = () => !dirtyRef.current || confirm("Descartar as alterações a este material?");
  const close = () => { if (discardOk()) store.set({ showMaterials: false }); };
  const open = (orig: string | null, d: Draft) => {
    if (!discardOk()) return;
    initial.current = d; setDraft(d); setEditing(orig); setErrors([]);
  };
  const copyName = (name: string) => {
    for (let i = 1; ; i++) {
      const n = i === 1 ? `${name} (cópia)` : `${name} (cópia ${i})`;
      if (!validateMaterial({ name: n, E: 1, nu: 0, density: 1 }, user).length) return n;
    }
  };

  const save = () => {
    const { m, errors: parse, unread } = fromDraft(draft);
    const others = user.filter((x) => x.name !== editing);
    const errs = [...parse, ...validateMaterial(m, others, unread)];
    setErrors(errs);
    if (errs.length) return;
    store.updateMaterials(editing === null ? [...user, m] : user.map((x) => (x.name === editing ? m : x)));
    const d = toDraft(m);
    initial.current = d; setDraft(d); setEditing(m.name);
  };
  const remove = (name: string) => {
    if (!confirm(`Apagar o material «${name}»? Os estudos que já o usam mantêm a sua cópia.`)) return;
    store.updateMaterials(user.filter((x) => x.name !== name));
    if (editing === name) { initial.current = EMPTY; setEditing(undefined); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); e.stopImmediatePropagation(); } };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);

  const set = (k: Key) => (e: Event) => setDraft({ ...draft, [k]: (e.currentTarget as HTMLInputElement).value });

  return (
    <div class="modal-back" onClick={close}>
      <div class="modal materials" role="dialog" aria-modal="true" aria-label="Materiais" onClick={(e) => e.stopPropagation()}>
        <h2>Materiais</h2>
        <p class="muted">Os seus materiais ficam guardados neste browser e aparecem nos seletores de material. Cada estudo guarda uma cópia do material, por isso editar ou apagar aqui não altera estudos já criados.</p>
        <div class="mat-body">
          <div class="mat-list">
            <div class="mat-head"><h3>Os meus materiais</h3><button onClick={() => open(null, EMPTY)}>+ Novo</button></div>
            {!user.length && <p class="muted">Ainda não tem materiais. Crie um novo ou duplique um de referência.</p>}
            <ul>
              {user.map((m) => (
                <li key={m.name} class={editing === m.name ? "on" : ""}>
                  <button class="mat-pick" onClick={() => open(m.name, toDraft(m))}><b>{m.name}</b><small>{summary(m)}</small></button>
                  <button class="icon danger" title="Apagar" aria-label={`Apagar ${m.name}`} onClick={() => remove(m.name)}>✕</button>
                </li>
              ))}
            </ul>
            <h3>Referência</h3>
            <ul>
              {SIM_MATERIALS.map((m) => (
                <li key={m.name}>
                  <span class="mat-pick"><b>{m.name}</b><small>{summary(m)}</small></span>
                  <button title="Criar um material seu a partir deste" onClick={() => open(null, { ...toDraft(m), name: copyName(m.name) })}>Duplicar</button>
                </li>
              ))}
            </ul>
          </div>
          <div class="mat-form">
            {editing === undefined ? <p class="muted">Escolha um material seu para o editar, ou crie um novo.</p> : (
              <>
                <h3>{editing === null ? "Novo material" : "Editar material"}</h3>
                <label class="row"><span>Nome</span><input value={draft.name} onInput={set("name")} /></label>
                {FIELDS.map(([k, label, unit, , req]) => (
                  <label key={k} class="row"><span>{label}{req ? " *" : ""}</span>
                    <span class="unit"><input inputMode="decimal" value={draft[k]} onInput={set(k)} placeholder={req ? "" : "opcional"} /><small>{unit}</small></span>
                  </label>
                ))}
                <label class="row"><span>Fonte / notas</span><input value={draft.source} onInput={set("source")} placeholder="ex.: ficha técnica do fornecedor" /></label>
                <p class="muted">* obrigatório. Sem k não há análise térmica; sem cedência não há fator de segurança nem plasticidade.</p>
                {!!errors.length && <ul class="mat-errors" role="alert">{errors.map((x) => <li key={x}>{x}</li>)}</ul>}
                <div class="actions"><span class="grow" />
                  {dirty && <button onClick={() => { setDraft(initial.current); setErrors([]); }}>Repor</button>}
                  <button class="primary" disabled={!dirty} onClick={save}>Guardar</button>
                </div>
              </>
            )}
          </div>
        </div>
        <div class="actions"><span class="grow" /><button onClick={close}>Fechar</button></div>
      </div>
    </div>
  );
}

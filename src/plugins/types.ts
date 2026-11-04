// Contrato dos plugins de domínio: cada tipo de feature de um plugin declara {schema, build, ui, help}.
// - schema: `params` (ParamDef) — valores por omissão e limites, validados pelo núcleo antes de construir;
// - build: `PluginBuildersFor<M>` — um construtor por tipo, com os parâmetros tipados pelas chaves de `params`;
// - ui: o formulário é gerado a partir de `params` (ExprInput por parâmetro + operação);
// - help: `help`, obrigatório, mostrado na toolbar e no painel de propriedades.
// Metadados (UI) e geometria (worker) ficam em ficheiros separados para a UI não carregar o núcleo.
import type { Shape3D } from "replicad";

export interface ParamDef {
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  /** O valor tem de ser inteiro (ex.: número de secções). */
  integer?: boolean;
}

/** Ajuda de um tipo de feature de plugin (mesma forma que `Help` da app, sem figura). */
export interface PluginHelp {
  title: string;
  what: string;
  steps: string[];
  tip?: string;
}

export interface PluginKind {
  label: string;
  params: Record<string, ParamDef>;
  help: PluginHelp;
}

export interface PluginMeta {
  id: string;
  name: string;
  kinds: Record<string, PluginKind>;
}

export interface PluginResult {
  shape: Shape3D;
  info?: { title: string; rows: [string, string][]; note?: string };
}

export type PluginBuilder<P extends string = string> = (params: Record<P, number>) => PluginResult;

/** Um construtor por tipo declarado nos metadados: tipo sem geometria (ou geometria sem tipo) não compila. */
export type PluginBuildersFor<M extends PluginMeta> = {
  readonly [K in keyof M["kinds"]]: PluginBuilder<keyof M["kinds"][K]["params"] & string>;
};

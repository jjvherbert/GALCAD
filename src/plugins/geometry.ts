// Registo de plugins (geometria, só no worker).
import type { PluginBuilder, PluginBuildersFor } from "./types.ts";
import type { PLUGIN_METAS } from "./meta.ts";
import { nauticaBuilders } from "./nautica/geometry.ts";

type Metas = typeof PLUGIN_METAS;

/** Geometria por plugin instalado: plugin com metadados e sem geometria não compila. */
const BUILDERS: { readonly [P in keyof Metas]: PluginBuildersFor<Metas[P]> } = { nautica: nauticaBuilders };

/** Construtor de um tipo de feature de plugin (indefinido se não estiver instalado). */
export function pluginBuilder(plugin: string, kind: string): PluginBuilder | undefined {
  const kinds = (BUILDERS as Record<string, Record<string, PluginBuilder>>)[plugin];
  return kinds && Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
}

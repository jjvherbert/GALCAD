// Registo mínimo de plugins: cada plugin regista-se (metadados + flag opcional que o ativa).
// Só tipos do próprio módulo `plugins/`; quem decide as flags (definições da app) passa-as por argumento,
// porque o worker não tem localStorage.
import type { PluginMeta } from "./types.ts";

/** Flags de ativação dos plugins (guardadas em `settings.plugins`). */
export interface PluginFlags { galkeelHull: boolean }

export interface PluginRegistration {
  meta: PluginMeta;
  /** Flag que ativa o plugin; sem flag, o plugin está sempre ativo. */
  flag?: keyof PluginFlags;
}

const registry = new Map<string, PluginRegistration>();

export function registerPlugin(r: PluginRegistration): void {
  registry.set(r.meta.id, r);
}

/** Plugins ativos para as flags dadas (os que não dependem de flag estão sempre ativos). */
export function activePlugins(flags: PluginFlags): PluginMeta[] {
  return [...registry.values()].filter((r) => !r.flag || flags[r.flag]).map((r) => r.meta);
}

/** Plugin instalado, esteja ou não ativo (para ler documentos antigos e ajuda). */
export function knownPlugin(id: string): PluginMeta | undefined {
  return registry.get(id)?.meta;
}

/** Todas as flags ligadas: o conjunto dos plugins instalados. */
export const ALL_PLUGIN_FLAGS: PluginFlags = { galkeelHull: true };

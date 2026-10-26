// Contrato dos plugins de domínio.
// Metadados (UI) e geometria (worker) ficam em ficheiros separados para a UI não carregar o núcleo.
import type { Shape3D } from "replicad";

export interface ParamDef {
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
}

export interface PluginKind {
  label: string;
  params: Record<string, ParamDef>;
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

export type PluginBuilders = Record<string, (params: Record<string, number>) => PluginResult>;

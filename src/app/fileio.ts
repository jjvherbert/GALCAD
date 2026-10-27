// Operações de ficheiro da interface: abrir, guardar, importar e exportar.
import { FILE_EXTENSION, serialize } from "../doc/io.ts";
import type { ExportFormat } from "../kernel/protocol.ts";
import { store } from "./store.ts";

/** Nome de ficheiro portável: sem acentos nem caracteres especiais (alguns browsers rejeitam-nos). */
export const safeFileName = (n: string) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_") || "peca";

export function download(name: string, data: BlobPart, mime: string) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([data], { type: mime })), download: safeFileName(name), hidden: true });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Pede um ficheiro ao utilizador e devolve o nome e o texto. */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept, hidden: true });
    input.dataset.role = accept.includes("json") ? "open-project" : "import-step";
    document.body.appendChild(input);
    input.onchange = async () => {
      const f = input.files?.[0];
      input.remove();
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.click();
  });
}

export async function openProject() {
  const f = await pickTextFile(".json,.cadp.json,application/json");
  if (!f) return;
  try { store.open(f.text, f.name); } catch (e) { store.set({ error: (e as Error).message }); }
}

export function saveProject() {
  const st = store.state;
  download(`${st.fileName || st.doc.name}${FILE_EXTENSION}`, serialize(st.doc), "application/json");
  store.set({ dirty: false, message: "Projeto guardado" });
}

export async function importStep() {
  const f = await pickTextFile(".step,.stp");
  if (f) store.addImport(f.name, f.text);
}

export async function exportAs(format: ExportFormat) {
  const st = store.state;
  try {
    const r = await store.kernel.export(format, st.doc.name);
    download(`${st.fileName || st.doc.name}.${r.ext}`, r.data as BlobPart, r.mime);
    store.set({ message: `Exportado ${r.ext.toUpperCase()} (${Math.round(r.data.length / 1024)} kB, mm)` });
  } catch (e) {
    store.set({ error: (e as Error).message });
  }
}

export const EXPORTS: [ExportFormat, string][] = [
  ["step", "STEP (AP214) — sólido exato"], ["stl", "STL binário — impressão 3D"], ["3mf", "3MF — impressão 3D"],
  ["obj", "OBJ — malha"], ["glb", "glTF binário (.glb) — visualização"],
];

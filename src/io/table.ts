// Exportação de tabelas (BOM): CSV (UTF-8 com BOM, para o Excel em português) e XLSX mínimo.
import { zipStore } from "./mesh-export.ts";

/** CSV com separador ";" (o Excel em pt-PT usa a vírgula como separador decimal). */
export function toCSV(header: string[], rows: string[][], sep = ";"): string {
  const esc = (v: string) => (v.includes(sep) || /["\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return "﻿" + [header, ...rows].map((r) => r.map(esc).join(sep)).join("\r\n") + "\r\n";
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i: number) => { let s = ""; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

export interface Sheet { name: string; header: string[]; rows: string[][] }

/** Folha de cálculo XLSX (Office Open XML) com uma folha; números em células numéricas. */
export function toXLSX(sheetName: string, header: string[], rows: string[][]): Uint8Array {
  return toXLSXSheets([{ name: sheetName, header, rows }]);
}

/** Livro XLSX com várias folhas (cabeçalho a negrito; números em células numéricas). */
export function toXLSXSheets(sheets: Sheet[]): Uint8Array {
  const enc = new TextEncoder();
  const cell = (v: string, r: number, c: number, bold = false) => {
    const ref = `${colName(c)}${r}`;
    const num = /^-?\d+(,\d+)?$/.test(v) ? Number(v.replace(",", ".")) : NaN;
    if (!Number.isNaN(num) && !bold) return `<c r="${ref}"><v>${num}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ""}><is><t>${xml(v)}</t></is></c>`;
  };
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const names = sheets.map((sh, i) => (sh.name.replace(/[\\/?*\[\]:]/g, " ").slice(0, 31) || `Folha${i + 1}`));
  const files = [
    { name: "[Content_Types].xml", text: `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", text: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", text: `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", text: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", text: `${head}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>` },
    ...sheets.map((sh, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      text: `${head}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${[sh.header, ...sh.rows].map((r, k) => `<row r="${k + 1}">${r.map((v, c) => cell(v, k + 1, c, k === 0)).join("")}</row>`).join("")}</sheetData></worksheet>`,
    })),
  ];
  return zipStore(files.map((f) => ({ name: f.name, data: enc.encode(f.text) })));
}

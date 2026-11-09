import * as XLSX from "xlsx";

export type Row = Record<string, unknown>;

// "Item Code:" -> "item code"
const norm = (h: unknown) => String(h ?? "").replace(/:/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** Reads the first sheet of an .xls, .xlsx or .csv file into rows keyed by normalised header. */
export function readSheet(data: ArrayBuffer): Row[] {
  const wb = XLSX.read(data, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: false });
  if (raw.length < 2) return [];
  const headers = (raw[0] as unknown[]).map(norm);
  return raw.slice(1).map((cells) => {
    const o: Row = {};
    headers.forEach((h, i) => { if (h) o[h] = (cells as unknown[])[i]; });
    return o;
  });
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function text(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

/** Accepts Date objects, Excel serial numbers and ISO / dd/mm/yyyy strings; returns yyyy-mm-dd. */
export function isoDate(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    // SheetJS returns local-midnight Dates; format with local parts to avoid a day shift.
    const p = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v === "number" && v > 20000 && v < 80000)
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const s = text(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

export function pick(row: Row, ...names: string[]): unknown {
  for (const n of names) if (n in row) return row[n];
  return undefined;
}

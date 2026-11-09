import { readSheet, num, text, pick } from "../sheet";
import { normalizeUnit } from "../units";
import type { ParseResult } from "./types";

export interface OpeningRow {
  code: number; name: string; group: string; unit: string; qty: number;
}

export function parseOpening(data: ArrayBuffer): ParseResult<OpeningRow> {
  const rows: OpeningRow[] = [];
  const errors: string[] = [];
  readSheet(data).forEach((r, i) => {
    const line = i + 2;
    const code = num(pick(r, "item code", "code"));
    const qty = num(pick(r, "quantity", "qty", "counted qty", "counted", "stock"));
    if (code === null) return errors.push(`Row ${line}: missing item code`);
    if (qty === null) return errors.push(`Row ${line}: missing quantity`);
    rows.push({
      code, qty,
      name: text(pick(r, "item name", "name")), group: text(pick(r, "group name", "group")),
      unit: normalizeUnit(pick(r, "units", "unit")),
    });
  });
  return { rows, errors };
}

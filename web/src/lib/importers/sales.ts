import { readSheet, num, text, pick } from "../sheet";
import type { ParseResult } from "./types";

export interface SalesRow {
  code: number; name: string; source: string; group: string;
  unit_price: number | null; qty: number; gross: number | null;
  account: string; tax_total: number | null; net: number | null;
}

/** Nomad "Sales Report" export. It has no dates or branch: those are chosen at upload. */
export function parseSales(data: ArrayBuffer): ParseResult<SalesRow> {
  const rows: SalesRow[] = [];
  const errors: string[] = [];
  readSheet(data).forEach((r, i) => {
    const line = i + 2;
    const code = num(pick(r, "item code"));
    const qty = num(pick(r, "sold qty", "quantity", "qty"));
    if (code === null && qty === null && !text(pick(r, "item name"))) return; // blank row
    if (code === null) return errors.push(`Row ${line}: missing item code`);
    if (qty === null) return errors.push(`Row ${line}: missing sold quantity`);
    rows.push({
      code, qty,
      name: text(pick(r, "item name")), source: text(pick(r, "item source")), group: text(pick(r, "group name")),
      unit_price: num(pick(r, "unit price")), gross: num(pick(r, "gross total")),
      account: text(pick(r, "income account")), tax_total: num(pick(r, "tax total")), net: num(pick(r, "net sales")),
    });
  });
  return { rows, errors };
}

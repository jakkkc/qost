import { readSheet, num, text, isoDate, pick } from "../sheet";
import { normalizeUnit } from "../units";
import type { ParseResult } from "./types";

export interface PurchaseRow {
  code: number; name: string; group: string; unit: string;
  price: number; date: string; qty: number;
  net: number | null; tax: number | null; total: number | null;
  po: string; grn: number; posted_by: string;
}

export function parsePurchasing(data: ArrayBuffer): ParseResult<PurchaseRow> {
  const rows: PurchaseRow[] = [];
  const errors: string[] = [];
  readSheet(data).forEach((r, i) => {
    const line = i + 2;
    const code = num(pick(r, "item code"));
    const grn = num(pick(r, "grn no"));
    const price = num(pick(r, "purchase price"));
    const qty = num(pick(r, "quantity"));
    const date = isoDate(pick(r, "purchase date"));
    if (code === null) return errors.push(`Row ${line}: missing item code`);
    if (grn === null) return errors.push(`Row ${line}: missing GRN number`);
    if (price === null || qty === null) return errors.push(`Row ${line}: missing price or quantity`);
    if (!date) return errors.push(`Row ${line}: unreadable purchase date`);
    rows.push({
      code, grn, price, qty, date,
      name: text(pick(r, "item name")), group: text(pick(r, "group name")),
      unit: normalizeUnit(pick(r, "units")),
      net: num(pick(r, "net amount")), tax: num(pick(r, "tax")), total: num(pick(r, "total")),
      po: String(num(pick(r, "purchase order no")) ?? "").replace(/^0$/, ""),
      posted_by: text(pick(r, "posted by")),
    });
  });
  return { rows, errors };
}

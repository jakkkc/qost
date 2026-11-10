import { readSheet, num, text, pick } from "../sheet";
import type { ParseResult } from "./types";

export interface CountRow { name: string; qty: number }

/** Kitchen stock-take sheet: ingredient name (as on the workbook Items sheet) and counted quantity. */
export function parseCounts(data: ArrayBuffer): ParseResult<CountRow> {
  const rows: CountRow[] = [];
  const errors: string[] = [];
  readSheet(data).forEach((r, i) => {
    const name = text(pick(r, "item", "ingredient", "item name", "name"));
    const qty = num(pick(r, "quantity", "qty", "count", "counted", "closing", "kitchen closing"));
    if (!name && qty === null) return;
    if (!name) return errors.push(`Row ${i + 2}: missing ingredient name`);
    if (qty === null) return; // a blank count means nothing was counted, like the workbook
    rows.push({ name, qty });
  });
  return { rows, errors };
}

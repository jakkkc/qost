import { readSheet, num, text, isoDate, pick } from "../sheet";
import { normalizeUnit } from "../units";
import type { ParseResult } from "./types";

export interface IssueRow {
  code: number; name: string; group: string; unit: string;
  price: number; date: string; qty: number; req: number;
  total: number | null; posted_by: string;
}

export function parseIssued(data: ArrayBuffer): ParseResult<IssueRow> {
  const rows: IssueRow[] = [];
  const errors: string[] = [];
  readSheet(data).forEach((r, i) => {
    const line = i + 2;
    const code = num(pick(r, "item code"));
    const req = num(pick(r, "reqno", "req no", "requisition no"));
    const qty = num(pick(r, "qissued", "quantity issued", "quantity"));
    const price = num(pick(r, "issueprice", "issue price"));
    // The system labels the issue date column "Purchase Date".
    const date = isoDate(pick(r, "issue date", "purchase date", "date"));
    if (code === null) return errors.push(`Row ${line}: missing item code`);
    if (req === null) return errors.push(`Row ${line}: missing requisition number`);
    if (qty === null || price === null) return errors.push(`Row ${line}: missing quantity or issue price`);
    if (!date) return errors.push(`Row ${line}: unreadable date`);
    rows.push({
      code, req, qty, price, date,
      name: text(pick(r, "item name")), group: text(pick(r, "group name")),
      unit: normalizeUnit(pick(r, "units")),
      total: num(pick(r, "total")), posted_by: text(pick(r, "posted by")),
    });
  });
  return { rows, errors };
}

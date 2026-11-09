// Smoke test: parse the real sample reports and print what the app would import.
// Run: npx tsx scripts/check-importers.ts "<folder with the three .xls files>"
import fs from "fs";
import path from "path";
import { parsePurchasing } from "../src/lib/importers/purchasing";
import { parseIssued } from "../src/lib/importers/issued";
import { suggestPackSize } from "../src/lib/packSize";

const dir = process.argv[2] ?? "C:/Users/Jackson/Downloads";
const buf = (f: string) => {
  const b = fs.readFileSync(path.join(dir, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const p = parsePurchasing(buf("PURCHASING REPORT.xls"));
console.log("purchases:", p.rows.length, "errors:", p.errors);
console.log(p.rows[0]);

const i = parseIssued(buf("ISSUED ITEMS REPORT.xls"));
console.log("issues:", i.rows.length, "errors:", i.errors);
console.log("issued total:", i.rows.reduce((s, r) => s + (r.total ?? 0), 0));
console.log(i.rows[0]);

console.log("--- pack size suggestions ---");
for (const r of i.rows) {
  const s = suggestPackSize(r.name, r.unit);
  console.log(r.name.padEnd(36), r.unit.padEnd(7), s ? `${s.factor} ${s.base_unit} [${s.confidence}]` : "no suggestion");
}

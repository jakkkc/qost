// Run: npx tsx scripts/check-sales.ts "<SALES REPORT.xls>"
import fs from "fs";
import { parseSales } from "../src/lib/importers/sales";

const file = process.argv[2] ?? "C:/Users/Jackson/Downloads/SALES REPORT.xls";
const b = fs.readFileSync(file);
const { rows, errors } = parseSales(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
console.log("rows:", rows.length, "errors:", errors);
console.log(rows);

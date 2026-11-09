// Parses the real workbook and writes the import payload to a JSON file (for the database test).
// Run: npx tsx scripts/check-workbook.ts "<workbook.xlsx>" [out.json]
import fs from "fs";
import { parseWorkbook } from "../src/lib/importers/workbook";

const file = process.argv[2] ?? "C:/Users/Jackson/Downloads/Recipe_Cost_Control_Workbook (3).xlsx";
const b = fs.readFileSync(file);
const { payload, problems, notes } = parseWorkbook(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
console.log({
  items: payload.items.length, recipes: payload.recipes.length, onMenu: payload.recipes.filter((r) => r.on_menu).length,
  lines: payload.lines.length, packages: payload.packages.length, package_lines: payload.package_lines.length,
  pos: payload.pos.length, links: payload.links.length,
});
console.log("problems:", problems.length, problems.slice(0, 10));
console.log("notes:", notes);
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(payload));

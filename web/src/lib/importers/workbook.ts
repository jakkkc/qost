import * as XLSX from "xlsx";

/** Payload for the import_workbook() SQL function. Names are matched case-insensitively there. */
export interface WorkbookPayload {
  items: { name: string; unit: string; cost: number | null }[];
  recipes: { name: string; category: string | null; menu_price: number | null; on_menu: boolean; key_item: string | null }[];
  lines: { dish: string; item: string; qty: number }[];
  packages: { name: string; price: number | null }[];
  package_lines: { package: string; name: string; qty: number }[];
  pos: { code: number; name: string; group: string | null; price: number | null }[];
  links: { code: number; name: string }[];
}

export interface WorkbookParse {
  payload: WorkbookPayload;
  /** Things that will make the import fail or that the user should know about. */
  problems: string[];
  notes: string[];
}

type Cells = unknown[];
const clean = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();
const key = (v: unknown) => clean(v).toLowerCase();
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
// The workbook leaves "nan" in a couple of cells where a value was missing.
const textOrNull = (v: unknown): string | null => {
  const s = clean(v);
  return s === "" || s.toLowerCase() === "nan" ? null : s;
};

/** Reads the data rows of a sheet: everything from row 5, after the title and header rows. */
function dataRows(wb: XLSX.WorkBook, sheet: string): Cells[] {
  const ws = wb.Sheets[sheet];
  if (!ws) throw new Error(`The workbook has no "${sheet}" sheet.`);
  return XLSX.utils.sheet_to_json<Cells>(ws, { header: 1, defval: null, range: 4, blankrows: false });
}

export function parseWorkbook(data: ArrayBuffer): WorkbookParse {
  const wb = XLSX.read(data, { type: "array" });
  const problems: string[] = [];
  const notes: string[] = [];

  // Items: Item | Unit | Unit Cost | Opening | Par
  const items: WorkbookPayload["items"] = [];
  const itemKeys = new Set<string>();
  for (const r of dataRows(wb, "Items")) {
    const name = clean(r[0]);
    if (!name) continue;
    if (itemKeys.has(key(name))) { problems.push(`Items: "${name}" is listed twice`); continue; }
    itemKeys.add(key(name));
    items.push({ name, unit: clean(r[1]) || "g", cost: numOrNull(r[2]) });
  }

  // Recipes: Dish | Ingredient | Unit | Qty per portion
  const lines: WorkbookPayload["lines"] = [];
  const recipeNames = new Map<string, string>(); // lower -> display
  for (const r of dataRows(wb, "Recipes")) {
    const dish = clean(r[0]), item = clean(r[1]);
    if (!dish || !item) continue;
    const qty = numOrNull(r[3]);
    if (qty === null || qty <= 0) { problems.push(`Recipes: "${dish}" / "${item}" has no quantity`); continue; }
    if (!itemKeys.has(key(item))) { problems.push(`Recipes: "${item}" (in "${dish}") is not on the Items sheet`); continue; }
    recipeNames.set(key(dish), recipeNames.get(key(dish)) ?? dish);
    lines.push({ dish, item, qty });
  }

  // Menu Cost: Dish | Menu Price | ... | Key Ingredient (col H)
  const recipes: WorkbookPayload["recipes"] = [];
  const menuKeys = new Set<string>();
  for (const r of dataRows(wb, "Menu Cost")) {
    const name = clean(r[0]);
    if (!name || menuKeys.has(key(name))) continue;
    menuKeys.add(key(name));
    const keyItem = textOrNull(r[7]);
    if (keyItem && !itemKeys.has(key(keyItem))) problems.push(`Menu Cost: key ingredient "${keyItem}" (dish "${name}") is not on the Items sheet`);
    recipes.push({ name, category: null, menu_price: numOrNull(r[1]), on_menu: true, key_item: keyItem && itemKeys.has(key(keyItem)) ? keyItem : null });
  }
  let menuNoRecipe = 0;
  for (const r of recipes) if (!recipeNames.has(key(r.name))) menuNoRecipe++;
  // Dishes that only appear on the Recipes sheet (sauces, components, package-only dishes) are not on the menu.
  for (const [k, display] of recipeNames) {
    if (!menuKeys.has(k)) recipes.push({ name: display, category: null, menu_price: null, on_menu: false, key_item: null });
  }
  notes.push(`${menuNoRecipe} menu dishes have no recipe yet and will be created empty.`);

  // Package Summary: Package | Price per pax ; Packages: Package | Dish or Item | Type | Qty per pax
  const packages: WorkbookPayload["packages"] = [];
  const pkgKeys = new Set<string>();
  for (const r of dataRows(wb, "Package Summary")) {
    const name = clean(r[0]);
    if (!name || pkgKeys.has(key(name))) continue;
    pkgKeys.add(key(name));
    packages.push({ name, price: numOrNull(r[1]) });
  }
  const package_lines: WorkbookPayload["package_lines"] = [];
  const allDishKeys = new Set([...recipeNames.keys(), ...menuKeys]);
  for (const r of dataRows(wb, "Packages")) {
    const pkg = clean(r[0]), name = clean(r[1]);
    if (!pkg || !name) continue;
    const qty = numOrNull(r[3]);
    if (!pkgKeys.has(key(pkg))) { problems.push(`Packages: "${pkg}" is not on the Package Summary sheet`); continue; }
    if (qty === null || qty <= 0) { problems.push(`Packages: "${pkg}" / "${name}" has no quantity per pax`); continue; }
    if (!allDishKeys.has(key(name)) && !itemKeys.has(key(name))) { problems.push(`Packages: "${name}" (in "${pkg}") is neither a dish nor an ingredient`); continue; }
    package_lines.push({ package: pkg, name, qty });
  }

  // POS Prices: Dish | POS code | POS name | POS group | POS price. One POS code can list several dishes.
  const pos: WorkbookPayload["pos"] = [];
  const posByCode = new Map<number, WorkbookPayload["pos"][number]>();
  const links: WorkbookPayload["links"] = [];
  let notOnPos = 0;
  for (const r of dataRows(wb, "POS Prices")) {
    const dish = clean(r[0]);
    const code = numOrNull(r[1]);
    if (code === null) { if (dish) notOnPos++; continue; }
    if (!posByCode.has(code)) {
      const p = { code, name: clean(r[2]), group: textOrNull(r[3]), price: numOrNull(r[4]) };
      posByCode.set(code, p); pos.push(p);
    }
    if (dish) {
      if (!allDishKeys.has(key(dish)) && !pkgKeys.has(key(dish))) { problems.push(`POS Prices: "${dish}" (POS ${code}) is neither a dish nor a package`); continue; }
      links.push({ code, name: dish });
    }
  }
  notes.push(`${notOnPos} dishes are not on the POS (no POS code).`);
  notes.push(`${pos.length - new Set(links.map((l) => l.code)).size} POS items are not linked to any dish or package.`);

  return { payload: { items, recipes, lines, packages, package_lines, pos, links }, problems, notes };
}

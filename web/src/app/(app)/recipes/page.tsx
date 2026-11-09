"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppShell";
import { fetchAll } from "@/lib/db";
import { ENTRY_UNITS, lineCost, toBase, type EntryUnit, type Measures, type RecipeItem } from "@/lib/recipeUnits";
import { supabase } from "@/lib/supabase";

interface CostRow {
  recipe_id: string; name: string; category: string | null; yield_portions: number; portion_size: string | null;
  selling_price: number | null; target_cost_pct: number | null; cost_per_portion: number | null;
  food_cost_pct: number | null; suggested_price: number | null; over_target: boolean; missing_price: boolean; missing_lines: boolean;
}
interface Line { key: number; itemText: string; qty: string; unit: EntryUnit; yieldPct: string; measure: string }
interface Form { id: string | null; name: string; category: string; yieldPortions: string; portionSize: string; sellingPrice: string; target: string; lines: Line[] }

const inp = "rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/20";
const money = (n: number | null | undefined) => (n === null || n === undefined ? "-" : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));
let keySeq = 1;
const blankLine = (): Line => ({ key: keySeq++, itemText: "", qty: "", unit: "g", yieldPct: "100", measure: "" });
const blankForm = (): Form => ({ id: null, name: "", category: "", yieldPortions: "1", portionSize: "", sellingPrice: "", target: "", lines: [blankLine()] });
const label = (i: RecipeItem) => `${i.code} - ${i.name}`;

export default function RecipesPage() {
  const { tenantId } = useApp();
  const [rows, setRows] = useState<CostRow[]>([]);
  const [items, setItems] = useState<RecipeItem[]>([]);
  const [measures, setMeasures] = useState<Record<string, Measures>>({});
  const [form, setForm] = useState<Form | null>(null);
  const [search, setSearch] = useState("");
  const [flag, setFlag] = useState<"" | "over" | "price" | "lines">("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cr, its, ms] = await Promise.all([
        fetchAll<CostRow>((a, b) => supabase.from("recipe_costs").select("*").order("name").range(a, b)),
        fetchAll<RecipeItem>((a, b) => supabase.from("items").select("id,code,name,purchase_unit,base_unit,last_cost_per_base").order("code").range(a, b)),
        fetchAll<{ item_id: string; measure: "tsp" | "tbsp" | "cup"; base_qty: number }>((a, b) => supabase.from("item_measures").select("item_id,measure,base_qty").range(a, b)),
      ]);
      setRows(cr); setItems(its);
      const m: Record<string, Measures> = {};
      ms.forEach((x) => { (m[x.item_id] ??= {})[x.measure] = Number(x.base_qty); });
      setMeasures(m);
    } catch (e) { setError((e as Error).message); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount
  useEffect(() => { load(); }, [load]);

  const byLabel = useMemo(() => new Map(items.map((i) => [label(i), i])), [items]);

  const shown = rows.filter((r) => {
    if (flag === "over" && !r.over_target) return false;
    if (flag === "price" && !r.missing_price) return false;
    if (flag === "lines" && !r.missing_lines) return false;
    return !search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase());
  });
  const flagged = (pred: (r: CostRow) => boolean) => rows.filter(pred).length;

  async function open(id: string) {
    setError(""); setMessage("");
    const r = rows.find((x) => x.recipe_id === id)!;
    const { data, error: e } = await supabase.from("recipe_lines")
      .select("item_id,entered_qty,entered_unit,qty_base,yield_pct").eq("recipe_id", id).order("id");
    if (e) return setError(e.message);
    const byId = new Map(items.map((i) => [i.id, i]));
    setForm({
      id, name: r.name, category: r.category ?? "", yieldPortions: String(r.yield_portions), portionSize: r.portion_size ?? "",
      sellingPrice: r.selling_price?.toString() ?? "", target: r.target_cost_pct?.toString() ?? "",
      lines: (data ?? []).map((l) => {
        const it = byId.get(l.item_id);
        return { key: keySeq++, itemText: it ? label(it) : "", qty: String(l.entered_qty ?? l.qty_base), unit: (l.entered_unit as EntryUnit) ?? (it?.base_unit === "each" ? "each" : it?.base_unit ?? "g"), yieldPct: String(l.yield_pct), measure: "" };
      }),
    });
  }

  const setLine = (key: number, patch: Partial<Line>) =>
    setForm((f) => f && { ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });

  // Live costing for the open recipe.
  const calc = useMemo(() => {
    if (!form) return null;
    const yp = parseFloat(form.yieldPortions) || 1;
    let batch = 0, unpriced = false;
    const lines = form.lines.map((l) => {
      const item = byLabel.get(l.itemText);
      if (!item) return { l, item: null, base: null as number | null, cost: null as number | null, error: l.itemText ? "Pick an item from the list" : "" };
      const customMeasure = parseFloat(l.measure);
      const m: Measures = { ...(measures[item.id] ?? {}), ...(customMeasure > 0 && (l.unit === "tsp" || l.unit === "tbsp" || l.unit === "cup") ? { [l.unit]: customMeasure } : {}) };
      const c = toBase(parseFloat(l.qty), l.unit, item, m);
      if (!c.ok) return { l, item, base: null, cost: null, error: l.qty ? c.error : "" };
      const cost = lineCost(c.base, parseFloat(l.yieldPct) || 100, item);
      if (cost === null) unpriced = true; else batch += cost;
      return { l, item, base: c.base, cost, error: "" };
    });
    const perPortion = batch / yp;
    const price = parseFloat(form.sellingPrice);
    const target = parseFloat(form.target);
    return {
      lines, unpriced, perPortion,
      foodCost: price > 0 ? (100 * perPortion) / price : null,
      suggested: target > 0 ? perPortion / (target / 100) : null,
      target: target > 0 ? target : null,
    };
  }, [form, byLabel, measures]);

  async function save() {
    if (!form || !calc) return;
    setError(""); setMessage("");
    const used = calc.lines.filter((x) => x.l.itemText || x.l.qty);
    const bad = used.find((x) => !x.item || x.base === null);
    if (bad) return setError(bad.error || "Every ingredient needs an item and a valid quantity.");
    setBusy(true);
    // Remember any new spoon/cup conversions typed on a line.
    for (const x of used) {
      const mv = parseFloat(x.l.measure);
      if (x.item && mv > 0 && (x.l.unit === "tsp" || x.l.unit === "tbsp" || x.l.unit === "cup")) {
        const { error: me } = await supabase.from("item_measures").upsert({ tenant_id: tenantId, item_id: x.item.id, measure: x.l.unit, base_qty: mv });
        if (me) { setBusy(false); return setError(me.message); }
      }
    }
    const { data, error: e } = await supabase.rpc("save_recipe", {
      p_id: form.id,
      p_recipe: { name: form.name, category: form.category, yield_portions: form.yieldPortions, portion_size: form.portionSize, selling_price: form.sellingPrice, target_cost_pct: form.target },
      p_lines: used.map((x) => ({ item_id: x.item!.id, qty_base: x.base, entered_qty: parseFloat(x.l.qty), entered_unit: x.l.unit, yield_pct: parseFloat(x.l.yieldPct) || 100 })),
    });
    setBusy(false);
    if (e) return setError(e.message.includes("recipes_tenant_id_name_key") ? "A recipe with that name already exists." : e.message);
    setMessage("Saved.");
    await load();
    setForm((f) => f && { ...f, id: data as string });
  }

  async function remove() {
    if (!form?.id || !confirm(`Delete "${form.name}"?`)) return;
    const { error: e } = await supabase.from("recipes").delete().eq("id", form.id);
    if (e) return setError(e.message);
    setForm(null); load();
  }

  const duplicate = () => setForm((f) => f && { ...f, id: null, name: `${f.name} (copy)`, lines: f.lines.map((l) => ({ ...l, key: keySeq++ })) });

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Recipes</h1>
      <p className="mb-4 text-sm opacity-70">Costs use each ingredient&apos;s last purchase price (VAT-inclusive) per least unit. Items need a pack size on the Items page before they can be costed.</p>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {message && <p className="mb-3 text-sm text-green-700 dark:text-green-400">{message}</p>}

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <section>
          <div className="mb-2 flex gap-2">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search recipes" className={`${inp} flex-1`} />
            <button onClick={() => { setForm(blankForm()); setMessage(""); setError(""); }} className="rounded bg-orange-500 px-3 py-1 text-white">New</button>
          </div>
          <div className="mb-2 flex flex-wrap gap-2 text-xs">
            {([["", `All (${rows.length})`], ["over", `Over target (${flagged((r) => r.over_target)})`], ["price", `Missing price (${flagged((r) => r.missing_price)})`], ["lines", `No ingredients (${flagged((r) => r.missing_lines)})`]] as const).map(([v, t]) => (
              <button key={v} onClick={() => setFlag(v)} className={`rounded-full border px-2 py-1 ${flag === v ? "border-orange-500 bg-orange-500 text-white" : "border-black/20 dark:border-white/20"}`}>{t}</button>
            ))}
          </div>
          <ul className="divide-y divide-black/10 dark:divide-white/10">
            {shown.map((r) => (
              <li key={r.recipe_id}>
                <button onClick={() => open(r.recipe_id)} className={`w-full px-2 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 ${form?.id === r.recipe_id ? "bg-black/5 dark:bg-white/10" : ""}`}>
                  <span className="flex justify-between gap-2">
                    <span className="font-medium">{r.name}</span>
                    <span className={r.over_target ? "font-medium text-red-600" : ""}>{r.food_cost_pct !== null ? `${r.food_cost_pct}%` : "-"}</span>
                  </span>
                  <span className="text-xs opacity-70">
                    {r.category ?? "No category"} | cost {money(r.cost_per_portion)}
                    {r.missing_price && <b className="ml-1 text-red-600">missing price</b>}
                    {r.missing_lines && <b className="ml-1 text-red-600">no ingredients</b>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!rows.length && <p className="py-6 text-sm opacity-60">No recipes yet. Click New to add the first one.</p>}
        </section>

        {form && calc && (
          <section className="min-w-0 rounded border border-black/10 p-4 dark:border-white/10">
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <label className="text-sm sm:col-span-2">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${inp} mt-1 w-full`} /></label>
              <label className="text-sm">Category<input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={`${inp} mt-1 w-full`} placeholder="Breakfast, Mains..." /></label>
              <label className="text-sm">Portions it makes<input value={form.yieldPortions} onChange={(e) => setForm({ ...form, yieldPortions: e.target.value })} inputMode="decimal" className={`${inp} mt-1 w-full`} /></label>
              <label className="text-sm">Portion size<input value={form.portionSize} onChange={(e) => setForm({ ...form, portionSize: e.target.value })} className={`${inp} mt-1 w-full`} placeholder="e.g. 250 g" /></label>
              <label className="text-sm">Selling price (incl. VAT)<input value={form.sellingPrice} onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })} inputMode="decimal" className={`${inp} mt-1 w-full`} /></label>
              <label className="text-sm">Target food cost %<input value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} inputMode="decimal" className={`${inp} mt-1 w-full`} placeholder="e.g. 30" /></label>
            </div>

            <table className="mb-2 w-full text-left text-sm">
              <thead className="opacity-60"><tr><th>Ingredient</th><th>Qty</th><th>Unit</th><th title="Usable % after trimming or waste">Yield %</th><th className="text-right">Cost</th><th /></tr></thead>
              <tbody>
                {calc.lines.map(({ l, item, cost, error: lineErr }) => {
                  const needsMeasure = item && (l.unit === "tsp" || l.unit === "tbsp" || l.unit === "cup") && item.base_unit !== "ml" && !measures[item.id]?.[l.unit];
                  return (
                    <tr key={l.key} className="border-t border-black/10 align-top dark:border-white/10">
                      <td className="py-1 pr-2">
                        <input list="recipe-items" value={l.itemText} onChange={(e) => setLine(l.key, { itemText: e.target.value })} placeholder="Code or name" className={`${inp} w-full min-w-48`} />
                        {lineErr && <span className="block text-xs text-red-600">{lineErr}</span>}
                        {needsMeasure && (
                          <span className="mt-1 flex items-center gap-1 text-xs">1 {l.unit} = <input value={l.measure} onChange={(e) => setLine(l.key, { measure: e.target.value })} inputMode="decimal" className={`${inp} w-16`} /> {item.base_unit === "g" ? "g" : "each"}</span>
                        )}
                      </td>
                      <td className="pr-2"><input value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} inputMode="decimal" className={`${inp} w-20`} /></td>
                      <td className="pr-2">
                        <select value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value as EntryUnit })} className={inp}>
                          {ENTRY_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                        </select>
                      </td>
                      <td className="pr-2"><input value={l.yieldPct} onChange={(e) => setLine(l.key, { yieldPct: e.target.value })} inputMode="decimal" className={`${inp} w-16`} /></td>
                      <td className="text-right">{item && cost === null && !lineErr ? <span className="text-red-600">no price</span> : money(cost)}</td>
                      <td className="pl-2"><button onClick={() => setForm({ ...form, lines: form.lines.filter((x) => x.key !== l.key) })} className="text-red-600" aria-label="Remove ingredient">x</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <datalist id="recipe-items">{items.map((i) => <option key={i.id} value={label(i)} />)}</datalist>
            <button onClick={() => setForm({ ...form, lines: [...form.lines, blankLine()] })} className="mb-4 text-sm underline">+ Add ingredient</button>

            <div className="mb-4 grid grid-cols-2 gap-3 rounded bg-black/5 p-3 text-sm sm:grid-cols-4 dark:bg-white/10">
              <div><div className="opacity-60">Cost per portion</div><div className="text-lg font-semibold">{money(calc.perPortion)}</div></div>
              <div><div className="opacity-60">Food cost %</div>
                <div className={`text-lg font-semibold ${calc.foodCost !== null && calc.target !== null && calc.foodCost > calc.target ? "text-red-600" : ""}`}>{calc.foodCost !== null ? `${calc.foodCost.toFixed(1)}%` : "-"}</div></div>
              <div><div className="opacity-60">Target</div><div className="text-lg font-semibold">{calc.target ? `${calc.target}%` : "-"}</div></div>
              <div><div className="opacity-60">Suggested price</div><div className="text-lg font-semibold">{money(calc.suggested)}</div></div>
            </div>
            {calc.unpriced && <p className="mb-3 text-sm text-red-600">Some ingredients have no purchase price yet, so this cost is incomplete.</p>}

            <div className="flex flex-wrap items-center gap-3">
              <button onClick={save} disabled={busy} className="rounded bg-orange-500 px-4 py-2 font-medium text-white disabled:opacity-50">{busy ? "Saving..." : "Save recipe"}</button>
              {form.id && <button onClick={duplicate} className="text-sm underline">Duplicate</button>}
              {form.id && <button onClick={remove} className="text-sm text-red-600 underline">Delete</button>}
              <button onClick={() => setForm(null)} className="text-sm underline opacity-70">Close</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

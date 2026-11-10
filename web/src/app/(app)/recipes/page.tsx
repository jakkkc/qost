"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAll } from "@/lib/db";
import { supabase } from "@/lib/supabase";

interface CostRow {
  recipe_id: string; name: string; category: string | null; on_menu: boolean; menu_price: number | null; key_item_id: string | null;
  cost_per_portion: number | null; net_price: number | null; food_cost: number | null; target: number; suggested_price: number | null; flag: string;
}
interface Item { id: string; name: string; unit: string; unit_cost: number | null }
interface Line { key: number; itemText: string; qty: string }
interface Form { id: string | null; name: string; category: string; menuPrice: string; onMenu: boolean; targetPct: string; keyText: string; lines: Line[] }
interface Settings { tax_factor: number; target_cost_max: number }
interface Suggestion { recipe_id: string; dish: string; suggested_item_id: string; suggested_item: string; line_cost: number }

const inp = "rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/20";
const money = (n: number | null | undefined) => (n === null || n === undefined ? "-" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const FLAGS = ["", "No recipe", "No price", "No menu price", "Above target cost", "OK"];
let keySeq = 1;
const blankLine = (): Line => ({ key: keySeq++, itemText: "", qty: "" });
const blankForm = (): Form => ({ id: null, name: "", category: "", menuPrice: "", onMenu: true, targetPct: "", keyText: "", lines: [blankLine()] });

export default function RecipesPage() {
  const [rows, setRows] = useState<CostRow[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [settings, setSettings] = useState<Settings>({ tax_factor: 1.28, target_cost_max: 0.4 });
  const [form, setForm] = useState<Form | null>(null);
  const [search, setSearch] = useState("");
  const [flag, setFlag] = useState("");
  const [menuOnly, setMenuOnly] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sugg, setSugg] = useState<Suggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const [cr, its, st] = await Promise.all([
        fetchAll<CostRow>((a, b) => supabase.from("recipe_costs").select("*").order("name").range(a, b)),
        fetchAll<Item>((a, b) => supabase.from("items").select("id,name,unit,unit_cost").order("name").range(a, b)),
        supabase.from("tenant_settings").select("tax_factor,target_cost_max").limit(1),
      ]);
      setRows(cr); setItems(its);
      if (st.data?.[0]) setSettings({ tax_factor: Number(st.data[0].tax_factor), target_cost_max: Number(st.data[0].target_cost_max) });
    } catch (e) { setError((e as Error).message); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount
  useEffect(() => { load(); }, [load]);

  const byName = useMemo(() => new Map(items.map((i) => [i.name, i])), [items]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const shown = rows.filter((r) => (!menuOnly || r.on_menu) && (!flag || r.flag === flag)
    && (!search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase())));
  const count = (f: string) => rows.filter((r) => (!menuOnly || r.on_menu) && r.flag === f).length;

  async function open(id: string) {
    setError(""); setMessage("");
    const r = rows.find((x) => x.recipe_id === id)!;
    const { data, error: e } = await supabase.from("recipe_lines").select("item_id,qty").eq("recipe_id", id).order("id");
    if (e) return setError(e.message);
    setForm({
      id, name: r.name, category: r.category ?? "", menuPrice: r.menu_price?.toString() ?? "", onMenu: r.on_menu,
      targetPct: "", keyText: r.key_item_id ? byId.get(r.key_item_id)?.name ?? "" : "",
      lines: (data ?? []).map((l) => ({ key: keySeq++, itemText: byId.get(l.item_id)?.name ?? "", qty: String(l.qty) })),
    });
    // The per-recipe override is read separately because the view only exposes the effective target.
    const { data: ov } = await supabase.from("recipes").select("target_override").eq("id", id).single();
    if (ov?.target_override !== null && ov?.target_override !== undefined)
      setForm((f) => f && { ...f, targetPct: String(Math.round(Number(ov.target_override) * 1000) / 10) });
  }

  const setLine = (key: number, patch: Partial<Line>) =>
    setForm((f) => f && { ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });

  const calc = useMemo(() => {
    if (!form) return null;
    let cost = 0, unpriced = false;
    const lines = form.lines.map((l) => {
      const item = byName.get(l.itemText);
      const qty = parseFloat(l.qty);
      const lineCost = item && qty > 0 && item.unit_cost !== null ? qty * item.unit_cost : null;
      if (item && qty > 0) { if (lineCost === null) unpriced = true; else cost += lineCost; }
      return { l, item, qty, lineCost, bad: l.itemText && !item ? "Pick an ingredient from the list" : "" };
    });
    const price = parseFloat(form.menuPrice);
    const net = price > 0 ? price / settings.tax_factor : null;
    const target = parseFloat(form.targetPct) > 0 ? parseFloat(form.targetPct) / 100 : settings.target_cost_max;
    return { lines, cost, unpriced, net, foodCost: net ? cost / net : null, target, suggested: cost > 0 ? (cost / target) * settings.tax_factor : null };
  }, [form, byName, settings]);

  async function save() {
    if (!form || !calc) return;
    setError(""); setMessage("");
    const used = calc.lines.filter((x) => x.l.itemText || x.l.qty);
    const bad = used.find((x) => !x.item || !(x.qty > 0));
    if (bad) return setError(bad.bad || "Every ingredient needs a name from the list and a quantity above 0.");
    const keyItem = form.keyText ? byName.get(form.keyText) : null;
    if (form.keyText && !keyItem) return setError("The key ingredient must be an ingredient from the list.");
    setBusy(true);
    const { data, error: e } = await supabase.rpc("save_recipe", {
      p_id: form.id,
      p_recipe: {
        name: form.name, category: form.category, menu_price: form.menuPrice, on_menu: form.onMenu,
        target_override: form.targetPct ? String(parseFloat(form.targetPct) / 100) : "", key_item_id: keyItem?.id ?? "",
      },
      p_lines: used.map((x) => ({ item_id: x.item!.id, qty: x.qty })),
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

  async function loadSuggestions() {
    setError(""); setMessage("");
    const { data, error: e } = await supabase.from("key_ingredient_suggestions").select("recipe_id,dish,suggested_item_id,suggested_item,line_cost,current_key_item_id").is("current_key_item_id", null);
    if (e) return setError(e.message);
    const onMenu = new Set(rows.filter((r) => r.on_menu).map((r) => r.recipe_id));
    const list = ((data ?? []) as Suggestion[]).filter((s) => onMenu.has(s.recipe_id)).sort((a, b) => a.dish.localeCompare(b.dish));
    setSugg(list); setPicked(new Set(list.map((s) => s.recipe_id)));
    if (!list.length) setMessage("No menu dishes need a key ingredient suggestion (or no ingredient costs exist yet).");
  }

  async function applySuggestions() {
    if (!sugg) return;
    setBusy(true); setError("");
    for (const s of sugg.filter((x) => picked.has(x.recipe_id))) {
      const { error: e } = await supabase.from("recipes").update({ key_item_id: s.suggested_item_id }).eq("id", s.recipe_id);
      if (e) { setBusy(false); return setError(e.message); }
    }
    setBusy(false); setMessage(`Set key ingredients for ${picked.size} dishes.`); setSugg(null); load();
  }

  const duplicate = () => setForm((f) => f && { ...f, id: null, name: `${f.name} (copy)`, lines: f.lines.map((l) => ({ ...l, key: keySeq++ })) });

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Recipes & menu cost</h1>
      <p className="mb-4 text-sm opacity-70">
        Quantities are per ONE portion, in the ingredient&apos;s unit. Food cost % = recipe cost / net price, where net price = menu price / {settings.tax_factor}.
        The target is {Math.round(settings.target_cost_max * 100)}% unless a recipe has its own.
      </p>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {message && <p className="mb-3 text-sm text-green-700 dark:text-green-400">{message}</p>}

      <div className="grid gap-6 lg:grid-cols-[24rem_1fr]">
        <section>
          <div className="mb-2 flex gap-2">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search dishes" className={`${inp} flex-1`} />
            <button onClick={() => { setForm(blankForm()); setMessage(""); setError(""); }} className="rounded bg-orange-500 px-3 py-1 text-white">New</button>
          </div>
          <button onClick={loadSuggestions} className="mb-2 text-sm underline">Suggest key ingredients</button>
          <label className="mb-2 flex items-center gap-1 text-sm"><input type="checkbox" checked={menuOnly} onChange={(e) => setMenuOnly(e.target.checked)} /> Menu dishes only (hide sauces and components)</label>
          <div className="mb-2 flex flex-wrap gap-2 text-xs">
            {FLAGS.map((f) => (
              <button key={f} onClick={() => setFlag(f)} className={`rounded-full border px-2 py-1 ${flag === f ? "border-orange-500 bg-orange-500 text-white" : "border-black/20 dark:border-white/20"}`}>
                {f ? `${f} (${count(f)})` : "All"}
              </button>
            ))}
          </div>
          <ul className="divide-y divide-black/10 dark:divide-white/10">
            {shown.map((r) => (
              <li key={r.recipe_id}>
                <button onClick={() => open(r.recipe_id)} className={`w-full px-2 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 ${form?.id === r.recipe_id ? "bg-black/5 dark:bg-white/10" : ""}`}>
                  <span className="flex justify-between gap-2">
                    <span className="font-medium">{r.name}</span>
                    <span className={r.flag === "Above target cost" ? "font-medium text-red-600" : ""}>{r.food_cost !== null ? `${(r.food_cost * 100).toFixed(1)}%` : "-"}</span>
                  </span>
                  <span className="text-xs opacity-70">
                    cost {money(r.cost_per_portion)} | price {money(r.menu_price)}
                    {r.flag !== "OK" && <b className="ml-1 text-red-600">{r.flag}</b>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!rows.length && <p className="py-6 text-sm opacity-60">No recipes yet. Import the workbook on the Settings page, or click New.</p>}
        </section>

        {sugg && sugg.length > 0 && (
          <section className="rounded border border-black/10 p-4 dark:border-white/10">
            <h2 className="mb-1 font-semibold">Suggested key ingredients</h2>
            <p className="mb-3 text-sm opacity-70">The costliest ingredient per portion for each menu dish without one. Untick any you disagree with.</p>
            <div className="mb-3 max-h-96 overflow-y-auto">
              {sugg.map((s) => (
                <label key={s.recipe_id} className="flex items-center gap-2 py-0.5 text-sm">
                  <input type="checkbox" checked={picked.has(s.recipe_id)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(s.recipe_id)) n.delete(s.recipe_id); else n.add(s.recipe_id); return n; })} />
                  <span className="flex-1">{s.dish}</span><span className="opacity-70">{s.suggested_item}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-3">
              <button onClick={applySuggestions} disabled={busy || !picked.size} className="rounded bg-orange-500 px-4 py-2 font-medium text-white disabled:opacity-50">Apply {picked.size}</button>
              <button onClick={() => setSugg(null)} className="text-sm underline opacity-70">Cancel</button>
            </div>
          </section>
        )}

        {form && calc && (
          <section className="min-w-0 rounded border border-black/10 p-4 dark:border-white/10">
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <label className="text-sm sm:col-span-2">Dish<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${inp} mt-1 w-full`} /></label>
              <label className="text-sm">Category<input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={`${inp} mt-1 w-full`} /></label>
              <label className="text-sm">Menu price (incl. tax)<input value={form.menuPrice} onChange={(e) => setForm({ ...form, menuPrice: e.target.value })} inputMode="decimal" className={`${inp} mt-1 w-full`} /></label>
              <label className="text-sm">Target food cost % (blank = {Math.round(settings.target_cost_max * 100)}%)<input value={form.targetPct} onChange={(e) => setForm({ ...form, targetPct: e.target.value })} inputMode="decimal" className={`${inp} mt-1 w-full`} placeholder="e.g. 35" /></label>
              <label className="flex items-end gap-2 pb-1 text-sm"><input type="checkbox" checked={form.onMenu} onChange={(e) => setForm({ ...form, onMenu: e.target.checked })} /> On the menu</label>
              <label className="text-sm sm:col-span-3">Key ingredient (used to estimate expected sales)<input list="recipe-items" value={form.keyText} onChange={(e) => setForm({ ...form, keyText: e.target.value })} className={`${inp} mt-1 w-full`} placeholder="e.g. Beef" /></label>
            </div>

            <table className="mb-2 w-full text-left text-sm">
              <thead className="opacity-60"><tr><th>Ingredient</th><th>Qty per portion</th><th>Unit</th><th className="text-right">Cost</th><th /></tr></thead>
              <tbody>
                {calc.lines.map(({ l, item, lineCost, bad, qty }) => (
                  <tr key={l.key} className="border-t border-black/10 align-top dark:border-white/10">
                    <td className="py-1 pr-2">
                      <input list="recipe-items" value={l.itemText} onChange={(e) => setLine(l.key, { itemText: e.target.value })} placeholder="Ingredient" className={`${inp} w-full min-w-48`} />
                      {bad && <span className="block text-xs text-red-600">{bad}</span>}
                    </td>
                    <td className="pr-2"><input value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} inputMode="decimal" className={`${inp} w-24`} /></td>
                    <td className="pr-2 opacity-70">{item?.unit}</td>
                    <td className="text-right">{item && qty > 0 && lineCost === null ? <span className="text-red-600">no cost</span> : money(lineCost)}</td>
                    <td className="pl-2"><button onClick={() => setForm({ ...form, lines: form.lines.filter((x) => x.key !== l.key) })} className="text-red-600" aria-label="Remove ingredient">x</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="recipe-items">{items.map((i) => <option key={i.id} value={i.name} />)}</datalist>
            <button onClick={() => setForm({ ...form, lines: [...form.lines, blankLine()] })} className="mb-4 text-sm underline">+ Add ingredient</button>

            <div className="mb-4 grid grid-cols-2 gap-3 rounded bg-black/5 p-3 text-sm sm:grid-cols-5 dark:bg-white/10">
              <div><div className="opacity-60">Cost per portion</div><div className="text-lg font-semibold">{money(calc.cost)}</div></div>
              <div><div className="opacity-60">Net price</div><div className="text-lg font-semibold">{money(calc.net)}</div></div>
              <div><div className="opacity-60">Food cost %</div>
                <div className={`text-lg font-semibold ${calc.foodCost !== null && calc.foodCost > calc.target ? "text-red-600" : ""}`}>{calc.foodCost !== null ? `${(calc.foodCost * 100).toFixed(1)}%` : "-"}</div></div>
              <div><div className="opacity-60">Target</div><div className="text-lg font-semibold">{Math.round(calc.target * 1000) / 10}%</div></div>
              <div><div className="opacity-60">Suggested price</div><div className="text-lg font-semibold">{money(calc.suggested)}</div></div>
            </div>
            {calc.unpriced && <p className="mb-3 text-sm text-red-600">Some ingredients have no cost yet, so this cost is incomplete.</p>}

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

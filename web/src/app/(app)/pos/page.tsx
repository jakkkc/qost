"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAll } from "@/lib/db";
import { supabase } from "@/lib/supabase";

interface LinkRow { id: string; pos_item_id: string; is_primary: boolean; recipes: { name: string } | null; packages: { name: string } | null }
interface Pos {
  pos_item_id: string; pos_code: number; pos_name: string; pos_group: string | null; pos_price: number | null;
  linked: string; menu_price: number | null; has_recipe: boolean; flag: string;
}

const money = (n: number | null) => (n === null ? "-" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const FLAGS = ["Price differs", "Not in workbook", "No menu price", "OK"];

export default function PosCheckPage() {
  const [rows, setRows] = useState<Pos[]>([]);
  const [flag, setFlag] = useState("Price differs");
  const [noRecipe, setNoRecipe] = useState(false);
  const [search, setSearch] = useState("");
  const [err, setErr] = useState("");
  const [links, setLinks] = useState<Record<string, LinkRow[]>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setRows(await fetchAll<Pos>((a, b) => supabase.from("pos_item_status").select("*").order("pos_group").order("pos_name").range(a, b)));
      const ls = await fetchAll<LinkRow>((a, b) => supabase.from("pos_item_links").select("id,pos_item_id,is_primary,recipes(name),packages(name)").range(a, b) as never);
      const m: Record<string, LinkRow[]> = {};
      ls.forEach((l) => { (m[l.pos_item_id] ??= []).push(l); });
      setLinks(m);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount
  useEffect(() => { load(); }, [load]);

  async function savePrice(r: Pos) {
    const v = parseFloat(prices[r.pos_item_id]);
    if (!(v >= 0)) return setErr("Price must be 0 or more.");
    const { error } = await supabase.from("pos_items").update({ pos_price: v }).eq("id", r.pos_item_id);
    if (error) return setErr(error.message);
    setPrices((p) => { const n = { ...p }; delete n[r.pos_item_id]; return n; });
    load();
  }

  async function setPrimary(linkId: string) {
    const { error } = await supabase.rpc("set_primary_link", { p_link: linkId });
    if (error) return setErr(error.message);
    load();
  }

  const shown = rows.filter((r) => (!flag || r.flag === flag) && (!noRecipe || !r.has_recipe)
    && (!search.trim() || `${r.pos_name} ${r.linked}`.toLowerCase().includes(search.trim().toLowerCase())));

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">POS check</h1>
      <p className="mb-4 text-sm opacity-70">
        POS prices against menu prices, and POS items with no recipe yet. &quot;Not in workbook&quot; means the POS item isn&apos;t linked to any dish or package.
      </p>
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        {FLAGS.map((f) => (
          <button key={f} onClick={() => setFlag(f)} className={`rounded-full border px-2 py-1 ${flag === f ? "border-orange-500 bg-orange-500 text-white" : "border-black/20 dark:border-white/20"}`}>
            {f} ({rows.filter((r) => r.flag === f).length})
          </button>
        ))}
        <button onClick={() => setFlag("")} className={`rounded-full border px-2 py-1 ${flag === "" ? "border-orange-500 bg-orange-500 text-white" : "border-black/20 dark:border-white/20"}`}>All ({rows.length})</button>
        <label className="ml-2 flex items-center gap-1 text-sm"><input type="checkbox" checked={noRecipe} onChange={(e) => setNoRecipe(e.target.checked)} /> No recipe yet ({rows.filter((r) => !r.has_recipe).length})</label>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="ml-2 rounded border border-black/20 bg-transparent px-2 py-1 text-sm dark:border-white/20" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="opacity-60"><tr><th className="py-1">POS code</th><th>POS item</th><th>Group</th><th>POS price</th><th>Menu price</th><th>Workbook dish</th><th>Flag</th></tr></thead>
          <tbody>
            {shown.slice(0, 500).map((r) => (
              <tr key={r.pos_item_id} className="border-t border-black/10 dark:border-white/10">
                <td className="py-1">{r.pos_code}</td><td>{r.pos_name}</td><td>{r.pos_group}</td><td>
                  <span className="flex items-center gap-1">
                    <input value={prices[r.pos_item_id] ?? (r.pos_price?.toString() ?? "")} onChange={(e) => setPrices({ ...prices, [r.pos_item_id]: e.target.value })} inputMode="decimal" className="w-20 rounded border border-black/20 bg-transparent px-1 py-0.5 dark:border-white/20" />
                    {prices[r.pos_item_id] !== undefined && <button onClick={() => savePrice(r)} className="rounded bg-orange-500 px-2 py-0.5 text-white">Save</button>}
                  </span>
                </td><td>{money(r.menu_price)}</td>
                <td>
                  {(links[r.pos_item_id]?.length ?? 0) > 1 ? (
                    <select value={links[r.pos_item_id].find((l) => l.is_primary)?.id ?? ""} onChange={(e) => setPrimary(e.target.value)} title="Sales of this POS item count against the primary dish" className="rounded border border-black/20 bg-transparent px-1 py-0.5 dark:border-white/20">
                      {links[r.pos_item_id].map((l) => <option key={l.id} value={l.id}>{l.recipes?.name ?? l.packages?.name}</option>)}
                    </select>
                  ) : r.linked}
                  {!r.has_recipe && r.linked && <span className="ml-1 text-xs text-red-600">no recipe</span>}
                </td>
                <td className={r.flag === "OK" ? "" : "font-medium text-red-600"}>{r.flag}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length > 500 && <p className="py-2 text-xs opacity-60">Showing the first 500 of {shown.length}. Use the filters to narrow it down.</p>}
        {!rows.length && <p className="py-6 text-sm opacity-60">No POS items yet. Import the workbook on the Settings page.</p>}
      </div>
    </div>
  );
}

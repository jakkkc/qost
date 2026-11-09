"use client";

import { useEffect, useState } from "react";
import { fetchAll } from "@/lib/db";
import { supabase } from "@/lib/supabase";

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

  useEffect(() => {
    fetchAll<Pos>((a, b) => supabase.from("pos_item_status").select("*").order("pos_group").order("pos_name").range(a, b))
      .then(setRows).catch((e) => setErr(e.message));
  }, []);

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
                <td className="py-1">{r.pos_code}</td><td>{r.pos_name}</td><td>{r.pos_group}</td><td>{money(r.pos_price)}</td><td>{money(r.menu_price)}</td>
                <td>{r.linked}{!r.has_recipe && r.linked && <span className="ml-1 text-xs text-red-600">no recipe</span>}</td>
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

"use client";

import { Fragment, useEffect, useState } from "react";
import { fetchAll } from "@/lib/db";
import { supabase } from "@/lib/supabase";

interface Pkg { package_id: string; name: string; price_per_pax: number | null; cost_per_pax: number | null; net_price: number | null; food_cost: number | null; flag: string }
interface PLine { recipe_id: string | null; item_id: string | null; qty_per_pax: number; recipes: { name: string } | null; items: { name: string; unit: string } | null }

const money = (n: number | null) => (n === null ? "-" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const FLAGS = ["", "No package recipe", "No price", "Above target cost", "OK"];

export default function PackagesPage() {
  const [rows, setRows] = useState<Pkg[]>([]);
  const [flag, setFlag] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<PLine[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetchAll<Pkg>((a, b) => supabase.from("package_costs").select("*").order("name").range(a, b))
      .then(setRows).catch((e) => setErr(e.message));
  }, []);

  async function toggle(id: string) {
    if (open === id) return setOpen(null);
    setOpen(id);
    const { data, error } = await supabase.from("package_lines").select("recipe_id,item_id,qty_per_pax,recipes(name),items(name,unit)").eq("package_id", id);
    if (error) setErr(error.message); else setLines((data ?? []) as unknown as PLine[]);
  }

  const shown = rows.filter((r) => !flag || r.flag === flag);
  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Packages</h1>
      <p className="mb-4 text-sm opacity-70">Cost per pax from the package lines: portions of each dish, or units of an ingredient, per guest. Editing packages comes next; for now they come from the workbook import.</p>
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        {FLAGS.map((f) => (
          <button key={f} onClick={() => setFlag(f)} className={`rounded-full border px-2 py-1 ${flag === f ? "border-orange-500 bg-orange-500 text-white" : "border-black/20 dark:border-white/20"}`}>
            {f ? `${f} (${rows.filter((r) => r.flag === f).length})` : `All (${rows.length})`}
          </button>
        ))}
      </div>
      <table className="w-full text-left text-sm">
        <thead className="opacity-60"><tr><th className="py-1">Package</th><th>Price / pax</th><th>Net price</th><th>Cost / pax</th><th>Food cost %</th><th>Flag</th></tr></thead>
        <tbody>
          {shown.map((p) => (
            <Fragment key={p.package_id}>
              <tr onClick={() => toggle(p.package_id)} className="cursor-pointer border-t border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5">
                <td className="py-1">{p.name}</td><td>{money(p.price_per_pax)}</td><td>{money(p.net_price)}</td><td>{money(p.cost_per_pax)}</td>
                <td>{p.food_cost !== null ? `${(p.food_cost * 100).toFixed(1)}%` : "-"}</td>
                <td className={p.flag === "OK" ? "" : "font-medium text-red-600"}>{p.flag}</td>
              </tr>
              {open === p.package_id && (
                <tr><td colSpan={6} className="bg-black/5 px-3 py-2 dark:bg-white/5">
                  {lines.map((l, i) => <div key={i} className="text-sm">{l.qty_per_pax} x {l.recipes?.name ?? l.items?.name} {l.items?.unit && <span className="opacity-60">({l.items.unit})</span>}</div>)}
                  {!lines.length && <span className="text-sm opacity-60">No lines.</span>}
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="py-6 text-sm opacity-60">No packages yet. Import the workbook on the Settings page.</p>}
    </div>
  );
}

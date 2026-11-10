"use client";

import { useCallback, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { monthStart, PeriodPicker, todayIso, type Period } from "@/components/PeriodPicker";
import { supabase } from "@/lib/supabase";

type Tab = "usage" | "expected" | "reorder";
type Row = Record<string, string | number | null>;

const n = (v: unknown, d = 2) => (v === null || v === undefined || v === "" ? "-" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));
const pct = (v: unknown) => (v === null || v === undefined ? "-" : `${(Number(v) * 100).toFixed(1)}%`);
const bad = (f: unknown) => f === "Missing / over-used" || f === "No recipe uses it" || f === "REORDER" || f === "Check entries";

export default function ReportsPage() {
  const [period, setPeriod] = useState<Period>({ branch: "Cottages", from: monthStart(), to: todayIso() });
  const [tab, setTab] = useState<Tab>("usage");
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [flagOnly, setFlagOnly] = useState(false);

  const load = useCallback(async () => {
    setErr(""); setLoading(true);
    const args = { p_branch: period.branch, p_from: period.from, p_to: period.to };
    const res = tab === "usage" ? await supabase.rpc("kitchen_usage", args)
      : tab === "expected" ? await supabase.rpc("expected_sales", args)
      : await supabase.from("store_reorder").select("*").order("item_name");
    setLoading(false);
    if (res.error) { setRows([]); return setErr(res.error.message); }
    setRows((res.data ?? []) as Row[]);
  }, [tab, period]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reload when the tab or period changes
  useEffect(() => { load(); }, [load]);

  function exportXlsx() {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, tab);
    XLSX.writeFile(wb, `qost-${tab}-${period.branch}-${period.from}-to-${period.to}.xlsx`);
  }

  const shown = flagOnly ? rows.filter((r) => bad(r.flag) || (tab === "expected" && Number(r.sales_gap) > 0)) : rows;
  const th = "py-1 pr-3";

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Reports</h1>
      <p className="mb-4 text-sm opacity-70">
        Uses the branch kitchen&apos;s counts, its issues, and sales imports whose date range falls inside the period. Quantities are in ingredient units.
      </p>
      <PeriodPicker value={period} onChange={setPeriod} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {([["usage", "Kitchen usage vs recipes"], ["expected", "Expected sales & gap"], ["reorder", "Store stock & reorder"]] as const).map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-full border px-3 py-1 ${tab === k ? "border-orange-500 bg-orange-500 text-white" : "border-black/20 dark:border-white/20"}`}>{t}</button>
        ))}
        <label className="ml-3 flex items-center gap-1"><input type="checkbox" checked={flagOnly} onChange={(e) => setFlagOnly(e.target.checked)} /> Red flags only</label>
        <button onClick={exportXlsx} disabled={!rows.length} className="ml-auto rounded border border-black/20 px-3 py-1 disabled:opacity-40 dark:border-white/20">Export to Excel</button>
      </div>
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
      {loading && <p className="mb-3 text-sm opacity-60">Calculating...</p>}

      <div className="overflow-x-auto">
        {tab === "usage" && (
          <table className="w-full text-left text-sm">
            <thead className="opacity-60"><tr><th className={th}>Ingredient</th><th>Unit</th><th>Opening</th><th>Issued</th><th>Closing</th><th>Actual used</th><th>Should have used</th><th>Variance</th><th>Variance KES</th><th>Variance %</th><th>Flag</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={String(r.item_id)} className="border-t border-black/10 dark:border-white/10">
                  <td className="py-1 pr-3">{r.item_name}</td><td>{r.unit}</td><td>{n(r.opening, 1)}</td><td>{n(r.issued, 1)}</td><td>{n(r.closing, 1)}</td>
                  <td>{n(r.actual_used, 1)}</td><td>{n(r.should_used, 1)}</td><td>{n(r.variance_qty, 1)}</td><td>{n(r.variance_kes)}</td><td>{pct(r.variance_pct)}</td>
                  <td className={bad(r.flag) ? "font-medium text-red-600" : ""}>{r.flag}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "expected" && (
          <table className="w-full text-left text-sm">
            <thead className="opacity-60"><tr><th className={th}>Dish</th><th>Key ingredient</th><th>Key qty</th><th>Used for dish</th><th>Sold</th><th>In packages</th><th>Portions expected</th><th>Expected sales</th><th>Actual sales</th><th>Sales gap</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={String(r.recipe_id)} className="border-t border-black/10 dark:border-white/10">
                  <td className="py-1 pr-3">{r.dish}</td><td>{r.key_item}</td><td>{n(r.key_qty, 1)}</td><td>{n(r.used_for_dish, 1)}</td>
                  <td>{n(r.sold, 0)}</td><td>{n(r.package_portions, 0)}</td><td>{n(r.portions_expected, 0)}</td><td>{n(r.expected_sales)}</td><td>{n(r.actual_sales)}</td>
                  <td className={Number(r.sales_gap) > 0 ? "font-medium text-red-600" : ""}>{n(r.sales_gap)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "reorder" && (
          <table className="w-full text-left text-sm">
            <thead className="opacity-60"><tr><th className={th}>Ingredient</th><th>Unit</th><th>Location</th><th>Balance</th><th>Par level</th><th>Reorder qty</th><th>Flag</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.item_id}-${r.location_id}`} className="border-t border-black/10 dark:border-white/10">
                  <td className="py-1 pr-3">{r.item_name}</td><td>{r.unit}</td><td>{r.branch} - {r.location_name}</td><td>{n(r.balance, 1)}</td><td>{n(r.par_qty, 1)}</td><td>{n(r.reorder_qty, 1)}</td>
                  <td className={bad(r.flag) ? "font-medium text-red-600" : ""}>{r.flag}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && !shown.length && !err && (
          <p className="py-6 text-sm opacity-60">
            {tab === "reorder" ? "No par levels set yet. Set them on the Ingredients page." : tab === "expected" ? "No dishes with a key ingredient. Set key ingredients on the Recipes page." : "Nothing to show for this period. Check that counts, issues and sales exist for this branch and dates."}
          </p>
        )}
      </div>
    </div>
  );
}

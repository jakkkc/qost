"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { monthStart, PeriodPicker, todayIso, type Period } from "@/components/PeriodPicker";
import { supabase } from "@/lib/supabase";

type Summary = Record<string, number>;

const kes = (v: number | undefined) => (v === undefined ? "-" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }));

export default function DashboardPage() {
  const [period, setPeriod] = useState<Period>({ branch: "Cottages", from: monthStart(), to: todayIso() });
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    supabase.rpc("dashboard_summary", { p_branch: period.branch, p_from: period.from, p_to: period.to }).then(({ data, error }) => {
      if (!live) return;
      if (error) { setErr(error.message); setS(null); } else { setErr(""); setS(data as Summary); }
    });
    return () => { live = false; };
  }, [period]);

  const money: [string, string, string?][] = [
    ["Purchases (KES)", "purchases"], ["Issues to kitchen (KES)", "issues_to_kitchen"], ["Store stock value (KES)", "stock_value"],
    ["Actual sales (KES)", "actual_sales"], ["Expected sales from issues (KES)", "expected_sales"], ["Sales gap (KES)", "sales_gap", "bad"],
    ["Kitchen variance, missing stock (KES)", "kitchen_variance", "bad"], ["Package revenue (KES)", "package_revenue"], ["Package food cost (KES)", "package_cost"],
  ];
  const counts: [string, string, string][] = [
    ["Items to reorder", "items_to_reorder", "/reports"], ["Dishes with no recipe", "dishes_no_recipe", "/recipes"], ["Dishes above target cost", "dishes_above_target", "/recipes"],
    ["Items with variance above limit", "items_variance_above_limit", "/reports"], ["Packages above target / no recipe", "packages_not_ok", "/packages"],
  ];

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Dashboard</h1>
      <p className="mb-4 text-sm opacity-70">The workbook Summary for one branch and period. Red figures need a look.</p>
      <PeriodPicker value={period} onChange={setPeriod} />
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {money.map(([label, key, tone]) => (
          <div key={key} className="rounded border border-black/10 p-3 dark:border-white/10">
            <div className="text-xs opacity-60">{label}</div>
            <div className={`text-2xl font-semibold ${tone === "bad" && (s?.[key] ?? 0) > 0 ? "text-red-600" : ""}`}>{kes(s?.[key])}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {counts.map(([label, key, href]) => (
          <Link key={key} href={href} className="rounded border border-black/10 p-3 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5">
            <div className="text-xs opacity-60">{label}</div>
            <div className={`text-2xl font-semibold ${(s?.[key] ?? 0) > 0 ? "text-red-600" : ""}`}>{s?.[key] ?? "-"}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

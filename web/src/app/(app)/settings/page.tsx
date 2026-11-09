"use client";

import { useEffect, useState } from "react";
import { parseWorkbook, type WorkbookParse } from "@/lib/importers/workbook";
import { supabase } from "@/lib/supabase";

const inp = "rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/20";

export default function SettingsPage() {
  const [tax, setTax] = useState("");
  const [target, setTarget] = useState("");
  const [variance, setVariance] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const [file, setFile] = useState("");
  const [parsed, setParsed] = useState<WorkbookParse | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");

  useEffect(() => {
    supabase.from("tenant_settings").select("tax_factor,target_cost_max,variance_allowed").limit(1).then(({ data, error }) => {
      if (error) return setErr(error.message);
      const s = data?.[0];
      if (s) { setTax(String(s.tax_factor)); setTarget(String(Math.round(Number(s.target_cost_max) * 1000) / 10)); setVariance(String(Math.round(Number(s.variance_allowed) * 1000) / 10)); }
    });
  }, []);

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault(); setMsg(""); setErr("");
    const t = parseFloat(tax), c = parseFloat(target) / 100, v = parseFloat(variance) / 100;
    if (!(t >= 1) || !(c > 0 && c < 1) || !(v >= 0)) return setErr("Tax factor must be 1 or more, target between 0 and 100%, variance 0 or more.");
    const { data: member } = await supabase.from("tenant_members").select("tenant_id").limit(1);
    const { error } = await supabase.from("tenant_settings").update({ tax_factor: t, target_cost_max: c, variance_allowed: v }).eq("tenant_id", member?.[0]?.tenant_id);
    if (error) return setErr(error.message);
    setMsg("Settings saved.");
  }

  async function onFile(f: File | undefined) {
    setParsed(null); setDone(""); setErr("");
    if (!f) return;
    try { setFile(f.name); setParsed(parseWorkbook(await f.arrayBuffer())); }
    catch (e) { setErr((e as Error).message); }
  }

  async function runImport() {
    if (!parsed) return;
    setBusy(true); setErr(""); setDone("");
    const { data, error } = await supabase.rpc("import_workbook", { p: parsed.payload });
    setBusy(false);
    if (error) return setErr(error.message);
    setDone(`Imported ${data.items} ingredients, ${data.recipes} dishes (${data.lines} ingredient lines), ${data.packages} packages (${data.package_lines} lines), ${data.pos_items} POS items (${data.links} links).`);
    setParsed(null);
  }

  const p = parsed?.payload;
  return (
    <div className="max-w-2xl space-y-10">
      <section>
        <h1 className="mb-1 text-2xl font-semibold">Settings</h1>
        <p className="mb-4 text-sm opacity-70">These drive every food cost figure. The cost controller can change them by season.</p>
        <form onSubmit={saveSettings} className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">Tax factor<input value={tax} onChange={(e) => setTax(e.target.value)} inputMode="decimal" className={`${inp} mt-1 w-full`} /><span className="text-xs opacity-60">net price = menu price / factor</span></label>
          <label className="text-sm">Max food cost %<input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" className={`${inp} mt-1 w-full`} /><span className="text-xs opacity-60">recipes can override</span></label>
          <label className="text-sm">Allowed kitchen variance %<input value={variance} onChange={(e) => setVariance(e.target.value)} inputMode="decimal" className={`${inp} mt-1 w-full`} /></label>
          <div className="sm:col-span-3">
            <button className="rounded bg-orange-500 px-4 py-2 font-medium text-white">Save settings</button>
            {msg && <span className="ml-3 text-sm text-green-700 dark:text-green-400">{msg}</span>}
          </div>
        </form>
        {err && !parsed && <p className="mt-2 text-sm text-red-600">{err}</p>}
      </section>

      <section>
        <h2 className="mb-1 text-xl font-semibold">Import the Recipe Cost Control Workbook</h2>
        <p className="mb-3 text-sm opacity-70">
          Loads ingredients, recipes, menu prices, packages and POS items. You can run it again after editing the workbook: existing rows are updated and the ingredient lines of the dishes in the file are replaced.
        </p>
        <input type="file" accept=".xlsx" onChange={(e) => onFile(e.target.files?.[0])} className="mb-3 text-sm" />
        {err && parsed === null && file && <p className="mb-2 text-sm text-red-600">{err}</p>}
        {done && <p className="mb-3 text-sm text-green-700 dark:text-green-400">{done}</p>}
        {parsed && p && (
          <div className="rounded border border-black/10 p-4 dark:border-white/10">
            <h3 className="mb-2 font-semibold">Preview: {file}</h3>
            <ul className="mb-3 text-sm">
              <li>{p.items.length} ingredients</li>
              <li>{p.recipes.length} dishes ({p.recipes.filter((r) => r.on_menu).length} on the menu), {p.lines.length} ingredient lines</li>
              <li>{p.packages.length} packages, {p.package_lines.length} package lines</li>
              <li>{p.pos.length} POS items, {p.links.length} links to dishes or packages</li>
              {parsed.notes.map((n) => <li key={n} className="opacity-70">{n}</li>)}
            </ul>
            {parsed.problems.length > 0 && (
              <div className="mb-3 text-sm text-red-600">
                <b>{parsed.problems.length} problems. The import will stop until these are fixed in the workbook:</b>
                {parsed.problems.slice(0, 10).map((m) => <div key={m}>{m}</div>)}
              </div>
            )}
            {err && <p className="mb-2 text-sm text-red-600">{err}</p>}
            <button onClick={runImport} disabled={busy || parsed.problems.length > 0} className="rounded bg-orange-500 px-4 py-2 font-medium text-white disabled:opacity-50">{busy ? "Importing..." : "Import workbook"}</button>
          </div>
        )}
      </section>
    </div>
  );
}

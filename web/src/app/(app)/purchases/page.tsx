"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/AppShell";
import { BatchList } from "@/components/BatchList";
import { chunk, locLabel } from "@/lib/db";
import { parsePurchasing, type PurchaseRow } from "@/lib/importers/purchasing";
import { supabase } from "@/lib/supabase";

interface Preview {
  file: string; rows: PurchaseRow[]; errors: string[];
  newItems: number; duplicates: number; total: number;
}
interface Increase { purchase_date: string; unit_price: number; previous_price: number; increase_pct: number; items: { name: string } | null }

const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function PurchasesPage() {
  const { locations } = useApp();
  const [locationSel, setLocation] = useState("");
  // "none" = record prices only, no stock received
  const location = locationSel || locations[0]?.id || "";
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mode, setMode] = useState<"skip" | "replace">("skip");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [increases, setIncreases] = useState<Increase[]>([]);


  const loadIncreases = useCallback(async () => {
    const { data } = await supabase.from("price_history")
      .select("purchase_date,unit_price,previous_price,increase_pct,items(name)")
      .not("increase_pct", "is", null).order("purchase_date", { ascending: false }).limit(25);
    setIncreases((data ?? []) as unknown as Increase[]);
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount and after imports
  useEffect(() => { loadIncreases(); }, [loadIncreases, refresh]);

  async function onFile(file: File | undefined) {
    setPreview(null); setMessage(""); setError("");
    if (!file) return;
    try {
      const { rows, errors } = parsePurchasing(await file.arrayBuffer());
      const codes = [...new Set(rows.map((r) => r.code))];
      const known = new Map<number, string>();
      for (const part of chunk(codes, 200)) {
        const { data, error: e } = await supabase.from("items").select("id,code").in("code", part);
        if (e) throw new Error(e.message);
        data?.forEach((d) => known.set(d.code, d.id));
      }
      const grns = [...new Set(rows.map((r) => r.grn))];
      const existing = new Set<string>();
      for (const part of chunk(grns, 200)) {
        const { data, error: e } = await supabase.from("grn_lines").select("grn_no,item_id").in("grn_no", part);
        if (e) throw new Error(e.message);
        data?.forEach((d) => existing.add(`${d.grn_no}|${d.item_id}`));
      }
      const duplicates = rows.filter((r) => known.has(r.code) && existing.has(`${r.grn}|${known.get(r.code)}`)).length;
      setPreview({
        file: file.name, rows, errors, duplicates,
        newItems: codes.filter((c) => !known.has(c)).length,
        total: rows.reduce((s, r) => s + (r.total ?? r.price * r.qty), 0),
      });
    } catch (e) { setError((e as Error).message); }
  }

  async function runImport() {
    if (!preview) return;
    setBusy(true); setError(""); setMessage("");
    const { data, error: e } = await supabase.rpc("import_purchases", {
      p_file: preview.file, p_location: location === "none" ? null : location, p_mode: mode, p_rows: preview.rows,
    });
    setBusy(false);
    if (e) return setError(e.message);
    setMessage(`Imported ${data.inserted} lines, skipped ${data.skipped}, replaced ${data.replaced}.`);
    setPreview(null);
    setRefresh((n) => n + 1);
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Purchases</h1>
      <p className="mb-4 text-sm opacity-70">Upload the Purchasing Report (.xls, .xlsx or .csv). Choose where the goods were delivered, or record prices only if they are not stocked here.</p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="text-sm">Delivered to{" "}
          <select value={location} onChange={(e) => setLocation(e.target.value)} className="rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/20">
            {locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}
            <option value="none">Price history only (no stock)</option>
          </select>
        </label>
        <input type="file" accept=".xls,.xlsx,.csv" onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" />
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {message && <p className="mb-3 text-sm text-green-700 dark:text-green-400">{message}</p>}

      {preview && (
        <section className="mb-6 rounded border border-black/10 p-4 dark:border-white/10">
          <h2 className="mb-2 font-semibold">Preview: {preview.file}</h2>
          <ul className="mb-3 text-sm">
            <li>{preview.rows.length} purchase lines, total {money(preview.total)} (VAT-inclusive)</li>
            <li>{preview.newItems} new items will be created</li>
            <li className={preview.duplicates ? "font-medium text-orange-600" : ""}>{preview.duplicates} lines already imported (same GRN and item)</li>
            {preview.errors.length > 0 && <li className="text-red-600">{preview.errors.length} rows could not be read</li>}
          </ul>
          {preview.errors.slice(0, 5).map((m) => <p key={m} className="text-xs text-red-600">{m}</p>)}
          {preview.duplicates > 0 && (
            <fieldset className="mb-3 text-sm">
              <legend className="mb-1 font-medium">For the duplicates:</legend>
              <label className="mr-4"><input type="radio" checked={mode === "skip"} onChange={() => setMode("skip")} /> Skip them</label>
              <label><input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} /> Replace them (the old receipt is reversed)</label>
            </fieldset>
          )}
          <table className="mb-3 w-full text-left text-sm">
            <thead className="opacity-60"><tr><th>GRN</th><th>Date</th><th>Item</th><th>Unit</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
            <tbody>
              {preview.rows.slice(0, 10).map((r) => (
                <tr key={`${r.grn}-${r.code}`} className="border-t border-black/10 dark:border-white/10">
                  <td>{r.grn}</td><td>{r.date}</td><td>{r.code} {r.name}</td><td>{r.unit}</td><td>{r.qty}</td><td>{money(r.price)}</td><td>{money(r.total ?? r.price * r.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.rows.length > 10 && <p className="mb-3 text-xs opacity-60">Showing the first 10 of {preview.rows.length}.</p>}
          <button onClick={runImport} disabled={busy || !preview.rows.length} className="rounded bg-orange-500 px-4 py-2 font-medium text-white disabled:opacity-50">
            {busy ? "Importing..." : "Import"}
          </button>
        </section>
      )}

      {increases.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-semibold">Recent price increases</h2>
          <table className="w-full text-left text-sm">
            <thead className="opacity-60"><tr><th>Date</th><th>Item</th><th>Was</th><th>Now</th><th>Change</th></tr></thead>
            <tbody>
              {increases.map((x, i) => (
                <tr key={i} className="border-t border-black/10 dark:border-white/10">
                  <td>{x.purchase_date}</td><td>{x.items?.name}</td><td>{money(x.previous_price)}</td><td>{money(x.unit_price)}</td>
                  <td className="font-medium text-red-600">+{x.increase_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <BatchList kind="purchases" refreshKey={refresh} onChange={() => setRefresh((n) => n + 1)} />
    </div>
  );
}

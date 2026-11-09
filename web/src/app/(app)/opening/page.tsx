"use client";

import { useState } from "react";
import { useApp } from "@/components/AppShell";
import { BatchList } from "@/components/BatchList";
import { chunk, locLabel } from "@/lib/db";
import { parseOpening, type OpeningRow } from "@/lib/importers/opening";
import { supabase } from "@/lib/supabase";

interface Preview { file: string; rows: OpeningRow[]; errors: string[]; newItems: number }

const sel = "rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/20";

export default function OpeningPage() {
  const { locations } = useApp();
  const [locationSel, setLocation] = useState("");
  const location = locationSel || locations[0]?.id || "";
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);


  async function onFile(file: File | undefined) {
    setPreview(null); setMessage(""); setError("");
    if (!file) return;
    try {
      const { rows, errors } = parseOpening(await file.arrayBuffer());
      const codes = [...new Set(rows.map((r) => r.code))];
      const known = new Set<number>();
      for (const part of chunk(codes, 200)) {
        const { data, error: e } = await supabase.from("items").select("code").in("code", part);
        if (e) throw new Error(e.message);
        data?.forEach((d) => known.add(d.code));
      }
      setPreview({ file: file.name, rows, errors, newItems: codes.filter((c) => !known.has(c)).length });
    } catch (e) { setError((e as Error).message); }
  }

  async function runImport() {
    if (!preview || !location) return;
    setBusy(true); setError(""); setMessage("");
    const { data, error: e } = await supabase.rpc("import_opening", { p_file: preview.file, p_location: location, p_date: date, p_rows: preview.rows });
    setBusy(false);
    if (e) return setError(e.message);
    setMessage(`Opening stock set for ${data.inserted} items (${data.skipped} already had an opening balance and were skipped).`);
    setPreview(null);
    setRefresh((n) => n + 1);
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Opening stock</h1>
      <p className="mb-4 text-sm opacity-70">
        Upload a stock-take sheet with the columns Item Code, Item Name, Units and Quantity. Quantities are in the item&apos;s reported unit.
        Each location needs one sheet, dated the day your tracking starts.
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="text-sm">Location{" "}
          <select value={location} onChange={(e) => setLocation(e.target.value)} className={sel}>
            {locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}
          </select>
        </label>
        <label className="text-sm">As of{" "}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={sel} />
        </label>
        <input type="file" accept=".xls,.xlsx,.csv" onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" />
      </div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {message && <p className="mb-3 text-sm text-green-700 dark:text-green-400">{message}</p>}
      {preview && (
        <div className="rounded border border-black/10 p-4 dark:border-white/10">
          <h2 className="mb-2 font-semibold">Preview: {preview.file}</h2>
          <ul className="mb-3 text-sm">
            <li>{preview.rows.length} items with a counted quantity</li>
            <li>{preview.newItems} new items will be created</li>
            {preview.errors.length > 0 && <li className="text-red-600">{preview.errors.length} rows could not be read</li>}
          </ul>
          {preview.errors.slice(0, 5).map((m) => <p key={m} className="text-xs text-red-600">{m}</p>)}
          <button onClick={runImport} disabled={busy || !preview.rows.length} className="rounded bg-orange-500 px-4 py-2 font-medium text-white disabled:opacity-50">
            {busy ? "Importing..." : "Set opening stock"}
          </button>
        </div>
      )}
      <BatchList kind="opening" refreshKey={refresh} onChange={() => setRefresh((n) => n + 1)} />
    </div>
  );
}

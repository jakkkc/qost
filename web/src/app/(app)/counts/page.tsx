"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppShell";
import { BatchList } from "@/components/BatchList";
import { fetchAll, locLabel } from "@/lib/db";
import { parseCounts, type CountRow } from "@/lib/importers/counts";
import { supabase } from "@/lib/supabase";

interface Item { id: string; name: string; unit: string }
interface Preview { file: string; rows: CountRow[]; errors: string[]; unknown: string[] }

const inp = "rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/20";
const today = () => new Date().toISOString().slice(0, 10);

export default function CountsPage() {
  const { locations, tenantId } = useApp();
  const [locSel, setLoc] = useState("");
  const loc = locSel || locations.find((l) => l.kind === "kitchen")?.id || locations[0]?.id || "";
  const [date, setDate] = useState(today());
  const [items, setItems] = useState<Item[]>([]);
  const [existing, setExisting] = useState<Record<string, number>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    fetchAll<Item>((a, b) => supabase.from("items").select("id,name,unit").order("name").range(a, b)).then(setItems).catch((e) => setErr(e.message));
  }, []);

  const loadExisting = useCallback(async () => {
    if (!loc) return;
    const { data, error } = await supabase.from("stock_counts").select("item_id,qty").eq("location_id", loc).eq("count_date", date);
    if (error) return setErr(error.message);
    setExisting(Object.fromEntries((data ?? []).map((c) => [c.item_id, Number(c.qty)])));
    setTyped({});
  }, [loc, date]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reload when the kitchen or date changes
  useEffect(() => { loadExisting(); }, [loadExisting, refresh]);

  const shown = useMemo(() => items.filter((i) => !search.trim() || i.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 300), [items, search]);

  async function saveTyped() {
    setErr(""); setMsg("");
    const rows = Object.entries(typed).filter(([, v]) => v !== "").map(([item_id, v]) => ({ tenant_id: tenantId, location_id: loc, item_id, count_date: date, qty: parseFloat(v) }));
    if (rows.some((r) => !(r.qty >= 0))) return setErr("Counts must be 0 or more.");
    if (!rows.length) return setErr("Type at least one quantity.");
    setBusy(true);
    const { error } = await supabase.from("stock_counts").upsert(rows, { onConflict: "tenant_id,location_id,item_id,count_date" });
    setBusy(false);
    if (error) return setErr(error.message);
    setMsg(`Saved ${rows.length} counts.`);
    setRefresh((n) => n + 1);
  }

  async function onFile(file: File | undefined) {
    setPreview(null); setMsg(""); setErr("");
    if (!file) return;
    try {
      const { rows, errors } = parseCounts(await file.arrayBuffer());
      const names = new Set(items.map((i) => i.name.toLowerCase()));
      setPreview({ file: file.name, rows, errors, unknown: [...new Set(rows.map((r) => r.name).filter((n) => !names.has(n.toLowerCase())))] });
    } catch (e) { setErr((e as Error).message); }
  }

  async function runImport() {
    if (!preview) return;
    setBusy(true); setErr(""); setMsg("");
    const { data, error } = await supabase.rpc("import_counts", { p_file: preview.file, p_location: loc, p_date: date, p_rows: preview.rows });
    setBusy(false);
    if (error) return setErr(error.message);
    setMsg(`Counted ${data.inserted} new and updated ${data.updated} existing. ${data.unknown.length} names were not recognised.`);
    setPreview(null);
    setRefresh((n) => n + 1);
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Kitchen counts</h1>
      <p className="mb-4 text-sm opacity-70">
        The physical stock in a kitchen on a date, in each ingredient&apos;s unit. Reports use the nearest count on or before the start and end of the period.
        An ingredient with no count is treated as 0.
      </p>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">Location<select value={loc} onChange={(e) => setLoc(e.target.value)} className={`${inp} mt-1 block`}>{locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}</select></label>
        <label className="text-sm">Count date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${inp} mt-1 block`} /></label>
        <input type="file" accept=".xls,.xlsx,.csv" onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" />
      </div>
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
      {msg && <p className="mb-3 text-sm text-green-700 dark:text-green-400">{msg}</p>}

      {preview && (
        <section className="mb-6 rounded border border-black/10 p-4 dark:border-white/10">
          <h2 className="mb-2 font-semibold">Preview: {preview.file}</h2>
          <ul className="mb-3 text-sm">
            <li>{preview.rows.length} counted ingredients</li>
            {preview.unknown.length > 0 && <li className="text-orange-600">{preview.unknown.length} names are not ingredients and will be skipped: {preview.unknown.slice(0, 6).join(", ")}{preview.unknown.length > 6 ? "..." : ""}</li>}
            {preview.errors.length > 0 && <li className="text-red-600">{preview.errors.length} rows could not be read</li>}
          </ul>
          <button onClick={runImport} disabled={busy || !preview.rows.length} className="rounded bg-orange-500 px-4 py-2 font-medium text-white disabled:opacity-50">{busy ? "Importing..." : "Import counts"}</button>
        </section>
      )}

      <h2 className="mb-2 text-lg font-semibold">Type or correct counts</h2>
      <div className="mb-2 flex items-center gap-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ingredients" className={`${inp} w-64`} />
        <button onClick={saveTyped} disabled={busy} className="rounded bg-orange-500 px-3 py-1 text-white disabled:opacity-50">Save typed counts ({Object.values(typed).filter((v) => v !== "").length})</button>
      </div>
      <table className="w-full text-left text-sm">
        <thead className="opacity-60"><tr><th className="py-1">Ingredient</th><th>Unit</th><th>Counted on {date}</th><th>New count</th></tr></thead>
        <tbody>
          {shown.map((i) => (
            <tr key={i.id} className="border-t border-black/10 dark:border-white/10">
              <td className="py-1">{i.name}</td><td>{i.unit}</td><td>{existing[i.id] ?? <span className="opacity-40">-</span>}</td>
              <td><input value={typed[i.id] ?? ""} onChange={(e) => setTyped({ ...typed, [i.id]: e.target.value })} inputMode="decimal" className={`${inp} w-28`} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > 300 && <p className="py-2 text-xs opacity-60">Showing the first 300 matches. Search to find others.</p>}
      <BatchList kind="counts" refreshKey={refresh} onChange={() => setRefresh((n) => n + 1)} />
    </div>
  );
}

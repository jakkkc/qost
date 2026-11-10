"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { BatchList } from "@/components/BatchList";
import { fetchAll } from "@/lib/db";
import { parseSales, type SalesRow } from "@/lib/importers/sales";
import { supabase } from "@/lib/supabase";

interface Preview { file: string; rows: SalesRow[]; errors: string[]; unknown: number; unlinked: number; total: number }
interface ImportRow { id: string; branch: string; date_from: string; date_to: string; file_name: string | null }
interface Line { id: string; pos_code: number; pos_name: string | null; group_name: string | null; unit_price: number | null; unit_price_original: number | null; sold_qty: number; gross_total: number | null; pax_override: number | null }

const BRANCHES = ["Cottages", "Tuuti"];
const inp = "rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/20";
const money = (n: number | null | undefined) => (n === null || n === undefined ? "-" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const today = () => new Date().toISOString().slice(0, 10);

export default function SalesPage() {
  const [branch, setBranch] = useState(BRANCHES[0]);
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { price?: string; pax?: string }>>({});
  const [packageCodes, setPackageCodes] = useState<Set<number>>(new Set());

  const loadImports = useCallback(async () => {
    const { data, error } = await supabase.from("sales_imports").select("id,branch,date_from,date_to,file_name").order("date_from", { ascending: false }).limit(30);
    if (error) setErr(error.message); else setImports(data ?? []);
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount and after imports
  useEffect(() => { loadImports(); }, [loadImports, refresh]);

  async function onFile(file: File | undefined) {
    setPreview(null); setMsg(""); setErr("");
    if (!file) return;
    try {
      const { rows, errors } = parseSales(await file.arrayBuffer());
      const known = await fetchAll<{ pos_code: number; id: string }>((a, b) => supabase.from("pos_items").select("pos_code,id").range(a, b));
      const links = await fetchAll<{ pos_item_id: string }>((a, b) => supabase.from("pos_item_links").select("pos_item_id").range(a, b));
      const linked = new Set(links.map((l) => l.pos_item_id));
      const byCode = new Map(known.map((k) => [k.pos_code, k.id]));
      const codes = [...new Set(rows.map((r) => r.code))];
      setPreview({
        file: file.name, rows, errors,
        unknown: codes.filter((c) => !byCode.has(c)).length,
        unlinked: codes.filter((c) => byCode.has(c) && !linked.has(byCode.get(c)!)).length,
        total: rows.reduce((s, r) => s + (r.gross ?? (r.unit_price ?? 0) * r.qty), 0),
      });
    } catch (e) { setErr((e as Error).message); }
  }

  async function runImport(allowOverlap = false) {
    if (!preview) return;
    setBusy(true); setErr(""); setMsg("");
    const { data, error } = await supabase.rpc("import_sales", {
      p_file: preview.file, p_branch: branch, p_from: from, p_to: to, p_rows: preview.rows, p_allow_overlap: allowOverlap,
    });
    setBusy(false);
    if (error) {
      if (error.message.startsWith("OVERLAP") && confirm(`${error.message}\n\nImport anyway? Sales for the overlapping days would be counted twice.`)) return runImport(true);
      return setErr(error.message);
    }
    setMsg(`Imported ${data.inserted} sales lines. ${data.unknown_pos} POS items are not on the POS list and ${data.unlinked_pos} are not linked to a dish or package, so they won't count until linked.`);
    setPreview(null);
    setRefresh((n) => n + 1);
  }

  async function toggle(id: string) {
    if (open === id) return setOpen(null);
    setOpen(id); setDrafts({});
    await loadLines(id);
  }

  async function loadLines(id: string) {
    const [ls, pos, links] = await Promise.all([
      supabase.from("sales_lines").select("id,pos_code,pos_name,group_name,unit_price,unit_price_original,sold_qty,gross_total,pax_override").eq("import_id", id).order("pos_code"),
      fetchAll<{ id: string; pos_code: number }>((a, b) => supabase.from("pos_items").select("id,pos_code").range(a, b)),
      fetchAll<{ pos_item_id: string; package_id: string | null }>((a, b) => supabase.from("pos_item_links").select("pos_item_id,package_id").not("package_id", "is", null).range(a, b)),
    ]);
    if (ls.error) return setErr(ls.error.message);
    setLines((ls.data ?? []) as Line[]);
    const pkgPos = new Set(links.map((l) => l.pos_item_id));
    setPackageCodes(new Set(pos.filter((p) => pkgPos.has(p.id)).map((p) => p.pos_code)));
  }

  async function saveLine(l: Line) {
    const d = drafts[l.id] ?? {};
    const patch: Record<string, number | null> = {};
    if (d.price !== undefined) { const v = parseFloat(d.price); if (!(v >= 0)) return setErr("Price must be 0 or more."); patch.unit_price = v; }
    if (d.pax !== undefined) patch.pax_override = d.pax === "" ? null : parseFloat(d.pax);
    const { error } = await supabase.from("sales_lines").update(patch).eq("id", l.id);
    if (error) return setErr(error.message);
    setDrafts((x) => { const n = { ...x }; delete n[l.id]; return n; });
    if (open) await loadLines(open);
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Sales</h1>
      <p className="mb-4 text-sm opacity-70">
        Upload the Nomad sales export, already filtered by date and branch in Nomad. Pick the same branch and dates here, because the file itself has none.
        Quantities count against the dish linked to each POS item (see POS check). Unit prices and package pax stay editable.
      </p>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">Branch<select value={branch} onChange={(e) => setBranch(e.target.value)} className={`${inp} mt-1 block`}>{BRANCHES.map((b) => <option key={b}>{b}</option>)}</select></label>
        <label className="text-sm">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${inp} mt-1 block`} /></label>
        <label className="text-sm">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${inp} mt-1 block`} /></label>
        <input type="file" accept=".xls,.xlsx,.csv" onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" />
      </div>
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
      {msg && <p className="mb-3 text-sm text-green-700 dark:text-green-400">{msg}</p>}

      {preview && (
        <section className="mb-6 rounded border border-black/10 p-4 dark:border-white/10">
          <h2 className="mb-2 font-semibold">Preview: {preview.file} ({branch}, {from} to {to})</h2>
          <ul className="mb-3 text-sm">
            <li>{preview.rows.length} sales lines, total {money(preview.total)}</li>
            <li className={preview.unknown ? "font-medium text-orange-600" : ""}>{preview.unknown} POS items are not on the POS list</li>
            <li className={preview.unlinked ? "font-medium text-orange-600" : ""}>{preview.unlinked} POS items are not linked to a dish or package</li>
            {preview.errors.length > 0 && <li className="text-red-600">{preview.errors.length} rows could not be read</li>}
            {preview.rows.every((r) => !r.unit_price) && <li className="text-orange-600">All unit prices are 0. You can edit them after importing.</li>}
          </ul>
          {preview.errors.slice(0, 5).map((m) => <p key={m} className="text-xs text-red-600">{m}</p>)}
          <button onClick={() => runImport()} disabled={busy || !preview.rows.length} className="rounded bg-orange-500 px-4 py-2 font-medium text-white disabled:opacity-50">{busy ? "Importing..." : "Import sales"}</button>
        </section>
      )}

      <h2 className="mb-2 text-lg font-semibold">Imported sales</h2>
      <table className="w-full text-left text-sm">
        <thead className="opacity-60"><tr><th className="py-1">Branch</th><th>From</th><th>To</th><th>File</th></tr></thead>
        <tbody>
          {imports.map((s) => (
            <Fragment key={s.id}>
              <tr onClick={() => toggle(s.id)} className="cursor-pointer border-t border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5">
                <td className="py-1">{s.branch}</td><td>{s.date_from}</td><td>{s.date_to}</td><td>{s.file_name}</td>
              </tr>
              {open === s.id && (
                <tr><td colSpan={4} className="bg-black/5 p-3 dark:bg-white/5">
                  <table className="w-full text-left text-sm">
                    <thead className="opacity-60"><tr><th>POS</th><th>Item</th><th>Group</th><th>Qty</th><th>Unit price</th><th>Gross</th><th>Pax</th><th /></tr></thead>
                    <tbody>
                      {lines.map((l) => {
                        const d = drafts[l.id];
                        const isPkg = packageCodes.has(l.pos_code);
                        return (
                          <tr key={l.id} className="border-t border-black/10 dark:border-white/10">
                            <td className="py-1">{l.pos_code}</td><td>{l.pos_name}</td><td>{l.group_name}</td><td>{l.sold_qty}</td>
                            <td><input value={d?.price ?? (l.unit_price?.toString() ?? "")} onChange={(e) => setDrafts({ ...drafts, [l.id]: { ...d, price: e.target.value } })} inputMode="decimal" className={`${inp} w-24`} title={l.unit_price_original !== l.unit_price ? `Imported as ${l.unit_price_original}` : undefined} /></td>
                            <td>{money(l.gross_total)}</td>
                            <td>{isPkg ? <input value={d?.pax ?? (l.pax_override?.toString() ?? "")} placeholder={String(l.sold_qty)} onChange={(e) => setDrafts({ ...drafts, [l.id]: { ...d, pax: e.target.value } })} inputMode="decimal" className={`${inp} w-20`} /> : ""}</td>
                            <td>{d && <button onClick={() => saveLine(l)} className="rounded bg-orange-500 px-2 py-1 text-white">Save</button>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {!imports.length && <p className="py-4 text-sm opacity-60">No sales imported yet.</p>}
      <BatchList kind="sales" refreshKey={refresh} onChange={() => setRefresh((n) => n + 1)} />
    </div>
  );
}

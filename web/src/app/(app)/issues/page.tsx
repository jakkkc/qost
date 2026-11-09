"use client";

import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppShell";
import { BatchList } from "@/components/BatchList";
import { chunk, loadItemsLite, locLabel, type ItemLite } from "@/lib/db";
import { parseIssued, type IssueRow } from "@/lib/importers/issued";
import { supabase } from "@/lib/supabase";

interface Preview {
  file: string; rows: IssueRow[]; errors: string[]; newItems: number; duplicates: number; total: number;
  reqs: { req: number; lines: number; total: number }[];
}

const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const sel = "rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/20";
const today = () => new Date().toISOString().slice(0, 10);

export default function IssuesPage() {
  const { locations } = useApp();
  const [sourceSel, setSource] = useState("");
  const [destSel, setDest] = useState("");
  const source = sourceSel; // "" = no source: the stock was already handed over
  const dest = destSel || locations.find((l) => l.kind === "kitchen")?.id || locations[0]?.id || "";
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reqMap, setReqMap] = useState<Record<number, string>>({});
  const [mode, setMode] = useState<"skip" | "replace">("skip");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);


  async function onFile(file: File | undefined) {
    setPreview(null); setMessage(""); setError(""); setReqMap({});
    if (!file) return;
    try {
      const { rows, errors } = parseIssued(await file.arrayBuffer());
      const codes = [...new Set(rows.map((r) => r.code))];
      const known = new Map<number, string>();
      for (const part of chunk(codes, 200)) {
        const { data, error: e } = await supabase.from("items").select("id,code").in("code", part);
        if (e) throw new Error(e.message);
        data?.forEach((d) => known.set(d.code, d.id));
      }
      const refs = [...new Set(rows.map((r) => `REQ-${r.req}`))];
      const active = new Set<string>();
      for (const part of chunk(refs, 200)) {
        const { data, error: e } = await supabase.from("active_issues").select("item_id,ref_no").in("ref_no", part);
        if (e) throw new Error(e.message);
        data?.forEach((d) => active.add(`${d.ref_no}|${d.item_id}`));
      }
      const byReq = new Map<number, { req: number; lines: number; total: number }>();
      for (const r of rows) {
        const x = byReq.get(r.req) ?? { req: r.req, lines: 0, total: 0 };
        x.lines += 1; x.total += r.total ?? r.price * r.qty;
        byReq.set(r.req, x);
      }
      setPreview({
        file: file.name, rows, errors,
        newItems: codes.filter((c) => !known.has(c)).length,
        duplicates: rows.filter((r) => known.has(r.code) && active.has(`REQ-${r.req}|${known.get(r.code)}`)).length,
        total: rows.reduce((s, r) => s + (r.total ?? r.price * r.qty), 0),
        reqs: [...byReq.values()].sort((a, b) => a.req - b.req),
      });
    } catch (e) { setError((e as Error).message); }
  }

  async function runImport() {
    if (!preview || !dest) return;
    setBusy(true); setError(""); setMessage("");
    const map: Record<string, string> = {};
    for (const [req, loc] of Object.entries(reqMap)) if (loc) map[req] = loc;
    const { data, error: e } = await supabase.rpc("import_issues", {
      p_file: preview.file, p_source: source || null, p_default_dest: dest, p_map: map, p_mode: mode, p_rows: preview.rows,
    });
    setBusy(false);
    if (e) return setError(e.message);
    setMessage(`Imported ${data.inserted} issues, skipped ${data.skipped}, replaced ${data.replaced}.`);
    setPreview(null);
    setRefresh((n) => n + 1);
  }

  return (
    <div className="space-y-10">
      <section>
        <h1 className="mb-1 text-2xl font-semibold">Issues & transfers</h1>
        <p className="mb-4 text-sm opacity-70">
          Upload the Issued Items Report. The report doesn&apos;t say where stock went, so choose the destination here, for the whole file or per requisition. Leave &quot;Issued from&quot; empty when the store keeper has already handed the items over.
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="text-sm">Issued from{" "}
            <select value={source} onChange={(e) => setSource(e.target.value)} className={sel}>
              <option value="">None (already handed over)</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}
            </select>
          </label>
          <label className="text-sm">Default destination{" "}
            <select value={dest} onChange={(e) => setDest(e.target.value)} className={sel}>
              {locations.filter((l) => l.id !== source).map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}
            </select>
          </label>
          <input type="file" accept=".xls,.xlsx,.csv" onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" />
        </div>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        {message && <p className="mb-3 text-sm text-green-700 dark:text-green-400">{message}</p>}

        {preview && (
          <div className="rounded border border-black/10 p-4 dark:border-white/10">
            <h2 className="mb-2 font-semibold">Preview: {preview.file}</h2>
            <ul className="mb-3 text-sm">
              <li>{preview.rows.length} issue lines in {preview.reqs.length} requisitions, total {money(preview.total)}</li>
              <li>{preview.newItems} new items will be created</li>
              <li className={preview.duplicates ? "font-medium text-orange-600" : ""}>{preview.duplicates} lines already imported (same requisition and item)</li>
              {preview.errors.length > 0 && <li className="text-red-600">{preview.errors.length} rows could not be read</li>}
            </ul>
            {preview.errors.slice(0, 5).map((m) => <p key={m} className="text-xs text-red-600">{m}</p>)}
            {preview.duplicates > 0 && (
              <fieldset className="mb-3 text-sm">
                <legend className="mb-1 font-medium">For the duplicates:</legend>
                <label className="mr-4"><input type="radio" checked={mode === "skip"} onChange={() => setMode("skip")} /> Skip them</label>
                <label><input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} /> Replace them (the old issue is reversed)</label>
              </fieldset>
            )}
            <table className="mb-3 w-full text-left text-sm">
              <thead className="opacity-60"><tr><th>Requisition</th><th>Lines</th><th>Total</th><th>Destination</th></tr></thead>
              <tbody>
                {preview.reqs.map((r) => (
                  <tr key={r.req} className="border-t border-black/10 dark:border-white/10">
                    <td className="py-1">{r.req}</td><td>{r.lines}</td><td>{money(r.total)}</td>
                    <td>
                      <select value={reqMap[r.req] ?? ""} onChange={(e) => setReqMap((m) => ({ ...m, [r.req]: e.target.value }))} className={sel}>
                        <option value="">Default</option>
                        {locations.filter((l) => l.id !== source).map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button onClick={runImport} disabled={busy || !preview.rows.length} className="rounded bg-orange-500 px-4 py-2 font-medium text-white disabled:opacity-50">
              {busy ? "Importing..." : "Import"}
            </button>
          </div>
        )}
        <BatchList kind="issues" refreshKey={refresh} onChange={() => setRefresh((n) => n + 1)} />
      </section>

      <ManualEntry />
    </div>
  );
}

function ManualEntry() {
  const { locations } = useApp();
  const [items, setItems] = useState<ItemLite[]>([]);
  const [kind, setKind] = useState("transfer");
  const [itemText, setItemText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [date, setDate] = useState(today());
  const [qty, setQty] = useState("");
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => { loadItemsLite().then(setItems).catch((e) => setErr(e.message)); }, []);
  const item = useMemo(() => items.find((i) => `${i.code} - ${i.name}` === itemText), [items, itemText]);
  const twoLeg = kind === "transfer" || kind === "issue";

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMsg(""); setErr("");
    const q = parseFloat(qty);
    if (!item) return setErr("Pick an item from the list.");
    if (!from || (twoLeg && !to)) return setErr("Choose the locations.");
    if (!(q > 0)) return setErr("Enter a quantity above 0.");
    const { error } = twoLeg
      ? await supabase.rpc("transfer_stock", { p_item: item.id, p_from: from, p_to: to, p_date: date, p_qty: q, p_kind: kind, p_ref: ref || null, p_note: note || null })
      : await supabase.rpc("record_stock_out", { p_item: item.id, p_location: from, p_date: date, p_qty: q, p_kind: kind, p_ref: ref || null, p_note: note || null });
    if (error) return setErr(error.message);
    setMsg(`Recorded ${q} ${item.purchase_unit ?? ""} of ${item.name}.`);
    setQty(""); setRef(""); setNote("");
  }

  return (
    <section>
      <h2 className="mb-1 text-xl font-semibold">Manual entry</h2>
      <p className="mb-3 text-sm opacity-70">Transfers between kitchens or branches, direct issues, spoilage, staff meals, complimentaries and conference issues. Quantities are in the item&apos;s reported unit.</p>
      <form onSubmit={submit} className="grid max-w-2xl gap-3 sm:grid-cols-2">
        <label className="text-sm">Type
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={`${sel} mt-1 w-full`}>
            <option value="transfer">Transfer between locations</option>
            <option value="issue">Issue to a department</option>
            <option value="spoilage">Spoilage</option>
            <option value="staff_meal">Staff meal</option>
            <option value="complimentary">Complimentary</option>
            <option value="conference">Conference issue</option>
          </select>
        </label>
        <label className="text-sm">Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${sel} mt-1 w-full`} />
        </label>
        <label className="text-sm sm:col-span-2">Item
          <input list="items-list" value={itemText} onChange={(e) => setItemText(e.target.value)} placeholder="Type a code or name" className={`${sel} mt-1 w-full`} />
          <datalist id="items-list">{items.map((i) => <option key={i.id} value={`${i.code} - ${i.name}`} />)}</datalist>
        </label>
        <label className="text-sm">{twoLeg ? "From" : "Taken from"}
          <select value={from} onChange={(e) => setFrom(e.target.value)} className={`${sel} mt-1 w-full`}>
            <option value="">Choose...</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}
          </select>
        </label>
        {twoLeg && (
          <label className="text-sm">To
            <select value={to} onChange={(e) => setTo(e.target.value)} className={`${sel} mt-1 w-full`}>
              <option value="">Choose...</option>
              {locations.filter((l) => l.id !== from).map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}
            </select>
          </label>
        )}
        <label className="text-sm">Quantity {item?.purchase_unit && <span className="opacity-60">({item.purchase_unit})</span>}
          <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" className={`${sel} mt-1 w-full`} />
        </label>
        <label className="text-sm">Reference
          <input value={ref} onChange={(e) => setRef(e.target.value)} className={`${sel} mt-1 w-full`} />
        </label>
        <label className="text-sm sm:col-span-2">Note
          <input value={note} onChange={(e) => setNote(e.target.value)} className={`${sel} mt-1 w-full`} />
        </label>
        <div className="sm:col-span-2">
          <button className="rounded bg-orange-500 px-4 py-2 font-medium text-white">Record</button>
          {err && <span className="ml-3 text-sm text-red-600">{err}</span>}
          {msg && <span className="ml-3 text-sm text-green-700 dark:text-green-400">{msg}</span>}
        </div>
      </form>
    </section>
  );
}

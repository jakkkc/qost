"use client";

import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppShell";
import { fetchAll, locLabel } from "@/lib/db";
import { supabase } from "@/lib/supabase";

interface Balance { item_id: string; location_id: string; qty: number; unit: string; unit_cost: number | null; value: number | null }
interface ItemRow { id: string; name: string }
interface Movement { id: string; movement_date: string; kind: string; qty: number; ref_no: string | null; note: string | null; locations: { branch: string; name: string } | null }

const KIND: Record<string, string> = {
  receipt: "Received", issue_out: "Issued out", issue_in: "Issued in", transfer_out: "Transfer out", transfer_in: "Transfer in",
  spoilage: "Spoilage", staff_meal: "Staff meal", complimentary: "Complimentary", conference: "Conference",
  count_adjust: "Count adjustment", opening: "Opening stock", reversal: "Reversal",
};
const sel = "rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/20";
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 3 });

export default function StockPage() {
  const { locations } = useApp();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [items, setItems] = useState<Map<string, ItemRow>>(new Map());
  const [location, setLocation] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState<{ item: ItemRow; loc: string } | null>(null);
  const [moves, setMoves] = useState<Movement[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [b, its] = await Promise.all([
          fetchAll<Balance>((a, z) => supabase.from("stock_balances").select("item_id,location_id,qty,unit,unit_cost,value").range(a, z)),
          fetchAll<ItemRow>((a, z) => supabase.from("items").select("id,name").range(a, z)),
        ]);
        setBalances(b);
        setItems(new Map(its.map((i) => [i.id, i])));
      } catch (e) { setError((e as Error).message); }
    })();
  }, []);

  const rows = useMemo(() => balances
    .filter((b) => (!location || b.location_id === location) && Number(b.qty) !== 0)
    .map((b) => ({ b, item: items.get(b.item_id) }))
    .filter((r): r is { b: Balance; item: ItemRow } => !!r.item)
    .filter((r) => { const q = search.trim().toLowerCase(); return !q || r.item.name.toLowerCase().includes(q); })
    .sort((a, b) => a.item.name.localeCompare(b.item.name)), [balances, items, location, search]);

  const locName = (id: string) => { const l = locations.find((x) => x.id === id); return l ? locLabel(l) : ""; };
  const value = rows.reduce((s, r) => s + Number(r.b.value ?? 0), 0);

  async function showMoves(item: ItemRow, loc: string) {
    setOpen({ item, loc });
    const { data, error: e } = await supabase.from("stock_movements")
      .select("id,movement_date,kind,qty,ref_no,note,locations(branch,name)")
      .eq("item_id", item.id).eq("location_id", loc).order("movement_date", { ascending: false }).order("created_at", { ascending: false }).limit(50);
    if (e) setError(e.message); else setMoves((data ?? []) as unknown as Movement[]);
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Stock</h1>
      <p className="mb-4 text-sm opacity-70">Current balances by location, from the stock ledger. In ingredient units, valued at the last purchase price (VAT-inclusive).</p>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <select value={location} onChange={(e) => setLocation(e.target.value)} className={sel}>
          <option value="">All locations</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}
        </select>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ingredients" className={`${sel} w-64`} />
        <span className="text-sm opacity-70">{rows.length} lines, value {fmt(value)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="opacity-60"><tr><th className="py-1">Ingredient</th><th>Location</th><th>On hand</th><th>Unit cost</th><th>Value</th></tr></thead>
          <tbody>
            {rows.map(({ b, item }) => (
              <tr key={`${b.item_id}-${b.location_id}`} onClick={() => showMoves(item, b.location_id)} className="cursor-pointer border-t border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5">
                <td className="py-1">{item.name}</td><td>{locName(b.location_id)}</td>
                <td className={Number(b.qty) < 0 ? "font-medium text-red-600" : ""}>{fmt(Number(b.qty))} {b.unit}</td>
                <td>{b.unit_cost !== null ? fmt(Number(b.unit_cost)) : <span className="opacity-50">no cost</span>}</td>
                <td>{b.value !== null ? fmt(Number(b.value)) : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="py-6 text-sm opacity-60">No stock yet. Import an opening stock sheet and a purchasing report to get started.</p>}
      </div>

      {open && (
        <div className="fixed inset-y-0 right-0 z-10 w-full max-w-md overflow-y-auto border-l border-black/10 bg-[var(--background)] p-4 shadow-xl dark:border-white/10">
          <div className="mb-3 flex items-start justify-between">
            <div><h2 className="font-semibold">{open.item.name}</h2><p className="text-xs opacity-70">{locName(open.loc)}</p></div>
            <button onClick={() => setOpen(null)} className="text-sm underline">Close</button>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="opacity-60"><tr><th>Date</th><th>Type</th><th>Qty</th><th>Ref</th></tr></thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id} className="border-t border-black/10 dark:border-white/10">
                  <td className="py-1">{m.movement_date}</td><td>{KIND[m.kind] ?? m.kind}</td>
                  <td className={Number(m.qty) < 0 ? "text-red-600" : ""}>{fmt(Number(m.qty))}</td><td>{m.ref_no}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

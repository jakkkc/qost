"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppShell";
import { fetchAll, locLabel } from "@/lib/db";
import { supabase } from "@/lib/supabase";

interface Item { id: string; name: string; unit: string; unit_cost: number | null; unit_cost_at: string | null }

const inp = "rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/20";

export default function IngredientsPage() {
  const { locations, tenantId } = useApp();
  const [parLoc, setParLoc] = useState("");
  const [pars, setPars] = useState<Record<string, number>>({});
  const [parDrafts, setParDrafts] = useState<Record<string, string>>({});
  const [items, setItems] = useState<Item[]>([]);
  const [aliasCount, setAliasCount] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [noCost, setNoCost] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const its = await fetchAll<Item>((a, b) => supabase.from("items").select("id,name,unit,unit_cost,unit_cost_at").order("name").range(a, b));
      const al = await fetchAll<{ item_id: string }>((a, b) => supabase.from("item_aliases").select("item_id").range(a, b));
      const c: Record<string, number> = {};
      al.forEach((x) => { c[x.item_id] = (c[x.item_id] ?? 0) + 1; });
      setItems(its); setAliasCount(c);
    } catch (e) { setError((e as Error).message); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount
  useEffect(() => { load(); }, [load]);

  const loadPars = useCallback(async () => {
    if (!parLoc) { setPars({}); return; }
    const { data, error: e } = await supabase.from("par_levels").select("item_id,par_qty").eq("location_id", parLoc);
    if (e) return setError(e.message);
    setPars(Object.fromEntries((data ?? []).map((p) => [p.item_id, Number(p.par_qty)])));
    setParDrafts({});
  }, [parLoc]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reload when the location changes
  useEffect(() => { loadPars(); }, [loadPars]);

  async function savePar(i: Item) {
    const raw = parDrafts[i.id];
    if (raw === "") {
      const { error: e } = await supabase.from("par_levels").delete().eq("item_id", i.id).eq("location_id", parLoc);
      if (e) return setError(e.message);
    } else {
      const v = parseFloat(raw);
      if (!(v >= 0)) return setError("Par level must be 0 or more.");
      const { error: e } = await supabase.from("par_levels").upsert({ tenant_id: tenantId, item_id: i.id, location_id: parLoc, par_qty: v });
      if (e) return setError(e.message);
    }
    loadPars();
  }

  const shown = useMemo(() => items.filter((i) => {
    if (noCost && i.unit_cost !== null) return false;
    const q = search.trim().toLowerCase();
    return !q || i.name.toLowerCase().includes(q);
  }), [items, search, noCost]);

  async function saveCost(i: Item) {
    const v = parseFloat(drafts[i.id]);
    if (!(v >= 0)) return setError("Enter a cost of 0 or more.");
    const { error: e } = await supabase.from("items").update({ unit_cost: v, unit_cost_at: new Date().toISOString().slice(0, 10) }).eq("id", i.id);
    if (e) return setError(e.message);
    setDrafts((d) => { const n = { ...d }; delete n[i.id]; return n; });
    load();
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Ingredients</h1>
      <p className="mb-4 text-sm opacity-70">
        The ingredient list from the workbook, in least units. The unit cost updates by itself from the latest purchase of a mapped system item.
        Type a cost here only for ingredients you haven&apos;t bought yet.
        {items.length > 0 && <> <b>{items.filter((i) => i.unit_cost === null).length}</b> of {items.length} have no cost.</>}
      </p>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ingredients" className={`${inp} w-64`} />
        <label className="text-sm">Par levels for <select value={parLoc} onChange={(e) => setParLoc(e.target.value)} className={inp}><option value="">(none)</option>{locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}</select></label>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={noCost} onChange={(e) => setNoCost(e.target.checked)} /> No cost yet</label>
        <span className="text-sm opacity-60">{shown.length} shown</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="opacity-60"><tr><th className="py-1">Ingredient</th><th>Unit</th><th>Unit cost (KES)</th><th>As of</th><th>Mapped system items</th>{parLoc && <th>Par level</th>}<th /></tr></thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.id} className="border-t border-black/10 dark:border-white/10">
                <td className="py-1">{i.name}</td>
                <td>{i.unit}</td>
                <td>
                  <input value={drafts[i.id] ?? (i.unit_cost?.toString() ?? "")} onChange={(e) => setDrafts({ ...drafts, [i.id]: e.target.value })} inputMode="decimal" className={`${inp} w-28`} placeholder="-" />
                </td>
                <td>{i.unit_cost_at ?? ""}</td>
                <td>{aliasCount[i.id] ?? 0}</td>
                {parLoc && (
                  <td>
                    <span className="flex items-center gap-1">
                      <input value={parDrafts[i.id] ?? (pars[i.id]?.toString() ?? "")} onChange={(e) => setParDrafts({ ...parDrafts, [i.id]: e.target.value })} inputMode="decimal" className={`${inp} w-24`} placeholder="-" />
                      {parDrafts[i.id] !== undefined && <button onClick={() => savePar(i)} className="rounded bg-orange-500 px-2 py-1 text-white">Set</button>}
                    </span>
                  </td>
                )}
                <td>{drafts[i.id] !== undefined && <button onClick={() => saveCost(i)} className="rounded bg-orange-500 px-2 py-1 text-white">Save</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && <p className="py-6 text-sm opacity-60">No ingredients yet. Import the workbook on the Settings page.</p>}
      </div>
    </div>
  );
}

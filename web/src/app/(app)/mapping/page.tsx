"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppShell";
import { fetchAll } from "@/lib/db";
import { suggestPackSize } from "@/lib/packSize";
import { supabase } from "@/lib/supabase";

interface Waiting { system_code: number; system_name: string | null; system_unit: string | null; row: { qty?: number } }
interface Group { code: number; name: string; unit: string; lines: number }
interface Item { id: string; name: string; unit: string }
interface Alias { system_code: number; system_name: string; system_unit: string | null; factor: number; items: { name: string; unit: string } | null }
interface Draft { ingredient: string; factor: string }

const inp = "rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/20";
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);

/** Best ingredient for a system item name by shared words (ignoring pack sizes like 500ML). */
function bestMatch(name: string, items: Item[]): Item | null {
  const w = new Set(words(name).filter((x) => !/^\d/.test(x)));
  if (!w.size) return null;
  let best: Item | null = null, bestScore = 0;
  for (const it of items) {
    const iw = words(it.name);
    if (!iw.length) continue;
    const hit = iw.filter((x) => w.has(x)).length;
    const score = hit / iw.length - 0.01 * Math.abs(iw.length - w.size);
    if (hit > 0 && score > bestScore) { best = it; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

/** Ingredient units in one system unit, guessed from the system name and unit. */
function guessFactor(name: string, unit: string, ing: Item | null): string {
  const s = suggestPackSize(name, unit);
  if (!s || !ing) return "";
  if (s.base_unit === "g" && ing.unit === "g") return String(s.factor);
  if (s.base_unit === "ml" && ing.unit === "ml") return String(s.factor);
  if (s.base_unit === "each" && ing.unit !== "g" && ing.unit !== "ml") return "1";
  return "";
}

export default function MappingPage() {
  const { tenantId } = useApp();
  const [groups, setGroups] = useState<Group[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [w, its, al] = await Promise.all([
        fetchAll<Waiting>((a, b) => supabase.from("unmapped_lines").select("system_code,system_name,system_unit,row").range(a, b)),
        fetchAll<Item>((a, b) => supabase.from("items").select("id,name,unit").order("name").range(a, b)),
        fetchAll<Alias>((a, b) => supabase.from("item_aliases").select("system_code,system_name,system_unit,factor,items(name,unit)").order("system_code").range(a, b) as never),
      ]);
      const g = new Map<number, Group>();
      w.forEach((x) => {
        const cur = g.get(x.system_code) ?? { code: x.system_code, name: x.system_name ?? "", unit: x.system_unit ?? "", lines: 0 };
        cur.lines += 1; g.set(x.system_code, cur);
      });
      setGroups([...g.values()].sort((a, b) => a.name.localeCompare(b.name)));
      setItems(its); setAliases(al);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount
  useEffect(() => { load(); }, [load]);

  const byName = useMemo(() => new Map(items.map((i) => [i.name, i])), [items]);

  const draftOf = (g: Group): Draft => {
    if (drafts[g.code]) return drafts[g.code];
    const m = bestMatch(g.name, items);
    return { ingredient: m?.name ?? "", factor: guessFactor(g.name, g.unit, m) };
  };
  const setDraft = (g: Group, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [g.code]: { ...draftOf(g), ...patch } }));

  async function save(g: Group) {
    setErr(""); setMsg("");
    const d = draftOf(g);
    const ing = byName.get(d.ingredient);
    const factor = parseFloat(d.factor);
    if (!ing) return setErr("Pick an ingredient from the list.");
    if (!(factor > 0)) return setErr(`Enter how many ${ing.unit} are in one ${g.unit || "system unit"}.`);
    setBusy(g.code);
    const { error: e1 } = await supabase.from("item_aliases").insert({ tenant_id: tenantId, system_code: g.code, system_name: g.name, system_unit: g.unit, item_id: ing.id, factor });
    if (e1) { setBusy(null); return setErr(e1.message); }
    const { data, error: e2 } = await supabase.rpc("process_unmapped", { p_code: g.code });
    setBusy(null);
    if (e2) return setErr(e2.message);
    setMsg(`${g.name} mapped to ${ing.name}. ${data} waiting lines were posted.`);
    setDrafts((x) => { const n = { ...x }; delete n[g.code]; return n; });
    load();
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Item mapping</h1>
      <p className="mb-4 text-sm opacity-70">
        Each system item (from purchases, issues and stock counts) is linked once to a workbook ingredient with a conversion, for example 1 KGS = 1000 g.
        After you save a mapping, its waiting lines are posted straight away.
      </p>
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
      {msg && <p className="mb-3 text-sm text-green-700 dark:text-green-400">{msg}</p>}
      <datalist id="map-items">{items.map((i) => <option key={i.id} value={i.name} />)}</datalist>

      <h2 className="mb-2 text-lg font-semibold">Waiting for a mapping ({groups.length})</h2>
      {groups.length === 0 ? <p className="mb-8 text-sm opacity-60">Nothing is waiting. New system items from imports appear here.</p> : (
        <div className="mb-8 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="opacity-60"><tr><th className="py-1">System item</th><th>Unit</th><th>Lines</th><th>Ingredient</th><th>1 system unit =</th><th /></tr></thead>
            <tbody>
              {groups.map((g) => {
                const d = draftOf(g);
                const ing = byName.get(d.ingredient);
                return (
                  <tr key={g.code} className="border-t border-black/10 align-top dark:border-white/10">
                    <td className="py-1">{g.code} {g.name}</td><td>{g.unit}</td><td>{g.lines}</td>
                    <td><input list="map-items" value={d.ingredient} onChange={(e) => setDraft(g, { ingredient: e.target.value })} className={`${inp} w-60`} placeholder="Ingredient" /></td>
                    <td>
                      <span className="flex items-center gap-1">
                        <input value={d.factor} onChange={(e) => setDraft(g, { factor: e.target.value })} inputMode="decimal" className={`${inp} w-24`} /> {ing?.unit}
                      </span>
                    </td>
                    <td><button onClick={() => save(g)} disabled={busy === g.code} className="rounded bg-orange-500 px-3 py-1 text-white disabled:opacity-50">Map</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mb-2 text-lg font-semibold">Mapped ({aliases.length})</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="opacity-60"><tr><th className="py-1">System item</th><th>Unit</th><th>Ingredient</th><th>Factor</th></tr></thead>
          <tbody>
            {aliases.slice(0, 200).map((a) => (
              <tr key={a.system_code} className="border-t border-black/10 dark:border-white/10">
                <td className="py-1">{a.system_code} {a.system_name}</td><td>{a.system_unit}</td>
                <td>{a.items?.name}</td><td>1 = {Number(a.factor)} {a.items?.unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {aliases.length > 200 && <p className="py-2 text-xs opacity-60">Showing the first 200.</p>}
      </div>
    </div>
  );
}

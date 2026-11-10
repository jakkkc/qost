"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

interface Batch {
  id: string; file_name: string | null; row_count: number; skipped_count: number;
  replaced_count: number; created_at: string; reversed_at: string | null;
}

/** Past imports of one kind, each with an undo that writes reversing ledger entries. */
export function BatchList({ kind, refreshKey, onChange }: { kind: "purchases" | "issues" | "opening" | "sales" | "counts"; refreshKey: number; onChange: () => void }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from("import_batches").select("*")
      .eq("kind", kind).order("created_at", { ascending: false }).limit(15);
    if (e) setError(e.message); else setBatches(data ?? []);
  }, [kind]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount and after imports
  useEffect(() => { load(); }, [load, refreshKey]);

  async function reverse(b: Batch) {
    if (!confirm(`Reverse the import of "${b.file_name ?? "file"}" (${b.row_count} rows)? Stock goes back to how it was before it.`)) return;
    const { error: e } = await supabase.rpc("reverse_batch", { p_batch: b.id });
    if (e) return setError(e.message);
    await load();
    onChange();
  }

  if (!batches.length && !error) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-lg font-semibold">Past imports</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <table className="w-full text-left text-sm">
        <thead className="opacity-60"><tr><th className="py-1">When</th><th>File</th><th>Rows</th><th>Skipped</th><th>Replaced</th><th /></tr></thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} className="border-t border-black/10 dark:border-white/10">
              <td className="py-1">{new Date(b.created_at).toLocaleString()}</td>
              <td>{b.file_name}</td><td>{b.row_count}</td><td>{b.skipped_count}</td><td>{b.replaced_count}</td>
              <td className="text-right">
                {b.reversed_at ? <span className="opacity-60">reversed</span>
                  : <button onClick={() => reverse(b)} className="text-red-600 underline">Reverse</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

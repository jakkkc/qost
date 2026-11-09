import { supabase } from "./supabase";

export const chunk = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** PostgREST returns at most 1000 rows per request; this pages through all of them. */
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

export interface Loc { id: string; branch: string; name: string; kind: string }
export interface ItemLite { id: string; name: string; unit: string; unit_cost: number | null }

export const locLabel = (l: Loc) => `${l.branch} - ${l.name}`;

export async function loadItemsLite(): Promise<ItemLite[]> {
  return fetchAll<ItemLite>((a, b) =>
    supabase.from("items").select("id,name,unit,unit_cost").order("name").range(a, b));
}

"use client";

const inp = "rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/20";
export const BRANCHES = ["Cottages", "Tuuti"];

export const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString("en-CA"); };
export const todayIso = () => new Date().toLocaleDateString("en-CA");

export interface Period { branch: string; from: string; to: string }

/** Branch and date range used by every report. Sales imports count when their whole range lies inside it. */
export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className="text-sm">Branch<select value={value.branch} onChange={(e) => onChange({ ...value, branch: e.target.value })} className={`${inp} mt-1 block`}>{BRANCHES.map((b) => <option key={b}>{b}</option>)}</select></label>
      <label className="text-sm">From<input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} className={`${inp} mt-1 block`} /></label>
      <label className="text-sm">To<input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} className={`${inp} mt-1 block`} /></label>
    </div>
  );
}

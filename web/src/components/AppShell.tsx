"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Loc } from "@/lib/db";

interface AppCtx { locations: Loc[]; tenantId: string }
const Ctx = createContext<AppCtx>({ locations: [], tenantId: "" });
export const useApp = () => useContext(Ctx);

const NAV = [
  { href: "/stock", label: "Stock" },
  { href: "/recipes", label: "Recipes" },
  { href: "/packages", label: "Packages" },
  { href: "/pos", label: "POS check" },
  { href: "/purchases", label: "Purchases" },
  { href: "/issues", label: "Issues & transfers" },
  { href: "/opening", label: "Opening stock" },
  { href: "/mapping", label: "Item mapping" },
  { href: "/items", label: "Ingredients" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [state, setState] = useState<"loading" | "setup" | "ready" | "error">("loading");
  const [locations, setLocations] = useState<Loc[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data: s } = await supabase.auth.getSession();
    if (!s.session) return router.replace("/login");
    const { data: member, error: e1 } = await supabase.from("tenant_members").select("tenant_id").limit(1);
    if (e1) { setError(e1.message); return setState("error"); }
    if (!member?.length) return setState("setup");
    const { data: locs, error: e2 } = await supabase.from("locations").select("id,branch,name,kind").order("branch").order("name");
    if (e2) { setError(e2.message); return setState("error"); }
    setLocations(locs ?? []);
    setTenantId(member[0].tenant_id);
    setState("ready");
  }, [router]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount
    load();
    const { data: sub } = supabase.auth.onAuthStateChange((evt) => {
      if (evt === "SIGNED_OUT") router.replace("/login");
    });
    return () => sub.subscription.unsubscribe();
  }, [load, router]);

  async function setup() {
    const { error: e } = await supabase.rpc("bootstrap_tenant", { p_name: "Hunters Paradise" });
    if (e) { setError(e.message); return setState("error"); }
    setState("loading");
    load();
  }

  if (state === "loading") return <p className="p-8 text-sm opacity-70">Loading...</p>;
  if (state === "error") return <p className="p-8 text-sm text-red-600">Something went wrong: {error}</p>;
  if (state === "setup") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-xl font-semibold">Welcome to Qost</h1>
        <p className="text-sm opacity-80">
          First run: this creates the Hunters Paradise workspace with its five locations
          (Cottages: Kitchen, Duma Bar, Dispense Bar. Tuuti: Kitchen, Duma Bar).
        </p>
        <button onClick={setup} className="rounded-md bg-orange-500 px-4 py-2 font-medium text-white hover:bg-orange-600">
          Set up Hunters Paradise
        </button>
      </main>
    );
  }

  return (
    <Ctx.Provider value={{ locations, tenantId }}>
      <div className="flex min-h-screen flex-col md:flex-row">
        <aside className="flex shrink-0 flex-row items-center gap-2 border-b border-black/10 p-3 md:w-56 md:flex-col md:items-stretch md:border-b-0 md:border-r dark:border-white/10">
          <div className="flex items-center gap-2 px-2 md:mb-4 md:py-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/qost-mark.svg" alt="" className="h-8 w-8" />
            <span className="text-lg font-semibold tracking-wide">Qost</span>
          </div>
          <nav className="flex flex-1 gap-1 overflow-x-auto md:flex-col">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}
                className={`whitespace-nowrap rounded-md px-3 py-2 text-sm ${path.startsWith(n.href) ? "bg-orange-500 text-white" : "hover:bg-black/5 dark:hover:bg-white/10"}`}>
                {n.label}
              </Link>
            ))}
          </nav>
          <button onClick={() => supabase.auth.signOut()} className="rounded-md px-3 py-2 text-left text-sm opacity-70 hover:bg-black/5 dark:hover:bg-white/10">
            Sign out
          </button>
        </aside>
        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>
    </Ctx.Provider>
  );
}

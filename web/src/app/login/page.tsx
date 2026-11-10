"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabase } from "@/lib/supabase";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(mode: "in" | "up") {
    setBusy(true);
    setMessage("");
    const res = mode === "in"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (res.error) return setMessage(res.error.message);
    if (res.data.session) return router.replace("/dashboard");
    setMessage("Account created. Check your email to confirm it, then sign in.");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/qost-logo.svg" alt="Qost" className="mx-auto w-56" />
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit("in"); }}>
        <input type="email" required autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-black/20 bg-transparent px-3 py-2 dark:border-white/20" />
        <input type="password" required minLength={6} autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-black/20 bg-transparent px-3 py-2 dark:border-white/20" />
        <button disabled={busy} className="rounded-md bg-orange-500 px-4 py-2 font-medium text-white hover:bg-orange-600 disabled:opacity-50">Sign in</button>
        <button type="button" disabled={busy} onClick={() => submit("up")} className="text-sm underline opacity-80">
          First time? Create the account
        </button>
      </form>
      {message && <p className="text-center text-sm">{message}</p>}
    </main>
  );
}

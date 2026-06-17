"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";

type Mode = "signin" | "signup";

export default function AuthPage() {
  const [mode, setMode]       = useState<Mode>("signin");
  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    const supabase = createClient();

    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setError(error.message);
      } else {
        setMessage("Account created! Check your email to confirm, then sign in.");
        setMode("signin");
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
      } else {
        router.push("/");
        router.refresh();
      }
    }

    setLoading(false);
  };

  return (
    <main className="relative min-h-screen overflow-hidden flex items-center justify-center px-4 text-white">

      {/* Background */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[#0a0f1e]" />
        <div className="absolute top-0 left-0 w-[700px] h-[700px] rounded-full opacity-40 blur-[120px]"
          style={{ background: "radial-gradient(circle, #6d28d9 0%, transparent 70%)" }} />
        <div className="absolute bottom-0 right-0 w-[600px] h-[600px] rounded-full opacity-30 blur-[120px]"
          style={{ background: "radial-gradient(circle, #0891b2 0%, transparent 70%)" }} />
      </div>

      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="text-center mb-10">
          <h1
            className="text-5xl font-bold mb-2 tracking-tight"
            style={{
              background: "linear-gradient(135deg, #ffffff 0%, #c4b5fd 50%, #67e8f9 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              letterSpacing: "-0.04em",
            }}
          >
            Lumina
          </h1>
          <p className="text-sm text-slate-400">Your AI knowledge studio</p>
        </div>

        {/* Card */}
        <div className="bg-white/[0.03] border border-white/[0.08] rounded-2xl p-8 backdrop-blur-sm shadow-2xl shadow-black/40">

          {/* Mode toggle */}
          <div className="flex gap-1 p-1 bg-white/[0.04] border border-white/[0.06] rounded-xl mb-7">
            {(["signin", "signup"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setError(null); setMessage(null); }}
                className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${
                  mode === m
                    ? "bg-gradient-to-r from-violet-600 to-cyan-600 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {m === "signin" ? "Sign In" : "Sign Up"}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Email address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="w-full bg-white/[0.05] border border-white/[0.1] rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-violet-500/70 focus:bg-white/[0.07] transition-all"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                placeholder={mode === "signup" ? "Min 6 characters" : "••••••••"}
                minLength={6}
                className="w-full bg-white/[0.05] border border-white/[0.1] rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-violet-500/70 focus:bg-white/[0.07] transition-all"
              />
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/25 rounded-xl text-red-300 text-xs leading-relaxed">
                {error}
              </div>
            )}

            {message && (
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/25 rounded-xl text-emerald-300 text-xs leading-relaxed">
                {message}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 disabled:opacity-60 disabled:cursor-not-allowed rounded-xl text-sm font-semibold transition-all shadow-lg shadow-violet-700/25 flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  {mode === "signin" ? "Signing in…" : "Creating account…"}
                </>
              ) : (
                mode === "signin" ? "Sign In" : "Create Account"
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-slate-600">
            {mode === "signin" ? "Don't have an account? " : "Already have an account? "}
            <button
              type="button"
              onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(null); setMessage(null); }}
              className="text-violet-400 hover:text-violet-300 transition-colors"
            >
              {mode === "signin" ? "Sign up" : "Sign in"}
            </button>
          </p>
        </div>

        <p className="text-center text-[11px] text-slate-700 mt-8">
          FastAPI · Next.js · Groq · Qdrant · Supabase
        </p>
      </div>
    </main>
  );
}

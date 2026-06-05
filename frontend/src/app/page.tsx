"use client";

import { useEffect, useState } from "react";

interface BackendStatus {
  service: string;
  status: string;
  version: string;
}

export default function Home() {
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("http://localhost:8000/")
      .then((res) => res.json())
      .then((data) => setBackend(data))
      .catch((err) => setError(err.message));
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white flex items-center justify-center p-8">
      <div className="max-w-2xl w-full">
        <h1 className="text-6xl font-bold mb-4 bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">
          Lumina
        </h1>
        <p className="text-xl text-slate-300 mb-8">
          AI Knowledge Studio — Transform PDFs into conversations, tutors, and videos.
        </p>

        <div className="bg-slate-800/50 backdrop-blur-sm border border-slate-700 rounded-xl p-6">
          <h2 className="text-sm font-mono text-slate-400 mb-3">BACKEND STATUS</h2>
          {error && (
            <p className="text-red-400">❌ Backend unreachable: {error}</p>
          )}
          {!error && !backend && (
            <p className="text-yellow-400">⏳ Connecting...</p>
          )}
          {backend && (
            <div className="space-y-2">
              <p className="text-green-400">✅ Connected to {backend.service}</p>
              <p className="text-slate-400 text-sm">
                Status: <span className="text-white">{backend.status}</span>
              </p>
              <p className="text-slate-400 text-sm">
                Version: <span className="text-white">{backend.version}</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
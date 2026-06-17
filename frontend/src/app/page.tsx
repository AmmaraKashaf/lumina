"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { apiFetch } from "@/lib/api";

interface Document {
  id: string;
  title: string;
  filename: string;
  status: string;
  page_count?: number;
  chunk_count?: number;
}

interface UploadResponse extends Document {
  signed_url: string;
}

interface ActiveUpload {
  id: string;
  filename: string;
  page_count: number | null;
  chunk_count: number | null;
}

type UploadPhase = "uploading" | "indexing" | "ready" | "failed" | null;

function StepRow({
  label,
  sublabel,
  done,
  active,
}: {
  label: string;
  sublabel?: string;
  done: boolean;
  active: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center transition-all
          ${done   ? "bg-emerald-500/20 border border-emerald-500/40"
          : active ? "bg-amber-500/20  border border-amber-400/40"
          :          "bg-white/[0.03]  border border-white/[0.1]"}`}
      >
        {done ? (
          <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        ) : active ? (
          <div className="w-2.5 h-2.5 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
        ) : (
          <div className="w-1.5 h-1.5 rounded-full bg-slate-600" />
        )}
      </div>
      <div>
        <p className={`text-sm font-medium leading-tight
          ${done ? "text-slate-200" : active ? "text-amber-300" : "text-slate-500"}`}>
          {label}
        </p>
        {sublabel && (
          <p className="text-[11px] text-slate-500 mt-0.5">{sublabel}</p>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  const [documents, setDocuments]       = useState<Document[]>([]);
  const [uploading, setUploading]       = useState(false);
  const [dragActive, setDragActive]     = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [activeUpload, setActiveUpload] = useState<ActiveUpload | null>(null);
  const [uploadPhase, setUploadPhase]   = useState<UploadPhase>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting]         = useState(false);
  const [userEmail, setUserEmail]       = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const router = useRouter();

  // Load current user email
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setUserEmail(user.email ?? null);
    });
  }, []);

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/auth");
  };

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };
  useEffect(() => () => stopPolling(), []);

  const startPolling = (documentId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res  = await apiFetch(`/documents/${documentId}/status`);
        const data = await res.json();
        if (data.status === "ready") {
          setUploadPhase("ready");
          stopPolling();
          setDocuments((prev) =>
            prev.map((d) => (d.id === documentId ? { ...d, status: "ready" } : d))
          );
        } else if (data.status === "index_failed" || data.status === "failed") {
          setUploadPhase("failed");
          setError("Indexing failed. You can still click Reprocess from the library.");
          stopPolling();
          setDocuments((prev) =>
            prev.map((d) => (d.id === documentId ? { ...d, status: "index_failed" } : d))
          );
        }
      } catch { /* ignore transient errors */ }
    }, 2500);
  };

  const uploadFile = async (file: File) => {
    setError(null);
    setUploading(true);
    setUploadPhase("uploading");
    setActiveUpload(null);
    stopPolling();

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await apiFetch("/documents/upload", { method: "POST", body: formData });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || "Upload failed");
      }
      const data: UploadResponse = await res.json();
      setDocuments((prev) => [data, ...prev]);
      setActiveUpload({
        id: data.id,
        filename: data.filename,
        page_count: data.page_count ?? null,
        chunk_count: data.chunk_count ?? null,
      });
      setUploadPhase("indexing");
      startPolling(data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setUploadPhase("failed");
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
  };

  const loadDocuments = async () => {
    try {
      const res  = await apiFetch("/documents/");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setDocuments(data);
    } catch (err) {
      console.error("Failed to load documents:", err);
    }
  };

  useEffect(() => { loadDocuments(); }, []);

  const confirmDelete = async (docId: string) => {
    setDeleting(true);
    try {
      const res = await apiFetch(`/documents/${docId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      setDocuments((prev) => prev.filter((d) => d.id !== docId));
      setDeleteTarget(null);
      if (activeUpload?.id === docId) dismissProgress();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete document");
    } finally {
      setDeleting(false);
    }
  };

  const reprocessDocument = async (docId: string) => {
    try {
      const res = await apiFetch(`/documents/${docId}/process`, { method: "POST" });
      if (!res.ok) throw new Error("Reprocess failed");
      await loadDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reprocess failed");
    }
  };

  const dismissProgress = () => {
    stopPolling();
    setActiveUpload(null);
    setUploadPhase(null);
  };

  const readyCount = documents.filter((d) => d.status === "ready").length;
  const chunkLabel = activeUpload?.chunk_count
    ? `Parsed & chunked — ${activeUpload.chunk_count} chunks, ${activeUpload.page_count ?? "?"} pages`
    : "Parsed & chunked";

  return (
    <main className="relative min-h-screen overflow-hidden text-white">

      {/* Background */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[#0a0f1e]" />
        <div className="absolute top-0 left-0 w-[800px] h-[800px] rounded-full opacity-40 blur-[120px]"
          style={{ background: "radial-gradient(circle, #6d28d9 0%, transparent 70%)" }} />
        <div className="absolute bottom-0 right-0 w-[700px] h-[700px] rounded-full opacity-30 blur-[120px]"
          style={{ background: "radial-gradient(circle, #0891b2 0%, transparent 70%)" }} />
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full opacity-20 blur-[100px]"
          style={{ background: "radial-gradient(circle, #4f46e5 0%, transparent 70%)" }} />
        <div className="absolute inset-0 opacity-[0.015] mix-blend-overlay"
          style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' /%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' /%3E%3C/svg%3E\")" }} />
      </div>

      {/* Top nav bar */}
      <nav className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#0a0f1e]/80 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <span
            className="text-lg font-bold tracking-tight"
            style={{
              background: "linear-gradient(135deg, #ffffff 0%, #c4b5fd 50%, #67e8f9 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            Lumina
          </span>
          {userEmail && (
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <span className="hidden sm:block text-xs text-slate-500 truncate max-w-[160px]">
                {userEmail}
              </span>
              <button
                onClick={handleSignOut}
                className="flex-shrink-0 px-3 py-1.5 text-xs font-medium text-slate-400 border border-white/[0.08] hover:border-white/[0.2] hover:text-slate-200 rounded-lg transition-all"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </nav>

      <div className="relative max-w-5xl mx-auto px-4 sm:px-6 py-10 sm:py-16">

        {/* Hero */}
        <div className="text-center mb-10 sm:mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 mb-8 bg-white/[0.04] border border-white/[0.08] rounded-full text-xs font-medium text-slate-400 backdrop-blur-sm">
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
            AI Knowledge Studio
          </div>
          <h1
            className="text-5xl sm:text-7xl md:text-8xl font-bold mb-5 tracking-tight"
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
          <p className="text-base sm:text-lg md:text-xl text-slate-300 max-w-2xl mx-auto leading-relaxed font-light px-2">
            Turn any PDF into a conversation, a quiz, a mind map.
          </p>
          <p className="text-xs sm:text-sm text-slate-500 mt-2 font-light">Your second brain for documents</p>
        </div>

        {/* Feature chips */}
        <div className="flex flex-wrap justify-center gap-2 mb-8 sm:mb-10">
          {[
            { icon: "💬", label: "Chat" },
            { icon: "📚", label: "Quizzes" },
            { icon: "🃏", label: "Flashcards" },
            { icon: "🕸️", label: "Mind maps" },
          ].map((f) => (
            <div key={f.label}
              className="px-3 py-1.5 bg-white/[0.03] border border-white/[0.06] rounded-full text-xs text-slate-400 backdrop-blur-sm">
              <span className="mr-1.5">{f.icon}</span>{f.label}
            </div>
          ))}
        </div>

        {/* Converter banner */}
        <div className="mb-8 sm:mb-10">
          <div className="relative overflow-hidden rounded-2xl p-4 sm:p-5 bg-gradient-to-r from-violet-500/[0.09] via-fuchsia-500/[0.05] to-cyan-500/[0.09] border border-violet-400/25 backdrop-blur-sm shadow-lg shadow-violet-900/20">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-violet-400/40 to-transparent" />
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                <div className="flex-shrink-0 w-10 h-10 sm:w-11 sm:h-11 bg-gradient-to-br from-violet-500/30 to-cyan-500/30 border border-violet-400/30 rounded-xl flex items-center justify-center">
                  <svg className="w-4 h-4 sm:w-5 sm:h-5 text-violet-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-100 mb-0.5">Convert Word Docs &amp; Chat Instantly</p>
                  <p className="text-xs text-slate-400 hidden sm:block">Upload .docx → auto-convert to PDF → download or start chatting</p>
                </div>
              </div>
              <a href="/converter"
                className="flex-shrink-0 inline-flex items-center gap-2 px-4 py-2.5 bg-violet-600/20 border border-violet-500/50 hover:bg-violet-600/30 hover:border-violet-400/70 rounded-xl text-xs font-semibold text-violet-300 hover:text-violet-100 transition-all">
                Open Converter
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
              </a>
            </div>
          </div>
        </div>

        {/* Upload zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
          className={`relative rounded-2xl p-8 sm:p-14 text-center transition-all backdrop-blur-sm
            ${dragActive
              ? "border-2 border-violet-400/60 bg-violet-500/[0.08] shadow-2xl shadow-violet-500/20"
              : "border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/[0.14]"}
            ${uploading ? "opacity-60 pointer-events-none" : "cursor-pointer"}`}
        >
          <input type="file" accept="application/pdf" onChange={handleFileSelect}
            disabled={uploading} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
          <div className="pointer-events-none relative">
            <div className="inline-flex items-center justify-center w-14 h-14 sm:w-16 sm:h-16 mb-4 sm:mb-5 bg-gradient-to-br from-violet-500/20 to-cyan-500/20 border border-white/10 rounded-2xl">
              {uploading ? (
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" />
                  <span className="w-1.5 h-1.5 bg-fuchsia-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              ) : (
                <svg className="w-6 h-6 sm:w-7 sm:h-7 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 13.5l3-3m0 0l3 3m-3-3v9m0-13.5h.008v.008H12V4.5zM3.75 19.5h16.5a.75.75 0 00.75-.75v-3a.75.75 0 00-.75-.75h-2.25" />
                </svg>
              )}
            </div>
            <p className="text-base sm:text-lg font-medium mb-1.5 text-slate-100">
              {uploading ? "Uploading…" : dragActive ? "Release to upload" : "Drop a PDF or tap to browse"}
            </p>
            <p className="text-xs text-slate-500">Max 50 MB · PDF only · Auto-indexed for chat</p>
          </div>
        </div>

        {/* Upload Progress Card */}
        {activeUpload && uploadPhase && (
          <div className={`mt-4 rounded-2xl backdrop-blur-sm overflow-hidden transition-all
            ${uploadPhase === "ready"
              ? "border border-emerald-500/30 bg-emerald-500/[0.04]"
              : uploadPhase === "failed"
              ? "border border-red-500/25 bg-red-500/[0.04]"
              : "border border-violet-400/20 bg-white/[0.02]"}`}>

            <div className={`px-4 sm:px-5 py-3 flex items-center justify-between border-b
              ${uploadPhase === "ready" ? "border-emerald-500/15" : uploadPhase === "failed" ? "border-red-500/15" : "border-white/[0.06]"}`}>
              <div className="flex items-center gap-2.5">
                {uploadPhase === "ready" ? <span className="w-2 h-2 bg-emerald-400 rounded-full" />
                  : uploadPhase === "failed" ? <span className="w-2 h-2 bg-red-400 rounded-full" />
                  : <span className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />}
                <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                  {uploadPhase === "ready" ? "Ready to Chat" : uploadPhase === "failed" ? "Processing Failed" : "Preparing Document…"}
                </span>
              </div>
              <button onClick={dismissProgress} className="text-slate-600 hover:text-slate-400 transition-colors p-0.5 rounded">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex items-center gap-3 px-4 sm:px-5 py-4 border-b border-white/[0.05]">
              <div className="flex-shrink-0 w-9 h-9 bg-gradient-to-br from-violet-500/15 to-cyan-500/15 border border-white/[0.08] rounded-lg flex items-center justify-center">
                <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-100 truncate">{activeUpload.filename}</p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {activeUpload.page_count != null && `${activeUpload.page_count} pages`}
                  {activeUpload.chunk_count != null && activeUpload.chunk_count > 0 && ` · ${activeUpload.chunk_count} chunks`}
                </p>
              </div>
            </div>

            <div className="px-4 sm:px-5 py-4 space-y-3.5">
              <StepRow label="Document uploaded" done={uploadPhase !== "uploading"} active={uploadPhase === "uploading"} />
              <StepRow label={chunkLabel} done={uploadPhase !== "uploading"} active={false} />
              <StepRow
                label="Generating embeddings"
                sublabel={uploadPhase === "indexing" ? "Building vector index — may take a minute for large documents…" : undefined}
                done={uploadPhase === "ready"}
                active={uploadPhase === "indexing"}
              />
              {uploadPhase === "ready" && <StepRow label="Indexing complete" done={true} active={false} />}
            </div>

            {uploadPhase === "ready" && (
              <div className="px-4 sm:px-5 pb-5">
                <p className="text-sm text-slate-300 mb-3">Your document is ready. Start chatting now.</p>
                <a href={`/chat?doc=${activeUpload.id}`}
                  className="flex items-center justify-center gap-2 w-full px-4 py-3 bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 border border-violet-500/40 rounded-xl text-sm font-semibold transition-all">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                  </svg>
                  Start chatting →
                </a>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mt-4 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-300 text-sm backdrop-blur-sm">
            {error}
          </div>
        )}

        {/* Stats */}
        {documents.length > 0 && (
          <div className="grid grid-cols-2 gap-3 mt-6 sm:mt-8">
            <div className="px-4 sm:px-5 py-4 bg-white/[0.02] border border-white/[0.07] rounded-xl backdrop-blur-sm">
              <p className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-medium">Documents</p>
              <p className="text-2xl font-semibold mt-1 text-slate-100">{documents.length}</p>
            </div>
            <div className="px-4 sm:px-5 py-4 bg-white/[0.02] border border-white/[0.07] rounded-xl backdrop-blur-sm">
              <p className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-medium">Ready</p>
              <p className="text-2xl font-semibold mt-1 text-slate-100">{readyCount}</p>
            </div>
          </div>
        )}

        {/* Library */}
        <div className="mt-10 sm:mt-12">
          <div className="flex items-center justify-between mb-4 sm:mb-5">
            <h2 className="text-lg sm:text-xl font-semibold text-slate-100">Your Library</h2>
            <button onClick={loadDocuments}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 border border-white/[0.08] hover:border-white/[0.18] hover:bg-white/[0.04] rounded-lg transition-all">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              Refresh
            </button>
          </div>

          {documents.length === 0 ? (
            <div className="text-center py-12 sm:py-14 bg-white/[0.02] border border-white/[0.05] rounded-2xl backdrop-blur-sm">
              <p className="text-slate-400 text-sm">No documents yet</p>
              <p className="text-xs text-slate-600 mt-1">Upload a PDF above to start</p>
            </div>
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => (
                <div key={doc.id}
                  className="group p-3 sm:p-4 bg-white/[0.02] border border-white/[0.07] rounded-xl hover:bg-white/[0.04] hover:border-white/[0.12] transition-all backdrop-blur-sm">
                  <div className="flex items-start sm:items-center justify-between gap-3 flex-wrap sm:flex-nowrap">

                    {/* doc info */}
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="flex-shrink-0 w-9 h-9 bg-gradient-to-br from-violet-500/15 to-cyan-500/15 border border-white/[0.08] rounded-lg flex items-center justify-center">
                        <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                        </svg>
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-100 truncate">{doc.title}</p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {doc.page_count != null && <span>{doc.page_count}p</span>}
                          {doc.chunk_count != null && doc.chunk_count > 0 && <span> · {doc.chunk_count} chunks</span>}
                          <span className={`ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full font-medium uppercase tracking-wide inline-flex items-center ${
                            doc.status === "ready" ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/25"
                            : doc.status === "indexing" || doc.status === "processing" ? "bg-amber-500/10 text-amber-300 border border-amber-500/25"
                            : "bg-red-500/10 text-red-300 border border-red-500/25"
                          }`}>
                            {doc.status === "ready" ? "ready" : doc.status === "indexing" ? "indexing" : doc.status === "index_failed" ? "failed" : doc.status}
                          </span>
                        </p>
                      </div>
                    </div>

                    {/* actions */}
                    <div className="flex items-center gap-1.5 flex-wrap ml-0 sm:ml-auto">
                      {(doc.status === "indexing" || doc.status === "processing") && (
                        <span className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-amber-300 border border-amber-500/20 bg-amber-500/[0.07] rounded-md">
                          <div className="w-2.5 h-2.5 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
                          Indexing…
                        </span>
                      )}

                      {doc.status === "ready" && (
                        <>
                          <a href={`/mindmap?doc=${doc.id}`}
                            className="px-2.5 py-1.5 text-[11px] font-medium text-slate-400 hover:text-slate-200 border border-white/[0.08] hover:border-white/[0.18] hover:bg-white/[0.05] rounded-md transition-all">
                            Map
                          </a>
                          <a href={`/learning?doc=${doc.id}`}
                            className="px-2.5 py-1.5 text-[11px] font-medium text-slate-400 hover:text-slate-200 border border-white/[0.08] hover:border-white/[0.18] hover:bg-white/[0.05] rounded-md transition-all">
                            Learn
                          </a>
                          <a href={`/chat?doc=${doc.id}`}
                            className="px-3 py-1.5 text-[11px] font-semibold bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 border border-violet-500/40 rounded-md transition-all shadow-md shadow-violet-600/20">
                            Chat →
                          </a>
                        </>
                      )}

                      {(doc.status === "pending" || doc.status === "failed" || doc.status === "index_failed") && (
                        <button onClick={() => reprocessDocument(doc.id)}
                          className="px-3 py-1.5 text-[11px] font-semibold bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 border border-violet-500/40 rounded-md transition-all">
                          Reprocess
                        </button>
                      )}

                      <button
                        onClick={() => setDeleteTarget({ id: doc.id, title: doc.title })}
                        title="Delete document"
                        className="p-1.5 text-slate-600 hover:text-red-400 hover:bg-red-500/[0.08] border border-transparent hover:border-red-500/20 rounded-md transition-all"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="mt-16 sm:mt-20 pt-6 border-t border-white/[0.05] text-center text-[11px] text-slate-600">
          <p>FastAPI · Next.js · Groq · Qdrant · Supabase</p>
        </footer>
      </div>

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="w-full max-w-sm bg-[#0d1224] border border-white/[0.1] rounded-2xl overflow-hidden shadow-2xl shadow-black/60">
            <div className="p-6">
              <div className="flex items-start gap-3.5 mb-4">
                <div className="flex-shrink-0 w-10 h-10 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center justify-center">
                  <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-100 mb-0.5">Delete document?</h3>
                  <p className="text-xs text-slate-400 truncate max-w-[200px]">{deleteTarget.title}</p>
                </div>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed mb-5">
                This permanently deletes the PDF, all chat history, and its vector embeddings. Cannot be undone.
              </p>
              <div className="flex gap-2.5">
                <button onClick={() => setDeleteTarget(null)} disabled={deleting}
                  className="flex-1 px-4 py-2.5 text-xs font-medium text-slate-400 border border-white/[0.08] rounded-xl hover:bg-white/[0.04] hover:text-slate-200 transition-all disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={() => confirmDelete(deleteTarget.id)} disabled={deleting}
                  className="flex-1 px-4 py-2.5 text-xs font-semibold bg-red-600/20 border border-red-500/40 text-red-300 hover:bg-red-600/30 hover:border-red-400/60 rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                  {deleting ? (
                    <><div className="w-3 h-3 rounded-full border-2 border-red-400 border-t-transparent animate-spin" />Deleting…</>
                  ) : "Delete permanently"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

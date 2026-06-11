"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type PageStatus = "idle" | "uploading" | "indexing" | "ready" | "failed";

interface ConversionResult {
  document_id: string;
  original_filename: string;
  pdf_filename: string;
  converted: boolean;
  page_count: number;
  chunk_count: number;
  download_url: string;
}

// ── icons ─────────────────────────────────────────────────────────────────────

function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

function Spinner({ className }: { className?: string }) {
  return <div className={`rounded-full border-2 border-t-transparent animate-spin ${className}`} />;
}

// ── step row ──────────────────────────────────────────────────────────────────

function StepRow({
  label,
  note,
  done,
  active,
}: {
  label: string;
  note?: string;
  done: boolean;
  active: boolean;
}) {
  return (
    <div className="flex items-center gap-3.5 py-0.5">
      <div
        className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-all
          ${done    ? "bg-emerald-500/20 border-2 border-emerald-500/50 shadow-sm shadow-emerald-500/20"
          : active  ? "bg-amber-500/20  border-2 border-amber-400/50  shadow-sm shadow-amber-500/20"
          :           "bg-white/[0.03]  border   border-white/[0.1]"}`}
      >
        {done    ? <CheckIcon className="w-3 h-3 text-emerald-400" />
        : active  ? <Spinner  className="w-3 h-3 border-amber-400" />
        :           <div className="w-1.5 h-1.5 rounded-full bg-slate-600" />}
      </div>
      <div className="flex-1 min-w-0">
        <span className={`text-sm font-medium ${done ? "text-slate-100" : active ? "text-amber-300" : "text-slate-500"}`}>
          {label}
        </span>
        {active && note && (
          <p className="text-[11px] text-slate-500 mt-0.5">{note}</p>
        )}
      </div>
      {done && (
        <span className="flex-shrink-0 text-[10px] text-emerald-400/70 font-medium">done</span>
      )}
    </div>
  );
}

// ── background ────────────────────────────────────────────────────────────────

function Background() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10">
      <div className="absolute inset-0 bg-[#0a0f1e]" />
      <div className="absolute top-0 left-0 w-[800px] h-[800px] rounded-full opacity-40 blur-[120px]"
        style={{ background: "radial-gradient(circle, #6d28d9 0%, transparent 70%)" }} />
      <div className="absolute bottom-0 right-0 w-[700px] h-[700px] rounded-full opacity-30 blur-[120px]"
        style={{ background: "radial-gradient(circle, #0891b2 0%, transparent 70%)" }} />
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full opacity-20 blur-[100px]"
        style={{ background: "radial-gradient(circle, #4f46e5 0%, transparent 70%)" }} />
    </div>
  );
}

// ── capability chip ───────────────────────────────────────────────────────────

function CapChip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[11px] text-slate-400">
      {icon}
      {label}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function ConverterPage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>("idle");
  const [result, setResult]         = useState<ConversionResult | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };
  useEffect(() => () => stopPolling(), []);

  const startPolling = (documentId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res  = await fetch(`${API}/converter/${documentId}/status`);
        const data = await res.json();
        if (data.status === "ready") {
          setPageStatus("ready");
          stopPolling();
        } else if (data.status === "index_failed" || data.status === "failed") {
          setPageStatus("failed");
          setError("Indexing failed. You can still try to chat, but results may be limited.");
          stopPolling();
        }
      } catch { /* ignore transient network hiccups */ }
    }, 2500);
  };

  const handleUpload = async (file: File) => {
    setError(null);
    setResult(null);
    setPageStatus("uploading");

    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch(`${API}/converter/upload`, { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Upload failed");
      }
      const data: ConversionResult = await res.json();
      setResult(data);
      setPageStatus("indexing");
      startPolling(data.document_id);
    } catch (err) {
      setPageStatus("failed");
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    e.target.value = "";
  };

  const reset = () => { stopPolling(); setPageStatus("idle"); setResult(null); setError(null); };

  const isConverted = result?.converted ?? false;

  const steps = [
    { label: "File uploaded",       done: !!result,              active: pageStatus === "uploading" && !result },
    ...(isConverted ? [{ label: "Converted to PDF", done: !!result, active: false }] : []),
    { label: "Parsed & chunked",    done: !!result,              active: false },
    {
      label: "Indexing embeddings", done: pageStatus === "ready", active: pageStatus === "indexing",
      note: "Generating vector embeddings — may take a minute for large documents.",
    },
  ];

  return (
    <main className="relative min-h-screen overflow-hidden text-white">
      <Background />

      <div className="relative max-w-2xl mx-auto px-6 py-16">

        {/* back link */}
        <a
          href="/"
          className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 border border-white/[0.06] hover:border-white/[0.14] px-3 py-1.5 rounded-lg transition-all mb-10"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
          Back to Library
        </a>

        {/* ── hero ─────────────────────────────────────────────────────────── */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 mb-6 bg-white/[0.04] border border-white/[0.08] rounded-full text-xs font-medium text-slate-400 backdrop-blur-sm">
            <span className="w-1.5 h-1.5 bg-violet-400 rounded-full animate-pulse" />
            Document Converter
          </div>
          <h1
            className="text-5xl font-bold mb-4 tracking-tight"
            style={{
              background: "linear-gradient(135deg, #ffffff 0%, #c4b5fd 50%, #67e8f9 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              letterSpacing: "-0.03em",
            }}
          >
            Convert &amp; Chat
          </h1>
          <p className="text-slate-400 text-sm leading-relaxed mb-6">
            Upload a Word document or PDF — convert it, download it, and chat with it using AI.
          </p>
          {/* capability chips */}
          <div className="flex flex-wrap justify-center gap-2">
            <CapChip
              icon={<svg className="w-3.5 h-3.5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>}
              label=".docx → PDF conversion"
            />
            <CapChip
              icon={<svg className="w-3.5 h-3.5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>}
              label="Download PDF"
            />
            <CapChip
              icon={<svg className="w-3.5 h-3.5 text-fuchsia-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" /></svg>}
              label="RAG-powered chat"
            />
          </div>
        </div>

        {/* ── IDLE: upload zone ─────────────────────────────────────────────── */}
        {pageStatus === "idle" && (
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-sm overflow-hidden">
            {/* zone header */}
            <div className="px-6 pt-5 pb-0 flex items-center gap-2 border-b border-white/[0.05]">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Upload Document</span>
            </div>

            {/* drag zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              className={`relative p-12 text-center transition-all cursor-pointer
                ${dragActive
                  ? "bg-violet-500/[0.08] border-dashed border-2 border-violet-400/50"
                  : "hover:bg-white/[0.02]"}`}
            >
              <input
                type="file"
                accept=".pdf,.docx"
                onChange={handleFileSelect}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <div className="pointer-events-none">
                <div className="inline-flex items-center justify-center w-16 h-16 mb-5 bg-gradient-to-br from-violet-500/20 to-cyan-500/20 border border-white/[0.1] rounded-2xl">
                  <FileIcon className="w-7 h-7 text-slate-300" />
                </div>
                <p className="text-base font-semibold text-slate-100 mb-1.5">
                  {dragActive ? "Release to upload" : "Drop a file or click to browse"}
                </p>
                <p className="text-xs text-slate-500 mb-5">Max 50 MB</p>
                {/* format tags */}
                <div className="flex justify-center gap-2.5">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-500/10 border border-violet-500/25 rounded-lg text-[11px] text-violet-300 font-medium">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                    .docx → converts &amp; chats
                  </div>
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-500/10 border border-cyan-500/25 rounded-lg text-[11px] text-cyan-300 font-medium">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                    .pdf → chats directly
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── UPLOADING skeleton ────────────────────────────────────────────── */}
        {pageStatus === "uploading" && !result && (
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-sm p-12 text-center">
            <div className="flex justify-center gap-1.5 mb-5">
              {[0, 150, 300].map((delay) => (
                <div key={delay} className="w-2.5 h-2.5 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: `${delay}ms` }} />
              ))}
            </div>
            <p className="text-sm font-medium text-slate-300 mb-1">Uploading &amp; converting…</p>
            <p className="text-xs text-slate-500">This usually takes a few seconds</p>
          </div>
        )}

        {/* ── RESULT: file card + pipeline + actions ────────────────────────── */}
        {result && pageStatus !== "idle" && (
          <div className="space-y-3">

            {/* ── File info card ── */}
            <div className="rounded-2xl border border-white/[0.09] bg-white/[0.02] backdrop-blur-sm overflow-hidden">
              <div className="px-5 py-2.5 border-b border-white/[0.05] flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Document</span>
                {pageStatus === "indexing" && (
                  <span className="flex items-center gap-1.5 px-2.5 py-0.5 text-[10px] rounded-full font-semibold uppercase tracking-wide bg-amber-500/10 text-amber-300 border border-amber-500/25">
                    <Spinner className="w-2.5 h-2.5 border-amber-400" />
                    Indexing
                  </span>
                )}
                {pageStatus === "ready" && (
                  <span className="flex items-center gap-1 px-2.5 py-0.5 text-[10px] rounded-full font-semibold uppercase tracking-wide bg-emerald-500/10 text-emerald-300 border border-emerald-500/25">
                    <CheckIcon className="w-2.5 h-2.5" />
                    Ready
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4 p-5">
                <div className="flex-shrink-0 w-11 h-11 bg-gradient-to-br from-violet-500/15 to-cyan-500/15 border border-white/[0.09] rounded-xl flex items-center justify-center">
                  <FileIcon className="w-5 h-5 text-slate-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-100 truncate">{result.original_filename}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                    {result.converted && (
                      <span className="text-[11px] text-emerald-400 font-medium">✓ Converted to PDF</span>
                    )}
                    {result.page_count != null && (
                      <span className="text-[11px] text-slate-500">{result.page_count} pages</span>
                    )}
                    {result.chunk_count != null && (
                      <span className="text-[11px] text-slate-500">{result.chunk_count} chunks</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* ── Processing pipeline card ── */}
            <div className="rounded-2xl border border-white/[0.09] bg-white/[0.02] backdrop-blur-sm overflow-hidden">
              <div className="px-5 py-2.5 border-b border-white/[0.05]">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Processing Pipeline</span>
              </div>
              <div className="p-5 space-y-3.5">
                {steps.map((step, i) => (
                  <StepRow
                    key={i}
                    label={step.label}
                    note={"note" in step ? step.note : undefined}
                    done={step.done}
                    active={step.active}
                  />
                ))}
              </div>
            </div>

            {/* ── Action buttons ── */}
            {pageStatus === "ready" && (
              <div className="rounded-2xl border border-white/[0.09] bg-white/[0.02] backdrop-blur-sm overflow-hidden">
                <div className="px-5 py-2.5 border-b border-white/[0.05]">
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Actions</span>
                </div>
                <div className={`p-4 grid gap-3 ${result.converted ? "grid-cols-2" : "grid-cols-1"}`}>
                  {result.converted && (
                    <a
                      href={result.download_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-center justify-center gap-2.5 px-5 py-3.5 bg-white/[0.03] border border-white/[0.12] hover:bg-cyan-500/[0.07] hover:border-cyan-400/30 rounded-xl text-sm font-semibold text-slate-200 hover:text-cyan-200 transition-all shadow-sm"
                    >
                      <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/[0.05] border border-white/[0.1] group-hover:border-cyan-400/20 transition-all">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                        </svg>
                      </div>
                      Download PDF
                    </a>
                  )}
                  <a
                    href={`/chat?doc=${result.document_id}`}
                    className="group flex items-center justify-center gap-2.5 px-5 py-3.5 bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 border border-violet-500/50 hover:border-violet-400/70 rounded-xl text-sm font-semibold transition-all shadow-lg shadow-violet-700/30"
                  >
                    <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/[0.12] border border-white/[0.15]">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                      </svg>
                    </div>
                    Chat with PDF →
                  </a>
                </div>
              </div>
            )}

            {/* reset / upload another */}
            {(pageStatus === "ready" || pageStatus === "failed") && (
              <button
                onClick={reset}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.16] text-sm font-medium text-slate-400 hover:text-slate-200 transition-all group"
              >
                <svg className="w-4 h-4 transition-transform group-hover:-translate-y-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
                Upload another document
              </button>
            )}
          </div>
        )}

        {/* error banner */}
        {error && (
          <div className="mt-4 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-300 text-sm backdrop-blur-sm">
            {error}
            {pageStatus === "failed" && result && (
              <a href={`/chat?doc=${result.document_id}`} className="block mt-2 text-violet-400 hover:text-violet-300 transition-colors">
                Try chatting anyway →
              </a>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

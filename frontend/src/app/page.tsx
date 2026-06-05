"use client";

import { useState, useCallback } from "react";

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

export default function Home() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadFile = async (file: File) => {
    setError(null);
    setUploading(true);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("http://localhost:8000/documents/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || "Upload failed");
      }

      const data: UploadResponse = await res.json();
      setDocuments((prev) => [data, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
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
      const res = await fetch("http://localhost:8000/documents/");
      const data = await res.json();
      setDocuments(data);
    } catch (err) {
      console.error("Failed to load documents:", err);
    }
  };

  const reprocessDocument = async (docId: string) => {
    try {
      const res = await fetch(
        `http://localhost:8000/documents/${docId}/process`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error("Reprocess failed");
      await loadDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reprocess failed");
    }
  };

  const indexDocument = async (docId: string) => {
    try {
      setError(null);
      const res = await fetch(
        `http://localhost:8000/documents/${docId}/index`,
        { method: "POST" }
      );
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || "Indexing failed");
      }
      alert("✅ Document indexed! You can now chat with it.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Index failed");
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-12 text-center">
          <h1 className="text-6xl font-bold mb-4 bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">
            Lumina
          </h1>
          <p className="text-xl text-slate-300">
            Upload a PDF to start your knowledge journey
          </p>
        </div>

        {/* Upload Zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
          className={`
            relative border-2 border-dashed rounded-2xl p-12 text-center transition-all
            ${dragActive ? "border-purple-400 bg-purple-500/10" : "border-slate-600 bg-slate-800/30"}
            ${uploading ? "opacity-50 pointer-events-none" : "hover:border-purple-500 hover:bg-slate-800/50"}
          `}
        >
          <input
            type="file"
            accept="application/pdf"
            onChange={handleFileSelect}
            disabled={uploading}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
          <div className="pointer-events-none">
            <div className="text-5xl mb-4">{uploading ? "⏳" : "📄"}</div>
            <p className="text-xl font-medium mb-2">
              {uploading
                ? "Uploading & processing..."
                : dragActive
                ? "Drop your PDF here"
                : "Drag a PDF here or click to browse"}
            </p>
            <p className="text-sm text-slate-400">Max 50 MB · PDF only</p>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300">
            ❌ {error}
          </div>
        )}

        {/* Documents List */}
        <div className="mt-12">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-semibold">Your Documents</h2>
            <button
              onClick={loadDocuments}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition-colors"
            >
              🔄 Refresh
            </button>
          </div>

          {documents.length === 0 ? (
            <p className="text-slate-400 text-center py-8">
              No documents yet. Upload one above to get started.
            </p>
          ) : (
            <div className="space-y-3">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between p-4 bg-slate-800/50 border border-slate-700 rounded-lg hover:border-purple-500/50 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div className="text-2xl">📄</div>
                    <div>
                      <p className="font-medium">{doc.title}</p>
                      <p className="text-xs text-slate-400">
                        {doc.filename}
                        {doc.page_count != null && (
                          <span className="ml-2">· {doc.page_count} pages</span>
                        )}
                        {doc.chunk_count != null && doc.chunk_count > 0 && (
                          <span className="ml-2">· {doc.chunk_count} chunks</span>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {doc.status === "ready" && (
                      <>
                        <button
                          onClick={() => indexDocument(doc.id)}
                          className="px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded-full transition-colors"
                          title="Re-index this document for chat"
                        >
                          🧠 Index
                        </button>
                        <a
                          href={`/chat?doc=${doc.id}`}
                          className="px-3 py-1 text-xs bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 rounded-full transition-colors font-medium"
                        >
                          💬 Chat
                        </a>
                      </>
                    )}
                    {(doc.status === "pending" || doc.status === "failed") && (
                      <button
                        onClick={() => reprocessDocument(doc.id)}
                        className="px-3 py-1 text-xs bg-purple-600 hover:bg-purple-500 rounded-full transition-colors"
                      >
                        Process
                      </button>
                    )}
                    <span
                      className={`px-3 py-1 text-xs rounded-full ${
                        doc.status === "ready"
                          ? "bg-green-500/20 text-green-300"
                          : doc.status === "processing"
                          ? "bg-yellow-500/20 text-yellow-300"
                          : doc.status === "failed"
                          ? "bg-red-500/20 text-red-300"
                          : "bg-slate-500/20 text-slate-300"
                      }`}
                    >
                      {doc.status === "ready" ? "✓ ready" : doc.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
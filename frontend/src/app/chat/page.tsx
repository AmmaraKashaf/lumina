"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

interface Document {
  id: string;
  title: string;
  status: string;
}

interface Source {
  page: number | null;
  content: string;
  score: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
}

export default function ChatPage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    fetch("http://localhost:8000/documents/")
      .then((res) => res.json())
      .then((data: Document[]) => {
        const ready = data.filter((d) => d.status === "ready");
        setDocuments(ready);
        if (ready.length > 0) setSelectedDocId(ready[0].id);
      })
      .catch((err) => setError("Failed to load documents: " + err.message));
  }, []);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    if (!selectedDocId) {
      setError("Please select a document first");
      return;
    }
    const question = input.trim();
    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);
    try {
      const res = await fetch("http://localhost:8000/chat/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, document_id: selectedDocId, top_k: 5 }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || "Chat failed");
      }
      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: data.answer, sources: data.sources }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat failed");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white flex flex-col">
      <header className="border-b border-slate-700/50 sticky top-0 z-10 bg-slate-900/80 backdrop-blur-md">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-2xl font-bold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">
            Lumina
          </Link>
          <select
            value={selectedDocId}
            onChange={(e) => setSelectedDocId(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-purple-500"
          >
            {documents.length === 0 ? (
              <option value="">No ready documents</option>
            ) : (
              documents.map((doc) => (
                <option key={doc.id} value={doc.id}>{doc.title}</option>
              ))
            )}
          </select>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-8">
          {messages.length === 0 && (
            <div className="text-center py-20">
              <div className="text-6xl mb-4">Chat</div>
              <h2 className="text-2xl font-semibold mb-2">Ask anything about your document</h2>
              <p className="text-slate-400">Lumina will answer using the content of your selected PDF.</p>
            </div>
          )}

          <div className="space-y-6">
            {messages.map((msg, msgIdx) => (
              <div key={msgIdx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className="max-w-2xl">
                  <div className={`rounded-2xl px-5 py-3 ${msg.role === "user" ? "bg-purple-600 text-white" : "bg-slate-800/70 border border-slate-700 text-slate-100"}`}>
                    <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                  </div>
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {msg.sources.map((src, srcIdx) => (
                        <span key={srcIdx} className="text-xs px-3 py-1 bg-slate-700/50 border border-slate-600 rounded-full">
                          Page {src.page ?? "?"} - {(src.score * 100).toFixed(0)}%
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-slate-800/70 border border-slate-700 rounded-2xl px-5 py-3">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce"></span>
                    <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce"></span>
                    <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce"></span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>

      {error && (
        <div className="max-w-4xl mx-auto w-full px-6 mb-2">
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300 text-sm">{error}</div>
        </div>
      )}

      <div className="border-t border-slate-700/50 sticky bottom-0 bg-slate-900/80 backdrop-blur-md">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex gap-3 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything about your document..."
              rows={1}
              disabled={loading || !selectedDocId}
              className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 resize-none focus:outline-none focus:border-purple-500 disabled:opacity-50 max-h-32"
            />
            <button
              onClick={sendMessage}
              disabled={loading || !input.trim() || !selectedDocId}
              className="px-5 py-3 bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {loading ? "..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

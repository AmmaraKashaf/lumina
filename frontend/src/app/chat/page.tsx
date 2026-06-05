"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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
  id?: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
}

interface Conversation {
  id: string;
  document_id: string;
  title: string | null;
  created_at: string;
  message_count: number;
}

const API = "http://localhost:8000";

export default function ChatPage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string>("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openSource, setOpenSource] = useState<{ msgIdx: number; srcIdx: number } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  // Load ready documents
  useEffect(() => {
    fetch(`${API}/documents/`)
      .then((res) => res.json())
      .then((data: Document[]) => {
        const ready = data.filter((d) => d.status === "ready");
        setDocuments(ready);
        if (ready.length > 0 && !selectedDocId) setSelectedDocId(ready[0].id);
      })
      .catch((err) => setError("Failed to load documents: " + err.message));
  }, []);

  // Load conversations whenever doc changes
  const loadConversations = useCallback(async (docId: string) => {
    if (!docId) return;
    try {
      const res = await fetch(`${API}/conversations/?document_id=${docId}`);
      const data: Conversation[] = await res.json();
      setConversations(data);
    } catch (err) {
      console.error("Failed to load conversations:", err);
    }
  }, []);

  useEffect(() => {
    if (selectedDocId) loadConversations(selectedDocId);
  }, [selectedDocId, loadConversations]);

  // Load messages for active conversation
  useEffect(() => {
    if (!activeConvId) {
      setMessages([]);
      return;
    }
    fetch(`${API}/conversations/${activeConvId}`)
      .then((res) => res.json())
      .then((data) => setMessages(data.messages || []))
      .catch((err) => setError("Failed to load messages: " + err.message));
  }, [activeConvId]);

  // ─── New conversation ─────────────────────────────────────────
  const newConversation = () => {
    setActiveConvId(null);
    setMessages([]);
    setOpenSource(null);
    setError(null);
  };

  // ─── Send message with streaming ──────────────────────────────
  const sendMessage = async () => {
    if (!input.trim() || streaming) return;
    if (!selectedDocId) {
      setError("Please select a document first");
      return;
    }

    const question = input.trim();
    setInput("");
    setError(null);

    // Ensure a conversation exists
    let convId = activeConvId;
    if (!convId) {
      try {
        const res = await fetch(`${API}/conversations/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document_id: selectedDocId }),
        });
        const conv: Conversation = await res.json();
        convId = conv.id;
        setActiveConvId(convId);
      } catch (err) {
        setError("Failed to create conversation");
        return;
      }
    }

    // Optimistically add user message + empty assistant placeholder
    setMessages((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "", sources: [] },
    ]);
    setStreaming(true);
    setLoading(true);

    try {
      const res = await fetch(`${API}/conversations/${convId}/messages/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: question, top_k: 5 }),
      });

      if (!res.ok || !res.body) {
        throw new Error("Stream failed to start");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE: events separated by "\n\n"
        const events = buffer.split("\n\n");
        buffer = events.pop() || ""; // keep incomplete event in buffer

        for (const eventBlock of events) {
          if (!eventBlock.startsWith("data: ")) continue;
          const jsonStr = eventBlock.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === "sources") {
              setLoading(false);
              setMessages((prev) => {
                const updated = [...prev];
                const lastIdx = updated.length - 1;
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  sources: event.data,
                };
                return updated;
              });
            } else if (event.type === "token") {
              setMessages((prev) => {
                const updated = [...prev];
                const lastIdx = updated.length - 1;
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  content: updated[lastIdx].content + event.data,
                };
                return updated;
              });
            } else if (event.type === "error") {
              throw new Error(event.data);
            }
          } catch (parseErr) {
            console.error("Failed to parse SSE event:", parseErr);
          }
        }
      }

      // Refresh conversation list (titles update after first message)
      if (selectedDocId) loadConversations(selectedDocId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat failed");
    } finally {
      setStreaming(false);
      setLoading(false);
    }
  };

  // ─── Delete conversation ──────────────────────────────────────
  const deleteConversation = async (convId: string) => {
    if (!confirm("Delete this conversation?")) return;
    try {
      await fetch(`${API}/conversations/${convId}`, { method: "DELETE" });
      if (activeConvId === convId) newConversation();
      if (selectedDocId) loadConversations(selectedDocId);
    } catch (err) {
      setError("Failed to delete");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white flex">
      {/* ─── Sidebar ──────────────────────────────────────── */}
      <aside className="w-72 border-r border-slate-700/50 bg-slate-900/50 backdrop-blur-md flex flex-col h-screen sticky top-0">
        <div className="p-4 border-b border-slate-700/50">
          <Link
            href="/"
            className="text-xl font-bold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent"
          >
            ← Lumina
          </Link>
        </div>

        <div className="p-4">
          <select
            value={selectedDocId}
            onChange={(e) => {
              setSelectedDocId(e.target.value);
              newConversation();
            }}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
          >
            {documents.length === 0 ? (
              <option value="">No ready documents</option>
            ) : (
              documents.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  {doc.title}
                </option>
              ))
            )}
          </select>

          <button
            onClick={newConversation}
            className="mt-3 w-full px-3 py-2 text-sm bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 rounded-lg font-medium transition-all"
          >
            + New chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-4">
          <p className="px-2 text-xs uppercase tracking-wider text-slate-500 mb-2">
            History
          </p>
          {conversations.length === 0 ? (
            <p className="px-2 text-xs text-slate-500">No chats yet</p>
          ) : (
            <div className="space-y-1">
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  className={`group flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                    activeConvId === conv.id
                      ? "bg-purple-500/20 border border-purple-500/30"
                      : "hover:bg-slate-800/50"
                  }`}
                  onClick={() => setActiveConvId(conv.id)}
                >
                  <p className="text-sm truncate flex-1">
                    {conv.title || "Untitled chat"}
                  </p>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(conv.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-400 ml-2 transition-opacity"
                    title="Delete"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ─── Main chat ────────────────────────────────────── */}
      <div className="flex-1 flex flex-col h-screen">
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-8">
            {messages.length === 0 && (
              <div className="text-center py-20">
                <div className="text-6xl mb-4">💬</div>
                <h2 className="text-2xl font-semibold mb-2">
                  Ask anything about your document
                </h2>
                <p className="text-slate-400">
                  Lumina remembers context — follow-up questions work.
                </p>
              </div>
            )}

            <div className="space-y-6">
              {messages.map((msg, msgIdx) => (
                <div
                  key={msgIdx}
                  className={`flex ${
                    msg.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div className="max-w-2xl">
                    <div
                      className={`rounded-2xl px-5 py-3 ${
                        msg.role === "user"
                          ? "bg-purple-600 text-white"
                          : "bg-slate-800/70 border border-slate-700 text-slate-100"
                      }`}
                    >
                      {msg.content === "" && msg.role === "assistant" && loading ? (
                        <div className="flex gap-1 py-1">
                          <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" />
                          <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                          <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap leading-relaxed">
                          {msg.content}
                          {streaming && msgIdx === messages.length - 1 && msg.role === "assistant" && (
                            <span className="inline-block w-2 h-4 ml-0.5 bg-purple-400 animate-pulse" />
                          )}
                        </p>
                      )}
                    </div>

                    {msg.sources && msg.sources.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {msg.sources.map((src, srcIdx) => (
                          <button
                            key={srcIdx}
                            onClick={() =>
                              setOpenSource(
                                openSource?.msgIdx === msgIdx &&
                                  openSource?.srcIdx === srcIdx
                                  ? null
                                  : { msgIdx, srcIdx }
                              )
                            }
                            className="text-xs px-3 py-1 bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded-full transition-colors"
                          >
                            Page {src.page ?? "?"} · {(src.score * 100).toFixed(0)}%
                          </button>
                        ))}
                      </div>
                    )}

                    {openSource?.msgIdx === msgIdx && msg.sources && (
                      <div className="mt-3 p-4 bg-slate-900/80 border border-purple-500/30 rounded-lg text-sm text-slate-300">
                        <p className="text-xs text-purple-400 mb-2 font-mono">
                          SOURCE · Page {msg.sources[openSource.srcIdx].page}
                        </p>
                        <p className="whitespace-pre-wrap leading-relaxed text-slate-300">
                          {msg.sources[openSource.srcIdx].content}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              <div ref={messagesEndRef} />
            </div>
          </div>
        </div>

        {error && (
          <div className="max-w-3xl mx-auto w-full px-6 mb-2">
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300 text-sm">
              {error}
            </div>
          </div>
        )}

        <div className="border-t border-slate-700/50 bg-slate-900/80 backdrop-blur-md">
          <div className="max-w-3xl mx-auto px-6 py-4">
            <div className="flex gap-3 items-end">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything about your document..."
                rows={1}
                disabled={streaming || !selectedDocId}
                className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 resize-none focus:outline-none focus:border-purple-500 disabled:opacity-50 max-h-32"
              />
              <button
                onClick={sendMessage}
                disabled={streaming || !input.trim() || !selectedDocId}
                className="px-5 py-3 bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {streaming ? "..." : "Send"}
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-2 text-center">
              Press Enter to send · Shift+Enter for new line
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
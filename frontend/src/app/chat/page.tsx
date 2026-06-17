"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

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

export default function ChatPage() {
  const [documents, setDocuments]     = useState<Document[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string>("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId]   = useState<string | null>(null);
  const [messages, setMessages]       = useState<Message[]>([]);
  const [input, setInput]             = useState("");
  const [loading, setLoading]         = useState(false);
  const [streaming, setStreaming]     = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [openSource, setOpenSource]   = useState<{ msgIdx: number; srcIdx: number } | null>(null);
  const [listening, setListening]     = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [speaking, setSpeaking]       = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const recognitionRef    = useRef<any>(null);
  const selectedDocIdRef  = useRef<string>(selectedDocId);
  const activeConvIdRef   = useRef<string | null>(activeConvId);
  const inputRef          = useRef<string>(input);
  const streamingRef      = useRef<boolean>(streaming);
  const assistantMessageIndexRef = useRef<number | null>(null);
  const finalTranscriptRef = useRef<string>("");
  const messagesEndRef    = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isVoiceInputRef   = useRef<boolean>(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { setVoiceSupported(false); return; }

    setVoiceSupported(true);
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onresult = (event: any) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0]?.transcript || "";
        if (event.results[i].isFinal) final += t;
        else interim += t;
      }
      if (final) { finalTranscriptRef.current = final; setInput(final); }
      else setInput(interim);
    };

    recognition.onend = () => {
      setListening(false);
      const t = finalTranscriptRef.current.trim() || inputRef.current.trim();
      if (t) void sendMessage(t, true);
      finalTranscriptRef.current = "";
    };

    recognition.onerror = (event: any) => {
      setError("Voice recognition error: " + (event.error || "unknown"));
      setListening(false);
    };

    recognitionRef.current = recognition;
    return () => recognition.stop?.();
  }, []);

  const speakText = useCallback((text: string) => {
    if (!("speechSynthesis" in window) || !text.trim()) return;
    const speech = new SpeechSynthesisUtterance(text);
    speech.lang = "en-US";
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find((v) => v.lang.startsWith("en"));
    if (voice) speech.voice = voice;
    speech.onstart = () => setSpeaking(true);
    speech.onend = () => setSpeaking(false);
    speech.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(speech);
  }, []);

  useEffect(() => {
    apiFetch("/documents/")
      .then((res) => res.json())
      .then((data: Document[]) => {
        const ready = data.filter((d) => d.status === "ready");
        setDocuments(ready);

        // Auto-select doc from URL param
        const params = new URLSearchParams(window.location.search);
        const docParam = params.get("doc");
        if (docParam && ready.find((d) => d.id === docParam)) {
          setSelectedDocId(docParam);
        } else if (ready.length > 0 && !selectedDocId) {
          setSelectedDocId(ready[0].id);
        }
      })
      .catch((err) => setError("Failed to load documents: " + err.message));
  }, []);

  const loadConversations = useCallback(async (docId: string) => {
    if (!docId) return;
    try {
      const res = await apiFetch(`/conversations/?document_id=${docId}`);
      const data: Conversation[] = await res.json();
      setConversations(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { selectedDocIdRef.current = selectedDocId; }, [selectedDocId]);
  useEffect(() => { activeConvIdRef.current = activeConvId; }, [activeConvId]);
  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => { streamingRef.current = streaming; }, [streaming]);
  useEffect(() => { if (selectedDocId) loadConversations(selectedDocId); }, [selectedDocId, loadConversations]);

  useEffect(() => {
    if (!activeConvId) { setMessages([]); return; }
    if (streamingRef.current) return;
    apiFetch(`/conversations/${activeConvId}`)
      .then((res) => res.json())
      .then((data) => setMessages(data.messages || []))
      .catch((err) => setError("Failed to load messages: " + err.message));
  }, [activeConvId]);

  const stopAssistant = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    window.speechSynthesis.cancel();
    setStreaming(false);
    setLoading(false);
    setSpeaking(false);
  };

  const newConversation = () => {
    setActiveConvId(null);
    setMessages([]);
    setOpenSource(null);
    setError(null);
    assistantMessageIndexRef.current = null;
    setSidebarOpen(false);
  };

  const sendMessage = async (messageOverride?: string, isVoice = false) => {
    const question = messageOverride?.trim() || inputRef.current.trim();
    if (!question || streamingRef.current) return;
    const docId = selectedDocIdRef.current || selectedDocId;
    if (!docId) { setError("Please select a document first"); return; }

    isVoiceInputRef.current = isVoice;
    setInput("");
    setError(null);

    let convId = activeConvIdRef.current || activeConvId;
    if (!convId) {
      try {
        const res = await apiFetch("/conversations/", {
          method: "POST",
          body: JSON.stringify({ document_id: docId }),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => null);
          throw new Error(errData?.detail || "Failed to create conversation");
        }
        const conv: Conversation = await res.json();
        convId = conv.id;
        setActiveConvId(convId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create conversation");
        return;
      }
    }

    setMessages((prev) => {
      const updated: Message[] = [
        ...prev,
        { role: "user", content: question },
        { role: "assistant", content: "", sources: [] },
      ];
      assistantMessageIndexRef.current = updated.length - 1;
      return updated;
    });
    setStreaming(true);
    setLoading(true);

    try {
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const res = await apiFetch(`/conversations/${convId}/messages/stream`, {
        method: "POST",
        body: JSON.stringify({ content: question, top_k: 10 }),
        signal: abortController.signal,
      });

      if (!res.ok || !res.body) throw new Error("Stream failed to start");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const block of events) {
          if (!block.startsWith("data: ")) continue;
          const jsonStr = block.slice(6).trim();
          if (!jsonStr) continue;
          try {
            const event = JSON.parse(jsonStr);
            if (event.type === "sources") {
              setLoading(false);
              setMessages((prev) => {
                const updated = [...prev];
                const idx = assistantMessageIndexRef.current ?? updated.length - 1;
                if (updated[idx]) updated[idx] = { ...updated[idx], sources: event.data };
                return updated;
              });
            } else if (event.type === "token") {
              assistantText += event.data;
              setMessages((prev) => {
                const updated = [...prev];
                const idx = assistantMessageIndexRef.current ?? updated.length - 1;
                if (updated[idx]) updated[idx] = { ...updated[idx], content: updated[idx].content + event.data };
                return updated;
              });
            } else if (event.type === "error") {
              throw new Error(event.data);
            }
          } catch (err) {
            if (!(err instanceof SyntaxError)) throw err;
          }
        }
      }

      if (assistantText.trim() && isVoiceInputRef.current) speakText(assistantText);
      if (selectedDocId) loadConversations(selectedDocId);
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") setError(err.message);
    } finally {
      abortControllerRef.current = null;
      setStreaming(false);
      setLoading(false);
    }
  };

  const toggleListening = () => {
    if (!voiceSupported || streaming || !selectedDocId) return;
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (listening) { recognition.stop(); setListening(false); return; }
    finalTranscriptRef.current = "";
    setListening(true);
    try { recognition.start(); }
    catch { setError("Failed to start voice input"); setListening(false); }
  };

  const deleteConversation = async (convId: string) => {
    if (!confirm("Delete this conversation?")) return;
    try {
      await apiFetch(`/conversations/${convId}`, { method: "DELETE" });
      if (activeConvId === convId) newConversation();
      if (selectedDocId) loadConversations(selectedDocId);
    } catch { setError("Failed to delete"); }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const Sidebar = () => (
    <aside className={`
      fixed inset-y-0 left-0 z-50 w-72
      border-r border-slate-700/50 bg-slate-900/98 backdrop-blur-md
      flex flex-col h-screen transition-transform duration-300
      ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
      md:sticky md:top-0 md:translate-x-0 md:z-auto md:bg-slate-900/50
    `}>
      {/* Sidebar header */}
      <div className="p-4 border-b border-slate-700/50 flex items-center justify-between">
        <Link href="/"
          className="text-xl font-bold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">
          ← Lumina
        </Link>
        <button
          onClick={() => setSidebarOpen(false)}
          className="md:hidden p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-700/50 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Document selector */}
      <div className="p-4">
        <select
          value={selectedDocId}
          onChange={(e) => { setSelectedDocId(e.target.value); newConversation(); }}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
        >
          {documents.length === 0 ? (
            <option value="">No ready documents</option>
          ) : (
            documents.map((doc) => (
              <option key={doc.id} value={doc.id}>{doc.title}</option>
            ))
          )}
        </select>

        <button
          onClick={newConversation}
          className="mt-3 w-full px-3 py-2.5 text-sm bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 rounded-lg font-medium transition-all"
        >
          + New chat
        </button>
      </div>

      {/* Conversation history */}
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <p className="px-2 text-xs uppercase tracking-wider text-slate-500 mb-2">History</p>
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
                onClick={() => { setActiveConvId(conv.id); setSidebarOpen(false); }}
              >
                <p className="text-sm truncate flex-1">{conv.title || "Untitled chat"}</p>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                  className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-400 ml-2 transition-opacity p-0.5"
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
  );

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white flex">

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar />

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-h-screen min-w-0">

        {/* Mobile top bar */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-slate-700/50 bg-slate-900/80 backdrop-blur-md sticky top-0 z-20">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-700/50 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
          <span className="text-sm font-semibold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">
            {documents.find((d) => d.id === selectedDocId)?.title || "Lumina Chat"}
          </span>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
            {messages.length === 0 && (
              <div className="text-center py-16 sm:py-20">
                <div className="text-5xl sm:text-6xl mb-4">💬</div>
                <h2 className="text-xl sm:text-2xl font-semibold mb-2">
                  Ask anything about your document
                </h2>
                <p className="text-slate-400 text-sm sm:text-base">
                  Lumina remembers context — follow-up questions work.
                </p>
              </div>
            )}

            <div className="space-y-4 sm:space-y-6">
              {messages.map((msg, msgIdx) =>
                msg && msg.role != null ? (
                  <div key={msgIdx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className="max-w-[85%] sm:max-w-2xl">
                      <div className={`rounded-2xl px-4 py-3 sm:px-5 ${
                        msg.role === "user"
                          ? "bg-purple-600 text-white"
                          : "bg-slate-800/70 border border-slate-700 text-slate-100"
                      }`}>
                        {msg.content === "" && msg.role === "assistant" && (loading || streaming) ? (
                          <div className="flex gap-1 py-1">
                            <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" />
                            <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                            <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap leading-relaxed text-sm sm:text-base">
                            {msg.content}
                            {streaming && msgIdx === messages.length - 1 && msg.role === "assistant" && (
                              <span className="inline-block w-2 h-4 ml-0.5 bg-purple-400 animate-pulse" />
                            )}
                          </p>
                        )}
                      </div>

                      {msg.sources && msg.sources.length > 0 && (
                        <div className="mt-2 sm:mt-3 flex flex-wrap gap-1.5 sm:gap-2">
                          {msg.sources.map((src, srcIdx) => (
                            <button
                              key={srcIdx}
                              onClick={() =>
                                setOpenSource(
                                  openSource?.msgIdx === msgIdx && openSource?.srcIdx === srcIdx
                                    ? null
                                    : { msgIdx, srcIdx }
                                )
                              }
                              className="text-xs px-2.5 py-1 bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded-full transition-colors"
                            >
                              Page {src.page ?? "?"} · {(src.score * 100).toFixed(0)}%
                            </button>
                          ))}
                        </div>
                      )}

                      {openSource?.msgIdx === msgIdx && msg.sources && (
                        <div className="mt-2 sm:mt-3 p-3 sm:p-4 bg-slate-900/80 border border-purple-500/30 rounded-lg text-sm text-slate-300">
                          <p className="text-xs text-purple-400 mb-2 font-mono">
                            SOURCE · Page {msg.sources[openSource.srcIdx].page}
                          </p>
                          <p className="whitespace-pre-wrap leading-relaxed text-slate-300 text-xs sm:text-sm">
                            {msg.sources[openSource.srcIdx].content}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 mb-2">
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300 text-sm">
              {error}
            </div>
          </div>
        )}

        {/* Input area */}
        <div className="border-t border-slate-700/50 bg-slate-900/80 backdrop-blur-md">
          <div className="max-w-3xl mx-auto px-3 sm:px-6 py-3 sm:py-4">
            <div className="flex gap-2 sm:gap-3 items-end">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything about your document…"
                rows={1}
                disabled={streaming || !selectedDocId}
                style={{ fontSize: "16px" }}
                className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 sm:px-4 sm:py-3 resize-none focus:outline-none focus:border-purple-500 disabled:opacity-50 max-h-32"
              />

              {voiceSupported && (
                <button
                  type="button"
                  onClick={toggleListening}
                  disabled={streaming || !selectedDocId}
                  title={listening ? "Stop listening" : "Voice input"}
                  className={`flex-shrink-0 w-11 h-11 flex items-center justify-center rounded-xl border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    listening
                      ? "bg-red-900/50 border-red-500/50 hover:bg-red-900"
                      : "bg-slate-800 border-slate-700 hover:bg-slate-700"
                  }`}
                >
                  {listening ? (
                    <span className="text-red-300 text-xs font-bold">●</span>
                  ) : (
                    <svg className="w-4 h-4 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                    </svg>
                  )}
                </button>
              )}

              {(streaming || speaking) && (
                <button
                  type="button"
                  onClick={stopAssistant}
                  className="flex-shrink-0 w-11 h-11 flex items-center justify-center bg-red-900/50 border border-red-500/50 hover:bg-red-900 hover:border-red-500 rounded-xl text-red-300 transition-colors"
                  title="Stop"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                </button>
              )}

              <button
                onClick={() => void sendMessage()}
                disabled={streaming || !input.trim() || !selectedDocId}
                className="flex-shrink-0 w-11 h-11 sm:w-auto sm:h-auto sm:px-5 sm:py-3 flex items-center justify-center bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {streaming ? (
                  <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                ) : (
                  <>
                    <svg className="w-4 h-4 sm:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                    </svg>
                    <span className="hidden sm:inline">Send</span>
                  </>
                )}
              </button>
            </div>

            <p className="text-[11px] text-slate-600 mt-2 text-center hidden sm:block">
              Enter to send · Shift+Enter for new line
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

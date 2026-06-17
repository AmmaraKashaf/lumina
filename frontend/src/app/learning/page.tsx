"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

interface Document {
  id: string;
  title: string;
  status: string;
}

interface QuizQuestion {
  question: string;
  options: string[];
  correct_index: number;
  explanation?: string;
  page?: number;
}

interface Flashcard {
  front: string;
  back: string;
  page?: number;
}

type Tab = "summary" | "quiz" | "flashcards";
type SummaryStyle = "tldr" | "executive" | "detailed" | "eli5";

const STYLE_LABELS: Record<SummaryStyle, { label: string; desc: string }> = {
  tldr:      { label: "TL;DR",     desc: "2-3 sentences" },
  executive: { label: "Executive", desc: "Bullet points" },
  detailed:  { label: "Detailed",  desc: "Full breakdown" },
  eli5:      { label: "ELI5",      desc: "Like I'm 5" },
};

function Bounce() {
  return (
    <div className="inline-flex gap-1">
      <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" />
      <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
      <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
    </div>
  );
}

export default function LearningPage() {
  const [documents, setDocuments]       = useState<Document[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string>("");
  const [tab, setTab]                   = useState<Tab>("summary");

  const [summaryStyle, setSummaryStyle] = useState<SummaryStyle>("tldr");
  const [summary, setSummary]           = useState<string>("");
  const [summaryLoading, setSummaryLoading] = useState(false);

  const [quiz, setQuiz]                 = useState<QuizQuestion[]>([]);
  const [quizLoading, setQuizLoading]   = useState(false);
  const [answers, setAnswers]           = useState<Record<number, number>>({});
  const [showResults, setShowResults]   = useState(false);

  const [flashcards, setFlashcards]     = useState<Flashcard[]>([]);
  const [flashLoading, setFlashLoading] = useState(false);
  const [cardIdx, setCardIdx]           = useState(0);
  const [flipped, setFlipped]           = useState(false);

  const [error, setError] = useState<string | null>(null);

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
        } else if (ready.length > 0) {
          setSelectedDocId(ready[0].id);
        }
      })
      .catch((err) => setError("Failed to load documents: " + err.message));
  }, []);

  useEffect(() => {
    setSummary("");
    setQuiz([]);
    setFlashcards([]);
    setAnswers({});
    setShowResults(false);
    setCardIdx(0);
    setFlipped(false);
  }, [selectedDocId]);

  const fetchSummary = async (style: SummaryStyle) => {
    if (!selectedDocId) return;
    setSummaryStyle(style);
    setSummaryLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/learning/summary", {
        method: "POST",
        body: JSON.stringify({ document_id: selectedDocId, style }),
      });
      if (!res.ok) throw new Error((await res.json()).detail);
      const data = await res.json();
      setSummary(data.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Summary failed");
    } finally {
      setSummaryLoading(false);
    }
  };

  const fetchQuiz = async () => {
    if (!selectedDocId) return;
    setQuizLoading(true);
    setError(null);
    setAnswers({});
    setShowResults(false);
    try {
      const res = await apiFetch("/learning/quiz", {
        method: "POST",
        body: JSON.stringify({ document_id: selectedDocId, num_questions: 5 }),
      });
      if (!res.ok) throw new Error((await res.json()).detail);
      const data = await res.json();
      setQuiz(data.questions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Quiz failed");
    } finally {
      setQuizLoading(false);
    }
  };

  const fetchFlashcards = async () => {
    if (!selectedDocId) return;
    setFlashLoading(true);
    setError(null);
    setCardIdx(0);
    setFlipped(false);
    try {
      const res = await apiFetch("/learning/flashcards", {
        method: "POST",
        body: JSON.stringify({ document_id: selectedDocId, num_cards: 10 }),
      });
      if (!res.ok) throw new Error((await res.json()).detail);
      const data = await res.json();
      setFlashcards(data.flashcards);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Flashcards failed");
    } finally {
      setFlashLoading(false);
    }
  };

  const selectAnswer = (qIdx: number, optIdx: number) => {
    if (showResults) return;
    setAnswers((prev) => ({ ...prev, [qIdx]: optIdx }));
  };

  const correctCount = quiz.filter((q, i) => answers[i] === q.correct_index).length;

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white">

      {/* Header */}
      <header className="border-b border-slate-700/50 bg-slate-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
          <Link
            href="/"
            className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent flex-shrink-0"
          >
            ← Lumina
          </Link>
          <select
            value={selectedDocId}
            onChange={(e) => setSelectedDocId(e.target.value)}
            className="flex-1 min-w-0 max-w-xs bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
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

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">

        {/* Page title */}
        <div className="mb-5 sm:mb-6">
          <h1 className="text-2xl sm:text-4xl font-bold mb-1 sm:mb-2">Learning Mode</h1>
          <p className="text-slate-400 text-sm">Summaries, quizzes, and flashcards from your PDF</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 sm:gap-2 mb-6 sm:mb-8 border-b border-slate-700/50 overflow-x-auto">
          {[
            { id: "summary" as Tab, icon: "📝", label: "Summary" },
            { id: "quiz" as Tab, icon: "🎯", label: "Quiz" },
            { id: "flashcards" as Tab, icon: "🃏", label: "Flashcards" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-3 font-medium transition-colors border-b-2 whitespace-nowrap text-sm sm:text-base ${
                tab === t.id
                  ? "border-purple-500 text-white"
                  : "border-transparent text-slate-400 hover:text-white"
              }`}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* ─── Summary Tab ─────────────────────────────────── */}
        {tab === "summary" && (
          <div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mb-6">
              {(Object.keys(STYLE_LABELS) as SummaryStyle[]).map((style) => (
                <button
                  key={style}
                  onClick={() => fetchSummary(style)}
                  disabled={summaryLoading || !selectedDocId}
                  className={`p-3 sm:p-4 rounded-xl border transition-all text-left disabled:opacity-50 ${
                    summary && summaryStyle === style
                      ? "bg-purple-500/20 border-purple-500"
                      : "bg-slate-800/50 border-slate-700 hover:border-purple-500/50"
                  }`}
                >
                  <p className="font-medium text-sm sm:text-base">{STYLE_LABELS[style].label}</p>
                  <p className="text-xs text-slate-400">{STYLE_LABELS[style].desc}</p>
                </button>
              ))}
            </div>

            {summaryLoading && (
              <div className="text-center py-10 text-slate-400">
                <Bounce />
                <p className="mt-3 text-sm">Generating {STYLE_LABELS[summaryStyle].label} summary…</p>
              </div>
            )}

            {summary && !summaryLoading && (
              <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 sm:p-6">
                <p className="text-xs uppercase tracking-wider text-purple-400 mb-3">
                  {STYLE_LABELS[summaryStyle].label} Summary
                </p>
                <div className="whitespace-pre-wrap leading-relaxed text-slate-100 text-sm sm:text-base">
                  {summary}
                </div>
              </div>
            )}

            {!summary && !summaryLoading && (
              <div className="text-center py-10 text-slate-500 text-sm">
                Pick a summary style above to get started
              </div>
            )}
          </div>
        )}

        {/* ─── Quiz Tab ─────────────────────────────────────── */}
        {tab === "quiz" && (
          <div>
            {quiz.length === 0 && !quizLoading && (
              <div className="text-center py-10 sm:py-12">
                <p className="text-slate-400 mb-6 text-sm">Test your knowledge with auto-generated questions.</p>
                <button
                  onClick={fetchQuiz}
                  disabled={!selectedDocId}
                  className="px-6 py-3 bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 rounded-xl font-medium disabled:opacity-50 text-sm sm:text-base"
                >
                  Generate Quiz
                </button>
              </div>
            )}

            {quizLoading && (
              <div className="text-center py-10 text-slate-400">
                <Bounce />
                <p className="mt-3 text-sm">Crafting questions…</p>
              </div>
            )}

            {quiz.length > 0 && !quizLoading && (
              <div className="space-y-4 sm:space-y-6">
                {quiz.map((q, qIdx) => {
                  const userAns = answers[qIdx];
                  return (
                    <div key={qIdx} className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 sm:p-6">
                      <div className="flex items-start justify-between gap-4 mb-4">
                        <p className="font-medium text-base sm:text-lg">
                          <span className="text-purple-400">Q{qIdx + 1}.</span> {q.question}
                        </p>
                        {q.page && <span className="text-xs text-slate-500 whitespace-nowrap">p.{q.page}</span>}
                      </div>
                      <div className="space-y-2">
                        {q.options.map((opt, optIdx) => {
                          const selected = userAns === optIdx;
                          const correct = q.correct_index === optIdx;
                          let cls = "border-slate-600 hover:border-purple-500/50";
                          if (showResults) {
                            if (correct) cls = "border-green-500/60 bg-green-500/10";
                            else if (selected && !correct) cls = "border-red-500/60 bg-red-500/10";
                            else cls = "border-slate-700 opacity-60";
                          } else if (selected) {
                            cls = "border-purple-500 bg-purple-500/10";
                          }
                          return (
                            <button
                              key={optIdx}
                              onClick={() => selectAnswer(qIdx, optIdx)}
                              disabled={showResults}
                              className={`w-full text-left p-3 rounded-lg border transition-colors text-sm sm:text-base ${cls}`}
                            >
                              <span className="font-mono text-xs text-slate-500 mr-2">
                                {String.fromCharCode(65 + optIdx)}.
                              </span>
                              {opt}
                              {showResults && correct && <span className="ml-2 text-green-400">✓</span>}
                              {showResults && selected && !correct && <span className="ml-2 text-red-400">✗</span>}
                            </button>
                          );
                        })}
                      </div>
                      {showResults && q.explanation && (
                        <div className="mt-3 sm:mt-4 p-3 bg-slate-900/60 border border-slate-700 rounded-lg text-sm text-slate-300">
                          <span className="text-purple-400 font-medium">Explanation: </span>
                          {q.explanation}
                        </div>
                      )}
                    </div>
                  );
                })}

                {!showResults && (
                  <button
                    onClick={() => setShowResults(true)}
                    disabled={Object.keys(answers).length < quiz.length}
                    className="w-full py-3 bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 rounded-xl font-medium disabled:opacity-50 text-sm sm:text-base"
                  >
                    Submit Quiz ({Object.keys(answers).length}/{quiz.length} answered)
                  </button>
                )}

                {showResults && (
                  <div className="bg-gradient-to-r from-purple-500/20 to-cyan-500/20 border border-purple-500/30 rounded-xl p-5 sm:p-6 text-center">
                    <p className="text-3xl font-bold mb-2">{correctCount} / {quiz.length}</p>
                    <p className="text-slate-300 text-sm sm:text-base">
                      {correctCount === quiz.length ? "Perfect score! 🎉"
                        : correctCount >= quiz.length * 0.7 ? "Great job! 👏"
                        : "Keep studying! 💪"}
                    </p>
                    <button onClick={fetchQuiz}
                      className="mt-4 px-5 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm">
                      Try a new quiz
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ─── Flashcards Tab ──────────────────────────────── */}
        {tab === "flashcards" && (
          <div>
            {flashcards.length === 0 && !flashLoading && (
              <div className="text-center py-10 sm:py-12">
                <p className="text-slate-400 mb-6 text-sm">Study with auto-generated flashcards.</p>
                <button
                  onClick={fetchFlashcards}
                  disabled={!selectedDocId}
                  className="px-6 py-3 bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 rounded-xl font-medium disabled:opacity-50 text-sm sm:text-base"
                >
                  Generate Flashcards
                </button>
              </div>
            )}

            {flashLoading && (
              <div className="text-center py-10 text-slate-400">
                <Bounce />
                <p className="mt-3 text-sm">Creating flashcards…</p>
              </div>
            )}

            {flashcards.length > 0 && !flashLoading && (
              <div className="max-w-2xl mx-auto">
                <div className="text-center mb-3 sm:mb-4 text-sm text-slate-400">
                  Card {cardIdx + 1} of {flashcards.length}
                </div>

                {/* Flip card */}
                <div
                  onClick={() => setFlipped((f) => !f)}
                  className="relative w-full cursor-pointer select-none"
                  style={{ perspective: "1000px", height: "clamp(200px, 40vw, 288px)" }}
                >
                  <div
                    className="absolute inset-0 transition-transform duration-500"
                    style={{ transformStyle: "preserve-3d", transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)" }}
                  >
                    <div
                      className="absolute inset-0 bg-slate-800/70 border border-slate-700 rounded-2xl p-6 sm:p-8 flex flex-col items-center justify-center text-center"
                      style={{ backfaceVisibility: "hidden" }}
                    >
                      <p className="text-xs uppercase tracking-wider text-purple-400 mb-3">Question</p>
                      <p className="text-lg sm:text-xl font-medium">{flashcards[cardIdx].front}</p>
                      <p className="mt-4 sm:mt-6 text-xs text-slate-500">Tap to flip</p>
                    </div>
                    <div
                      className="absolute inset-0 bg-gradient-to-br from-purple-900/40 to-cyan-900/40 border border-purple-500/30 rounded-2xl p-6 sm:p-8 flex flex-col items-center justify-center text-center"
                      style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
                    >
                      <p className="text-xs uppercase tracking-wider text-cyan-400 mb-3">Answer</p>
                      <p className="text-base sm:text-lg leading-relaxed">{flashcards[cardIdx].back}</p>
                      {flashcards[cardIdx].page && (
                        <p className="mt-3 sm:mt-4 text-xs text-slate-500">Page {flashcards[cardIdx].page}</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Navigation */}
                <div className="mt-5 sm:mt-6 flex items-center justify-between">
                  <button
                    onClick={() => { setFlipped(false); setCardIdx((i) => Math.max(i - 1, 0)); }}
                    disabled={cardIdx === 0}
                    className="px-4 sm:px-5 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg disabled:opacity-30 text-sm sm:text-base"
                  >
                    ← Prev
                  </button>
                  <button onClick={fetchFlashcards}
                    className="px-4 py-2 text-sm bg-slate-700/50 hover:bg-slate-700 rounded-lg">
                    🔄 New deck
                  </button>
                  <button
                    onClick={() => { setFlipped(false); setCardIdx((i) => Math.min(i + 1, flashcards.length - 1)); }}
                    disabled={cardIdx === flashcards.length - 1}
                    className="px-4 sm:px-5 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg disabled:opacity-30 text-sm sm:text-base"
                  >
                    Next →
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

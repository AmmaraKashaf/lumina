"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeMouseHandler,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { apiFetch } from "@/lib/api";

interface Document {
  id: string;
  title: string;
  status: string;
}

interface MindMapNode {
  id: string;
  label: string;
  description: string;
  page: number;
  level: number;
}

interface MindMapEdge {
  source: string;
  target: string;
}

interface MindMapData {
  title: string;
  nodes: MindMapNode[];
  edges: MindMapEdge[];
}

interface MindMapResponse {
  id: string;
  document_id: string;
  title: string;
  data: MindMapData;
  cached: boolean;
  created_at: string;
}

const LEVEL_COLORS: Record<number, { bg: string; border: string; text: string }> = {
  0: { bg: "rgb(168 85 247 / 0.25)", border: "rgb(168 85 247)", text: "#fff" },
  1: { bg: "rgb(6 182 212 / 0.2)",   border: "rgb(6 182 212)",  text: "#fff" },
  2: { bg: "rgb(30 41 59 / 0.7)",    border: "rgb(100 116 139)", text: "#e2e8f0" },
};

function layoutMindMap(data: MindMapData): { nodes: Node[]; edges: Edge[] } {
  const childrenOf: Record<string, string[]> = {};
  data.edges.forEach((e) => {
    if (!childrenOf[e.source]) childrenOf[e.source] = [];
    childrenOf[e.source].push(e.target);
  });

  const positions: Record<string, { x: number; y: number }> = {};
  const root = data.nodes.find((n) => n.level === 0);
  if (!root) return { nodes: [], edges: [] };

  positions[root.id] = { x: 0, y: 0 };
  const level1 = childrenOf[root.id] || [];
  const radius1 = 400;
  level1.forEach((id, i) => {
    const angle = (i / level1.length) * 2 * Math.PI - Math.PI / 2;
    positions[id] = { x: Math.cos(angle) * radius1, y: Math.sin(angle) * radius1 };
  });

  level1.forEach((parentId) => {
    const parentPos = positions[parentId];
    const children = childrenOf[parentId] || [];
    if (!children.length) return;
    const dx = parentPos.x, dy = parentPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const radius2 = 220, spreadAngle = Math.PI / 2.5;
    children.forEach((id, i) => {
      const offset = children.length === 1 ? 0 : (i / (children.length - 1) - 0.5) * spreadAngle;
      const angle = Math.atan2(uy, ux) + offset;
      positions[id] = {
        x: parentPos.x + Math.cos(angle) * radius2,
        y: parentPos.y + Math.sin(angle) * radius2,
      };
    });
  });

  const nodes: Node[] = data.nodes.map((n) => {
    const colors = LEVEL_COLORS[Math.min(n.level, 2)];
    const pos = positions[n.id] || { x: 0, y: 0 };
    const fontSize = n.level === 0 ? 18 : n.level === 1 ? 14 : 12;
    const width = n.level === 0 ? 220 : n.level === 1 ? 180 : 160;
    return {
      id: n.id,
      position: pos,
      data: { label: n.label, description: n.description, page: n.page, level: n.level },
      style: {
        background: colors.bg,
        border: `2px solid ${colors.border}`,
        borderRadius: n.level === 0 ? 12 : 8,
        color: colors.text,
        fontSize,
        fontWeight: n.level <= 1 ? 600 : 500,
        padding: n.level === 0 ? 16 : 10,
        width,
        textAlign: "center" as const,
        boxShadow: n.level === 0 ? "0 0 24px rgb(168 85 247 / 0.4)" : "none",
      },
    };
  });

  const edges: Edge[] = data.edges.map((e, i) => ({
    id: `e-${i}`,
    source: e.source,
    target: e.target,
    animated: false,
    style: { stroke: "rgb(100 116 139)", strokeWidth: 1.5 },
  }));

  return { nodes, edges };
}

function MindMapInner() {
  const [documents, setDocuments]     = useState<Document[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string>("");
  const [mindmap, setMindmap]         = useState<MindMapData | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [cached, setCached]           = useState(false);
  const [selectedNode, setSelectedNode] = useState<MindMapNode | null>(null);
  const [panelOpen, setPanelOpen]     = useState(false);

  useEffect(() => {
    apiFetch("/documents/")
      .then((res) => res.json())
      .then((data: Document[]) => {
        const ready = data.filter((d) => d.status === "ready");
        setDocuments(ready);

        const params = new URLSearchParams(window.location.search);
        const docParam = params.get("doc");
        if (docParam && ready.find((d) => d.id === docParam)) {
          setSelectedDocId(docParam);
        } else if (ready.length > 0) {
          setSelectedDocId(ready[0].id);
        }
      })
      .catch((err) => setError(err.message));
  }, []);

  const fetchMindmap = useCallback(async (docId: string, regenerate = false) => {
    if (!docId) return;
    setLoading(true);
    setError(null);
    setSelectedNode(null);
    setPanelOpen(false);
    try {
      const res = await apiFetch(`/mindmaps/${docId}?regenerate=${regenerate}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Failed");
      }
      const result: MindMapResponse = await res.json();
      setMindmap(result.data);
      setCached(result.cached);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load mind map");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedDocId) fetchMindmap(selectedDocId, false);
  }, [selectedDocId, fetchMindmap]);

  const { nodes, edges } = useMemo(
    () => (mindmap ? layoutMindMap(mindmap) : { nodes: [], edges: [] }),
    [mindmap]
  );

  const onNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    setSelectedNode({
      id: node.id,
      label: node.data.label as string,
      description: (node.data.description as string) || "",
      page: (node.data.page as number) || 0,
      level: (node.data.level as number) || 0,
    });
    setPanelOpen(true);
  }, []);

  const NodeDetail = () =>
    selectedNode ? (
      <>
        <div className="flex items-center gap-2 mb-3">
          <span className={`text-xs uppercase tracking-wider font-mono px-2 py-0.5 rounded ${
            selectedNode.level === 0 ? "bg-purple-500/30 text-purple-200"
            : selectedNode.level === 1 ? "bg-cyan-500/30 text-cyan-200"
            : "bg-slate-700 text-slate-300"
          }`}>
            Level {selectedNode.level}
          </span>
          <span className="text-xs text-slate-500">Page {selectedNode.page}</span>
        </div>
        <h3 className="text-lg sm:text-xl font-semibold mb-3">{selectedNode.label}</h3>
        <p className="text-sm text-slate-300 leading-relaxed">{selectedNode.description}</p>
        <button
          onClick={() => { setSelectedNode(null); setPanelOpen(false); }}
          className="mt-4 px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 rounded-lg"
        >
          Close
        </button>
      </>
    ) : (
      <div className="text-center text-slate-500 my-auto">
        <div className="text-3xl sm:text-4xl mb-3">🕸️</div>
        <p className="text-sm">Click any node to see details</p>
        <p className="text-xs mt-3 text-slate-600">Scroll to zoom · drag to pan</p>
      </div>
    );

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white flex flex-col">

      {/* Header */}
      <header className="border-b border-slate-700/50 bg-slate-900/50 backdrop-blur-md z-10 flex-shrink-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-3 flex-wrap">
          <Link
            href="/"
            className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent"
          >
            Lumina
          </Link>
          <div className="flex items-center gap-2 sm:gap-3">
            <select
              value={selectedDocId}
              onChange={(e) => setSelectedDocId(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500 max-w-[160px] sm:max-w-none"
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
              onClick={() => fetchMindmap(selectedDocId, true)}
              disabled={loading || !selectedDocId}
              className="px-3 py-2 text-sm bg-slate-700 hover:bg-slate-600 rounded-lg disabled:opacity-50 whitespace-nowrap"
            >
              Regenerate
            </button>
          </div>
        </div>
      </header>

      {/* Sub-header */}
      <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold mb-0.5">Mind Map</h1>
          <p className="text-xs sm:text-sm text-slate-400">
            {mindmap?.title || "Visualizing concepts and relationships"}
            {cached && (
              <span className="ml-2 text-xs px-2 py-0.5 bg-slate-700/50 rounded-full">cached</span>
            )}
          </p>
        </div>
      </div>

      {error && (
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 mb-2 flex-shrink-0">
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        </div>
      )}

      {/* Canvas + detail panel */}
      <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 pb-4 sm:pb-6 flex flex-col md:flex-row gap-3 sm:gap-4 min-h-0">

        {/* Map canvas */}
        <div className="flex-1 bg-slate-900/40 border border-slate-700 rounded-2xl overflow-hidden relative"
          style={{ minHeight: "340px" }}>
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/80 backdrop-blur-sm">
              <div className="text-center">
                <div className="inline-flex gap-1 mb-3">
                  <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" />
                  <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
                <p className="text-slate-300 text-sm">Generating mind map…</p>
                <p className="text-xs text-slate-500 mt-1">~5-8 seconds</p>
              </div>
            </div>
          )}
          {nodes.length > 0 && (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodeClick={onNodeClick}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              proOptions={{ hideAttribution: true }}
              minZoom={0.2}
              maxZoom={2}
              colorMode="dark"
            >
              <Background color="#475569" gap={20} />
              <Controls className="!bg-slate-800 !border-slate-700" />
              <MiniMap
                nodeColor={(n) => {
                  const lvl = (n.data?.level as number) ?? 2;
                  return lvl === 0 ? "rgb(168 85 247)" : lvl === 1 ? "rgb(6 182 212)" : "rgb(100 116 139)";
                }}
                maskColor="rgb(15 23 42 / 0.6)"
                className="!bg-slate-800 !border-slate-700 hidden sm:block"
              />
            </ReactFlow>
          )}
        </div>

        {/* Desktop detail panel (always visible md+) */}
        <aside className="hidden md:flex w-80 bg-slate-900/40 border border-slate-700 rounded-2xl p-5 flex-col">
          <NodeDetail />
        </aside>

        {/* Mobile detail panel (slide-up sheet) */}
        {panelOpen && selectedNode && (
          <div className="md:hidden fixed inset-x-0 bottom-0 z-50 bg-slate-900 border-t border-slate-700 rounded-t-2xl p-5 max-h-[60vh] overflow-y-auto">
            <NodeDetail />
          </div>
        )}
      </div>
    </main>
  );
}

export default function MindMapPage() {
  return (
    <ReactFlowProvider>
      <MindMapInner />
    </ReactFlowProvider>
  );
}

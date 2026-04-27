/**
 * KnowledgePanel — browse, search, filter, edit the knowledge graph.
 * Glass sidebar on the BLOB canvas.
 */
import { useState, useEffect, useMemo } from "react";
import type { KnowledgeEntry } from "../../types/blob";
import styles from "./Blob.module.css";

// ─── Tag inference from concept name ───────────────────────────────────────

const TAG_RULES: Array<{ tag: string; color: string; keywords: string[] }> = [
  { tag: "Architecture", color: "var(--icon-blue, #0a84ff)", keywords: ["architecture", "microservice", "monolith", "serverless", "design pattern", "hexagonal", "cqrs", "event-driven"] },
  { tag: "Database", color: "var(--icon-purple, #bf5af2)", keywords: ["database", "sql", "postgres", "mongo", "redis", "cache", "storage", "query"] },
  { tag: "API", color: "var(--icon-green, #30d158)", keywords: ["api", "rest", "graphql", "endpoint", "http", "grpc", "webhook"] },
  { tag: "Security", color: "var(--icon-red, #ff375f)", keywords: ["security", "auth", "jwt", "oauth", "encryption", "compliance", "gdpr", "vulnerability"] },
  { tag: "Frontend", color: "var(--icon-cyan, #64d2ff)", keywords: ["frontend", "react", "ui", "ux", "css", "component", "responsive", "mobile"] },
  { tag: "DevOps", color: "var(--icon-orange, #ff9f0a)", keywords: ["devops", "ci/cd", "docker", "kubernetes", "deploy", "pipeline", "monitoring", "infrastructure"] },
  { tag: "Data", color: "var(--c-warning, #ffd60a)", keywords: ["data", "analytics", "ml", "ai", "model", "training", "prediction", "etl"] },
  { tag: "Business", color: "var(--m-accent, #0a84ff)", keywords: ["business", "payment", "pricing", "revenue", "user", "customer", "market", "growth"] },
];

function inferTag(concept: string, facts: string[]): { tag: string; color: string } | null {
  const text = `${concept} ${facts.join(" ")}`.toLowerCase();
  for (const rule of TAG_RULES) {
    if (rule.keywords.some((kw) => text.includes(kw))) return { tag: rule.tag, color: rule.color };
  }
  return null;
}

// ─── Component ─────────────────────────────────────────────────────────────

interface KnowledgePanelProps {
  onClose: () => void;
}

export function KnowledgePanel({ onClose }: KnowledgePanelProps) {
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFacts, setEditFacts] = useState("");
  const [allKnowledge, setAllKnowledge] = useState<KnowledgeEntry[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [linkSourceId, setLinkSourceId] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);

  // Load from backend (single source of truth)
  const loadKnowledge = () => {
    fetch("/knowledge")
      .then((r) => r.ok ? r.json() : [])
      .then((data) => { if (Array.isArray(data)) setAllKnowledge(data); })
      .catch(() => {});
  };

  const handleLink = async (id1: string, id2: string) => {
    if (id1 === id2) { setLinkSourceId(null); return; }
    setLinkBusy(true);
    try {
      await fetch("/knowledge/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id1, id2 }),
      });
      setLinkSourceId(null);
      // Reload to get the new related concepts
      loadKnowledge();
    } finally {
      setLinkBusy(false);
    }
  };

  useEffect(() => { loadKnowledge(); }, []);

  // Compute tags
  const taggedKnowledge = useMemo(() => {
    return allKnowledge.map((k) => ({
      ...k,
      inferredTag: inferTag(k.concept, k.facts),
    }));
  }, [allKnowledge]);

  // Count by tag
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const k of taggedKnowledge) {
      const tag = k.inferredTag?.tag ?? "Other";
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return counts;
  }, [taggedKnowledge]);

  // Filter
  const filtered = useMemo(() => {
    let list = taggedKnowledge;

    if (activeTag) {
      list = list.filter((k) => (k.inferredTag?.tag ?? "Other") === activeTag);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((k) =>
        k.concept.toLowerCase().includes(q) ||
        k.facts.some((f) => f.toLowerCase().includes(q)) ||
        k.relatedConcepts.some((rc) => rc.toLowerCase().includes(q))
      );
    }

    return list.sort((a, b) => b.accessCount - a.accessCount);
  }, [taggedKnowledge, search, activeTag]);

  // Total facts
  const totalFacts = allKnowledge.reduce((s, k) => s + k.facts.length, 0);

  const handleSaveFacts = async (id: string) => {
    const facts = editFacts.split("\n").map((f) => f.trim()).filter(Boolean);
    await fetch(`/knowledge/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facts }),
    }).catch(() => {});
    setEditingId(null);
    loadKnowledge();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this knowledge entry?")) return;
    await fetch(`/knowledge/${id}`, { method: "DELETE" }).catch(() => {});
    setAllKnowledge((prev) => prev.filter((k) => k.id !== id));
  };

  return (
    <div className={styles.knowledgePanel}>
      {/* Header */}
      <div className={styles.gitHeader}>
        <div className={styles.gitTitle}>
          Knowledge
          <span className={styles.gitStats}>
            {allKnowledge.length} concepts · {totalFacts} facts
          </span>
        </div>
        <button className={styles.gitCloseBtn} onClick={onClose}>{"\u2715"}</button>
      </div>

      {/* Search */}
      <div style={{ padding: "8px 12px 4px" }}>
        <input
          className={styles.kpSearch}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search concepts, facts..."
        />
      </div>

      {/* Link mode hint */}
      {linkSourceId && (
        <div style={{
          margin: "4px 12px",
          padding: "4px 8px",
          fontSize: 10,
          background: "rgba(var(--m-accent-rgb), 0.1)",
          border: "1px dashed var(--m-accent)",
          borderRadius: 4,
          color: "var(--m-accent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}>
          <span>
            Linking from <strong>{allKnowledge.find(x => x.id === linkSourceId)?.concept ?? "?"}</strong> — click another concept name
          </span>
          <button className={styles.kpBtn} onClick={() => setLinkSourceId(null)}>Cancel</button>
        </div>
      )}

      {/* Tag filters */}
      <div className={styles.gitToolbar} style={{ paddingTop: 4, paddingBottom: 4 }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <button
            className={`${styles.gitFilterBtn} ${!activeTag ? styles.gitFilterBtnActive : ""}`}
            onClick={() => setActiveTag(null)}
            style={{ fontSize: 9 }}
          >
            All ({allKnowledge.length})
          </button>
          {[...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => {
            const rule = TAG_RULES.find((r) => r.tag === tag);
            return (
              <button
                key={tag}
                className={`${styles.gitFilterBtn} ${activeTag === tag ? styles.gitFilterBtnActive : ""}`}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                style={{ fontSize: 9, borderColor: activeTag === tag ? rule?.color : undefined }}
              >
                {tag} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* List */}
      <div className={styles.kpList}>
        {filtered.length === 0 && (
          <div className={styles.kpEmpty}>
            {search ? `No matches for "${search}"` : "Knowledge will accumulate as the BLOB grows"}
          </div>
        )}

        {filtered.map((k) => (
          <div key={k.id} className={styles.kpEntry}>
            <div className={styles.kpEntryHeader}>
              {k.inferredTag && (
                <span style={{
                  fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
                  background: `color-mix(in srgb, ${k.inferredTag.color} 15%, transparent)`,
                  color: k.inferredTag.color, letterSpacing: 0.3, flexShrink: 0,
                }}>
                  {k.inferredTag.tag.toUpperCase()}
                </span>
              )}
              <span
                className={styles.kpConcept}
                style={linkSourceId === k.id
                  ? { background: "rgba(var(--m-accent-rgb), 0.18)", padding: "1px 4px", borderRadius: 3 }
                  : linkSourceId
                    ? { cursor: "pointer", textDecoration: "underline dotted" }
                    : undefined}
                onClick={() => {
                  if (linkSourceId && linkSourceId !== k.id) {
                    void handleLink(linkSourceId, k.id);
                  }
                }}
                title={linkSourceId
                  ? (linkSourceId === k.id ? "Click another concept to link" : "Click to link to " + (allKnowledge.find(x => x.id === linkSourceId)?.concept ?? "source"))
                  : k.concept}
              >{k.concept}</span>
              <span className={styles.kpAccessCount}>{k.facts.length}f · {k.accessCount}x</span>
              <button
                className={styles.kpBtn}
                disabled={linkBusy}
                title={linkSourceId === k.id ? "Cancel link mode" : "Start link from this concept"}
                onClick={() => setLinkSourceId(linkSourceId === k.id ? null : k.id)}
                style={linkSourceId === k.id ? { borderColor: "var(--m-accent)", color: "var(--m-accent)" } : undefined}
              >{"\u29C9"}</button>
              <button className={styles.kpBtn} onClick={() => {
                setEditingId(editingId === k.id ? null : k.id);
                setEditFacts(k.facts.join("\n"));
              }}>{editingId === k.id ? "\u2713" : "\u270E"}</button>
              <button className={`${styles.kpBtn} ${styles.kpBtnDanger}`} onClick={() => handleDelete(k.id)}>{"\u2716"}</button>
            </div>

            {editingId === k.id ? (
              <div className={styles.kpEditArea}>
                <textarea
                  className={styles.kpTextarea}
                  value={editFacts}
                  onChange={(e) => setEditFacts(e.target.value)}
                  rows={4}
                  placeholder="One fact per line"
                />
                <div className={styles.kpEditActions}>
                  <button className={styles.kpBtn} onClick={() => setEditingId(null)}>Cancel</button>
                  <button className={`${styles.kpBtn} ${styles.kpBtnPrimary}`} onClick={() => handleSaveFacts(k.id)}>Save</button>
                </div>
              </div>
            ) : (
              <>
                <ul className={styles.kpFacts}>
                  {k.facts.slice(0, 3).map((f, i) => (
                    <li key={i} className={styles.kpFact}>{f}</li>
                  ))}
                  {k.facts.length > 3 && <li className={styles.kpFact} style={{ opacity: 0.5 }}>+{k.facts.length - 3} more</li>}
                </ul>
                {k.relatedConcepts.length > 0 && (
                  <div className={styles.kpRelated}>
                    {k.relatedConcepts.slice(0, 5).map((rc) => (
                      <span key={rc} className={styles.kpRelatedPill} onClick={() => setSearch(rc)}>{rc}</span>
                    ))}
                    {k.relatedConcepts.length > 5 && <span className={styles.kpRelatedPill} style={{ opacity: 0.5 }}>+{k.relatedConcepts.length - 5}</span>}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

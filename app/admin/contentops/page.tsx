"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LoadingOverlay } from "@/components/contentops/loading-overlay";

type IncomingFile = {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string | null;
};

type RecentPost = {
  id: string;
  slug: string;
  machineFamily: string;
  machineModel: string | null;
  topic: string;
  status: string;
  badge: string;
};

function extLabel(name: string): string {
  const parts = name.split(".");
  if (parts.length < 2) return "FILE";
  return parts.at(-1)?.slice(0, 6).toUpperCase() || "FILE";
}

export default function ContentOpsInboxPage() {
  const [files, setFiles] = useState<IncomingFile[] | null>(null);
  const [recentPosts, setRecentPosts] = useState<RecentPost[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (mode: "initial" | "refresh" = "initial") => {
    if (mode === "refresh") setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const [incomingRes, postsRes] = await Promise.all([
        fetch("/api/contentops/incoming", { credentials: "include" }),
        fetch("/api/contentops/posts/recent", { credentials: "include" }),
      ]);

      const incomingData = await incomingRes.json();
      if (!incomingRes.ok) {
        setError((incomingData as { error?: string }).error ?? "Failed to load");
        setFiles([]);
      } else {
        setFiles((incomingData as { files: IncomingFile[] }).files ?? []);
      }

      if (postsRes.ok) {
        const postData = (await postsRes.json()) as { posts?: RecentPost[] };
        setRecentPosts(postData.posts ?? []);
      }
    } catch {
      setError("Network error");
      setFiles([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load("initial");
  }, [load]);

  return (
    <main className="co-stack" style={{ padding: "1.25rem", position: "relative" }}>
      <LoadingOverlay open={refreshing} text="Loading..." fullscreen />

      <div className="co-row" style={{ justifyContent: "space-between", width: "100%" }}>
        <h1 style={{ margin: 0 }}>Incoming (Google Drive)</h1>
        <button type="button" className="co-btn" onClick={() => void load("refresh")} disabled={loading || refreshing}>
          Refresh
        </button>
      </div>
      <p className="co-muted">
        Files listed here are already in Drive ? nothing is uploaded through Vercel. Select them when creating a{" "}
        <Link href="/admin/contentops/new">new post</Link>.
      </p>
      <p className="co-row" style={{ gap: "1rem", flexWrap: "wrap", margin: 0 }}>
        <Link href="/admin/contentops/upload">Upload batch</Link>
        <Link href="/admin/contentops/batches">View batches</Link>
      </p>

      {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}

      <section className="co-panel co-stack">
        <h2 style={{ marginTop: 0 }}>Recent Posts</h2>
        {recentPosts.length === 0 ? <p className="co-muted">No posts yet.</p> : null}
        {recentPosts.map((p) => (
          <div
            key={p.id}
            className="co-row"
            style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: "0.6rem" }}
          >
            <div>
              <Link href={`/admin/contentops/${p.id}`}>{p.slug}</Link>
              <div className="co-muted">
                {p.machineFamily}
                {p.machineModel ? ` / ${p.machineModel}` : ""} ・ {p.topic}
              </div>
            </div>
            <span className={`co-badge ${p.badge === "Fully posted" ? "ok" : p.badge === "Posted" ? "warn" : "info"}`}>
              {p.badge}
            </span>
          </div>
        ))}
      </section>

      {loading ? (
        <section className="co-panel co-stack" style={{ minHeight: 220, justifyContent: "center", position: "relative" }}>
          <LoadingOverlay open text="Loading incoming files..." />
          <div className="co-grid" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="co-thumb co-skeleton" />
            ))}
          </div>
        </section>
      ) : null}

      {!loading && files && files.length === 0 ? <p className="co-muted">No files in the incoming folder.</p> : null}

      {!loading ? (
        <div className="co-grid">
          {(files ?? []).map((f) => (
            <div key={f.id} className="co-thumb">
              {f.mimeType.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/contentops/drive/file?id=${encodeURIComponent(f.id)}`} alt={f.name} />
              ) : (
                <div className="co-file-placeholder">{extLabel(f.name)}</div>
              )}
              <div style={{ padding: "0.35rem 0.5rem", fontSize: "0.8rem" }}>
                <div style={{ wordBreak: "break-word" }}>{f.name}</div>
                {f.webViewLink ? (
                  <a href={f.webViewLink} target="_blank" rel="noreferrer">
                    Open in Drive
                  </a>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </main>
  );
}

"use client";

import { LoadingOverlay } from "@/components/contentops/loading-overlay";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type BatchRow = {
  id: string;
  batchCode: string;
  uploadedAt: string;
  uploadedBy: string | null;
  machineFamily: string;
  machineModel: string;
  topic: string;
  location: string;
  fileCount: number;
  reviewStatus: string;
  metadataSource: string;
  driveFolderUrl: string | null;
  notes: string | null;
};

export default function ContentOpsBatchesPage() {
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/contentops/upload-batches/recent", { credentials: "include" });
      const data = await res.json();
      if (!res.ok) {
        setError((data as { error?: string }).error ?? "Failed to load batches");
        setBatches([]);
        return;
      }
      setBatches((data as { batches?: BatchRow[] }).batches ?? []);
    } catch {
      setError("Network error");
      setBatches([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="co-stack" style={{ padding: "1rem", maxWidth: 720, margin: "0 auto" }}>
      <LoadingOverlay open={loading} text="Loading batches…" fullscreen={false} />
      <div className="co-row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
        <h1 style={{ margin: 0, fontSize: "clamp(1.25rem, 4vw, 1.5rem)" }}>Upload batches</h1>
        <Link href="/admin/contentops/upload" className="co-nav-btn" style={{ textDecoration: "none", display: "inline-block" }}>
          New upload
        </Link>
      </div>
      <p className="co-muted">
        <Link href="/admin/contentops">← Inbox</Link>
      </p>
      {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}
      <div className="co-stack" style={{ gap: "1rem" }}>
        {batches.map((b) => (
          <article key={b.id} className="co-panel co-stack" style={{ padding: "1rem", gap: "0.5rem" }}>
            <div className="co-row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
              <strong style={{ fontSize: "1.05rem" }}>{b.batchCode}</strong>
              <span className="co-muted" style={{ fontSize: "0.85rem" }}>
                {new Date(b.uploadedAt).toLocaleString()}
              </span>
            </div>
            <div style={{ fontSize: "0.9rem", lineHeight: 1.5 }}>
              <div>
                <span className="co-muted">By</span> {b.uploadedBy ?? "—"}
              </div>
              <div>
                <span className="co-muted">Machine</span> {b.machineFamily} / {b.machineModel}
              </div>
              <div>
                <span className="co-muted">Topic</span> {b.topic}
              </div>
              <div>
                <span className="co-muted">Location</span> {b.location}
              </div>
              <div>
                <span className="co-muted">Files</span> {b.fileCount}
              </div>
              <div>
                <span className="co-muted">Review</span> {b.reviewStatus}{" "}
                <span className="co-muted">·</span> <span className="co-muted">Source</span> {b.metadataSource}
              </div>
              {b.driveFolderUrl ? (
                <div style={{ marginTop: "0.25rem" }}>
                  <a href={b.driveFolderUrl} target="_blank" rel="noreferrer">
                    Open Drive folder
                  </a>
                </div>
              ) : null}
              {b.notes ? (
                <p className="co-muted" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
                  {b.notes}
                </p>
              ) : null}
            </div>
          </article>
        ))}
        {!loading && batches.length === 0 && !error ? <p className="co-muted">No batches yet.</p> : null}
      </div>
    </div>
  );
}

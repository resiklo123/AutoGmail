"use client";

import { CopyButton } from "@/components/contentops/copy-button";
import { LoadingOverlay } from "@/components/contentops/loading-overlay";
import { PLATFORM_OPTIONS } from "@/lib/contentops-constants";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

type Draft = {
  id: string;
  platform: string;
  title: string | null;
  caption: string | null;
  hashtags: string | null;
  description: string | null;
};

type Asset = {
  id: string;
  driveFileId: string;
  originalName: string;
  finalName: string;
  mimeType: string;
  webViewLink: string | null;
};

type PostDetail = {
  id: string;
  slug: string;
  machineFamily: string;
  machineModel: string | null;
  topic: string;
  location: string | null;
  platforms: string[];
  status: string;
  createdAt: string;
  libraryFolderUrl?: string | null;
  byDateShortcutUrl?: string | null;
  byMachineShortcutUrl?: string | null;
  assets: Asset[];
  drafts: Draft[];
};

type PostingLogEntry = {
  postedUrl?: string | null;
  postedAt?: string | null;
  postedBy?: string | null;
  notes?: string | null;
  updatedAt?: string | null;
};

type SaveStatusResponse = {
  ok?: boolean;
  sheetSyncFailed?: boolean;
  error?: string;
};

type SavePostingLogResponse = {
  entries?: Record<string, PostingLogEntry>;
  sheetSyncFailed?: boolean;
  error?: string;
};

type PostingLogUrlIssue = { platform: string; field: string; message: string };

/** Client-side convenience: prepend https:// when no scheme (does not validate). */
function normalizePostedUrlForDisplay(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

function normalizeAllLogEntryUrls(entries: Record<string, PostingLogEntry>): Record<string, PostingLogEntry> {
  const next: Record<string, PostingLogEntry> = { ...entries };
  for (const p of PLATFORM_OPTIONS) {
    const url = next[p.id]?.postedUrl;
    if (url == null || typeof url !== "string") continue;
    const normalized = normalizePostedUrlForDisplay(url);
    next[p.id] = { ...next[p.id], postedUrl: normalized || null };
  }
  return next;
}

function extLabel(name: string): string {
  const parts = name.split(".");
  if (parts.length < 2) return "FILE";
  return parts.at(-1)?.slice(0, 6).toUpperCase() || "FILE";
}

export default function ContentOpsPostDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const postId = params.postId as string;
  const [post, setPost] = useState<PostDetail | null>(null);
  const [logEntries, setLogEntries] = useState<Record<string, PostingLogEntry>>({});
  const [error, setError] = useState<string | null>(null);
  const [postingLogError, setPostingLogError] = useState<string | null>(null);
  const [sheetSyncWarning, setSheetSyncWarning] = useState(false);
  const [statusChoice, setStatusChoice] = useState<string>("DRAFT");
  const [busy, setBusy] = useState(false);
  const [savingLog, setSavingLog] = useState(false);

  const load = useCallback(async () => {
    try {
      const [postRes, logRes] = await Promise.all([
        fetch(`/api/contentops/posts/${postId}`, { credentials: "include" }),
        fetch(`/api/contentops/posts/${postId}/posting-log`, { credentials: "include" }),
      ]);

      const postData = await postRes.json();
      if (!postRes.ok) {
        setError((postData as { error?: string }).error ?? "Failed to load");
        setPost(null);
        return;
      }

      const p = postData as PostDetail;
      setPost(p);
      setStatusChoice(p.status === "DRAFT_READY" ? "DRAFT" : p.status);

      if (logRes.ok) {
        const payload = (await logRes.json()) as { entries?: Record<string, PostingLogEntry> };
        setLogEntries(payload.entries ?? {});
      }
    } catch {
      setError("Network error");
    }
  }, [postId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (searchParams.get("sheetSyncFailed") === "1") {
      setSheetSyncWarning(true);
    }
  }, [searchParams]);

  const selectedPlatformIds = useMemo(() => (post?.platforms ?? []).map((p) => p.toUpperCase()), [post?.platforms]);
  const requiredPlatforms = PLATFORM_OPTIONS.filter((p) => selectedPlatformIds.includes(p.id));
  const postedCount = requiredPlatforms.filter((p) => !!logEntries[p.id]?.postedUrl?.trim()).length;

  const postingBadge =
    requiredPlatforms.length > 0 && postedCount === requiredPlatforms.length
      ? "Fully posted"
      : postedCount > 0
        ? "Posted"
        : "Draft ready";

  if (!post && !error) {
    return (
      <main style={{ padding: "1.25rem" }}>
        <p>Loading...</p>
      </main>
    );
  }

  if (error || !post) {
    return (
      <main style={{ padding: "1.25rem" }} className="co-stack">
        <p style={{ color: "var(--danger)" }}>{error}</p>
        <Link href="/admin/contentops">Back</Link>
      </main>
    );
  }

  return (
    <main className="co-stack" style={{ padding: "1.25rem", position: "relative" }}>
      <LoadingOverlay open={savingLog} text="Saving posting log..." fullscreen />

      <div className="co-row" style={{ justifyContent: "space-between", width: "100%" }}>
        <h1 style={{ margin: 0 }}>Post {post.slug}</h1>
        <Link href="/admin/contentops">Inbox</Link>
      </div>
      <p className="co-muted">
        {post.machineFamily}
        {post.machineModel ? ` / ${post.machineModel}` : ""}
        {` / ${post.topic}`}
        {post.location ? ` ? ${post.location}` : ""}
      </p>
      <p>
        Status: <strong>{post.status}</strong> ・ <strong>{postingBadge}</strong>
      </p>
      {sheetSyncWarning ? <p style={{ color: "var(--danger)", fontWeight: 600 }}>Saved in DB, Sheet sync failed</p> : null}
      {(post.libraryFolderUrl?.trim() || post.byDateShortcutUrl?.trim() || post.byMachineShortcutUrl?.trim()) ? (
        <p className="co-row" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
          {post.libraryFolderUrl?.trim() ? (
            <a href={post.libraryFolderUrl.trim()} target="_blank" rel="noreferrer">
              Library folder
            </a>
          ) : null}
          {post.byDateShortcutUrl?.trim() ? (
            <a href={post.byDateShortcutUrl.trim()} target="_blank" rel="noreferrer">
              By date folder
            </a>
          ) : null}
          {post.byMachineShortcutUrl?.trim() ? (
            <a href={post.byMachineShortcutUrl.trim()} target="_blank" rel="noreferrer">
              By machine folder
            </a>
          ) : null}
        </p>
      ) : null}

      <section className="co-panel co-stack">
        <h2 style={{ marginTop: 0 }}>Update status</h2>
        <div className="co-row">
          <select className="co-select" value={statusChoice} onChange={(e) => setStatusChoice(e.target.value)}>
            <option value="DRAFT">DRAFT</option>
            <option value="DRAFT_READY">DRAFT_READY</option>
            <option value="POSTED">POSTED</option>
            <option value="ARCHIVED">ARCHIVED</option>
            <option value="FAILED">FAILED</option>
            <option value="PROCESSING">PROCESSING</option>
          </select>
          <button
            type="button"
            className="co-btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await fetch(`/api/contentops/posts/${postId}/status`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "include",
                  body: JSON.stringify({ status: statusChoice }),
                });
                if (!res.ok) {
                  const j = await res.json().catch(() => ({}));
                  setError((j as { error?: string }).error ?? "Update failed");
                } else {
                  const payload = (await res.json()) as SaveStatusResponse;
                  if (payload.sheetSyncFailed) {
                    setSheetSyncWarning(true);
                  } else {
                    setSheetSyncWarning(false);
                  }
                  await load();
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            Save status
          </button>
        </div>
      </section>

      <section className="co-panel co-stack">
        <h2 style={{ marginTop: 0 }}>Posting Log</h2>
        {postingLogError ? (
          <p style={{ color: "var(--danger)", fontWeight: 600 }} role="alert">
            {postingLogError}
          </p>
        ) : null}
        {PLATFORM_OPTIONS.map((platform) => {
          const entry = logEntries[platform.id] ?? {};
          const selected = selectedPlatformIds.includes(platform.id);
          return (
            <div key={platform.id} className="co-stack" style={{ borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
              <strong>
                {platform.label}
                {selected ? " (selected)" : ""}
              </strong>
              <input
                className="co-input"
                placeholder={`${platform.label} URL`}
                value={entry.postedUrl ?? ""}
                onChange={(e) =>
                  setLogEntries((prev) => ({
                    ...prev,
                    [platform.id]: { ...prev[platform.id], postedUrl: e.target.value },
                  }))
                }
                onBlur={() => {
                  const raw = entry.postedUrl ?? "";
                  const normalized = normalizePostedUrlForDisplay(raw);
                  setLogEntries((prev) => ({
                    ...prev,
                    [platform.id]: { ...prev[platform.id], postedUrl: normalized || null },
                  }));
                }}
              />
              <div className="co-row">
                <input
                  className="co-input"
                  style={{ maxWidth: 260 }}
                  placeholder="Posted by (optional)"
                  value={entry.postedBy ?? ""}
                  onChange={(e) =>
                    setLogEntries((prev) => ({
                      ...prev,
                      [platform.id]: { ...prev[platform.id], postedBy: e.target.value },
                    }))
                  }
                />
                <input
                  className="co-input"
                  style={{ maxWidth: 260 }}
                  type="datetime-local"
                  value={entry.postedAt ? new Date(entry.postedAt).toISOString().slice(0, 16) : ""}
                  onChange={(e) =>
                    setLogEntries((prev) => ({
                      ...prev,
                      [platform.id]: {
                        ...prev[platform.id],
                        postedAt: e.target.value ? new Date(e.target.value).toISOString() : null,
                      },
                    }))
                  }
                />
              </div>
              <textarea
                className="co-textarea"
                placeholder="Notes (optional)"
                value={entry.notes ?? ""}
                onChange={(e) =>
                  setLogEntries((prev) => ({
                    ...prev,
                    [platform.id]: { ...prev[platform.id], notes: e.target.value },
                  }))
                }
              />
              <div className="co-muted">Last updated: {entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : "-"}</div>
            </div>
          );
        })}

        <button
          type="button"
          className="co-btn primary"
          disabled={savingLog}
          onClick={async () => {
            setSavingLog(true);
            setPostingLogError(null);
            try {
              const entriesToSave = normalizeAllLogEntryUrls(logEntries);
              const res = await fetch(`/api/contentops/posts/${postId}/posting-log`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ entries: entriesToSave }),
              });
              const payload = await res.json();
              if (!res.ok) {
                const errBody = payload as { error?: string; issues?: PostingLogUrlIssue[] };
                if (errBody.error === "Invalid posting log URL" && errBody.issues?.length) {
                  const ids = errBody.issues.map((i) => i.platform).join(", ");
                  setPostingLogError(`Invalid posting log URL for ${ids}`);
                } else {
                  setPostingLogError(errBody.error ?? "Failed to save posting log");
                }
              } else {
                const successPayload = payload as SavePostingLogResponse;
                setLogEntries(successPayload.entries ?? {});
                setPostingLogError(null);
                if (successPayload.sheetSyncFailed) {
                  setSheetSyncWarning(true);
                } else {
                  setSheetSyncWarning(false);
                }
              }
            } finally {
              setSavingLog(false);
            }
          }}
        >
          Save posting log
        </button>
      </section>

      <section className="co-panel co-stack">
        <h2 style={{ marginTop: 0 }}>Assets</h2>
        <div className="co-grid">
          {post.assets.map((a) => (
            <div key={a.id} className="co-thumb">
              {a.mimeType.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/contentops/drive/file?id=${encodeURIComponent(a.driveFileId)}`} alt={a.finalName} />
              ) : (
                <div className="co-file-placeholder">{extLabel(a.finalName)}</div>
              )}
              <div style={{ padding: "0.35rem 0.5rem", fontSize: "0.8rem" }}>
                <div>{a.finalName}</div>
                {a.webViewLink ? (
                  <a href={a.webViewLink} target="_blank" rel="noreferrer">
                    Drive
                  </a>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="co-panel co-stack">
        <h2 style={{ marginTop: 0 }}>Drafts</h2>
        {post.drafts.map((d) => {
          const blocks: { label: string; text: string }[] = [];
          if (d.title) blocks.push({ label: "Title", text: d.title });
          if (d.caption) blocks.push({ label: "Caption / snippet", text: d.caption });
          if (d.hashtags) blocks.push({ label: "Hashtags", text: d.hashtags });
          if (d.description) blocks.push({ label: "Description", text: d.description });
          const joined = blocks.map((b) => `${b.label}:\n${b.text}`).join("\n\n");

          return (
            <div key={d.id} className="co-stack" style={{ borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
              <div className="co-row" style={{ justifyContent: "space-between" }}>
                <strong>{d.platform}</strong>
                {joined ? <CopyButton text={joined} /> : null}
              </div>
              {d.title ? (
                <label className="co-stack">
                  <span className="co-muted">Title</span>
                  <textarea className="co-textarea" readOnly value={d.title} />
                </label>
              ) : null}
              {d.caption ? (
                <label className="co-stack">
                  <span className="co-muted">{d.platform === "WEBSITE" ? "Snippet" : "Caption"}</span>
                  <textarea className="co-textarea" readOnly value={d.caption} />
                </label>
              ) : null}
              {d.hashtags ? (
                <label className="co-stack">
                  <span className="co-muted">Hashtags</span>
                  <textarea className="co-textarea" readOnly value={d.hashtags} />
                </label>
              ) : null}
              {d.description ? (
                <label className="co-stack">
                  <span className="co-muted">Description</span>
                  <textarea className="co-textarea" readOnly value={d.description} />
                </label>
              ) : null}
            </div>
          );
        })}
      </section>
    </main>
  );
}

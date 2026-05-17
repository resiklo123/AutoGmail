"use client";

import { LoadingOverlay } from "@/components/contentops/loading-overlay";
import {
  MACHINE_FAMILY_OPTIONS,
  normalizeContentOpsMachineFamily,
  TOPIC_OPTIONS,
} from "@/lib/contentops-constants";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type FileRow = { id: string; file: File };

type UploadFileResult = {
  originalName: string;
  ok: boolean;
  storedName?: string;
  driveFileId?: string;
  error?: string;
};

type UploadSuccess = {
  batchId: string;
  batchCode: string;
  uploadedCount: number;
  failedCount: number;
  files: UploadFileResult[];
  driveFolderUrl: string | null;
};

let fileRowId = 0;
function nextRowId() {
  fileRowId += 1;
  return `f-${fileRowId}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ContentOpsUploadPage() {
  const [rows, setRows] = useState<FileRow[]>([]);
  const [machineFamily, setMachineFamily] = useState("");
  const [machineModel, setMachineModel] = useState("");
  const [topic, setTopic] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<UploadSuccess | null>(null);

  const canonicalFamily = useMemo(() => (machineFamily.trim() ? normalizeContentOpsMachineFamily(machineFamily) : ""), [machineFamily]);

  useEffect(() => {
    if (!canonicalFamily) {
      setModelOptions([]);
      return;
    }
    let cancelled = false;
    setLoadingModels(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/contentops/machine-models?family=${encodeURIComponent(canonicalFamily)}`,
          { credentials: "include" },
        );
        const data = await res.json();
        if (!cancelled && res.ok && data?.ok && Array.isArray(data.models)) {
          setModelOptions(data.models as string[]);
        } else if (!cancelled) {
          setModelOptions([]);
        }
      } catch {
        if (!cancelled) setModelOptions([]);
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canonicalFamily]);

  const totalBytes = useMemo(() => rows.reduce((s, r) => s + r.file.size, 0), [rows]);

  const onPickFiles = useCallback((list: FileList | null) => {
    if (!list?.length) return;
    setRows((prev) => {
      const add: FileRow[] = [];
      for (let i = 0; i < list.length; i++) {
        const file = list.item(i);
        if (file) add.push({ id: nextRowId(), file });
      }
      return [...prev, ...add];
    });
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const submit = async () => {
    if (rows.length === 0) {
      setError("Select at least one file.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const fd = new FormData();
      for (const r of rows) {
        fd.append("files", r.file);
      }
      if (machineFamily.trim()) fd.append("machineFamily", machineFamily.trim());
      if (machineModel.trim()) fd.append("machineModel", machineModel.trim());
      if (topic.trim()) fd.append("topic", topic.trim());
      if (location.trim()) fd.append("location", location.trim());
      if (notes.trim()) fd.append("notes", notes.trim());

      const res = await fetch("/api/contentops/upload-batches", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = (data as { error?: string }).error ?? "Upload failed";
        const files = (data as { files?: UploadFileResult[] }).files;
        if (files?.length) {
          const names = files.filter((f) => !f.ok).map((f) => f.originalName);
          setError(names.length ? `${msg}: ${names.join(", ")}` : msg);
        } else {
          setError(msg);
        }
        return;
      }
      const body = data as UploadSuccess & { ok?: boolean };
      setSuccess({
        batchId: body.batchId,
        batchCode: body.batchCode,
        uploadedCount: body.uploadedCount,
        failedCount: body.failedCount,
        files: body.files ?? [],
        driveFolderUrl: body.driveFolderUrl ?? null,
      });
      setRows([]);
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  if (success) {
    const failed = success.files.filter((f) => !f.ok);
    return (
      <div className="co-stack" style={{ padding: "1rem", maxWidth: 560, margin: "0 auto", gap: "1rem" }}>
        <h1 style={{ margin: 0, fontSize: "clamp(1.25rem, 4vw, 1.5rem)" }}>Upload complete</h1>
        <p style={{ fontSize: "1.05rem" }}>
          Batch <strong>{success.batchCode}</strong>
        </p>
        <p>
          Uploaded: <strong>{success.uploadedCount}</strong> · Failed: <strong>{success.failedCount}</strong>
        </p>
        {failed.length > 0 ? (
          <ul className="co-stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: "0.35rem" }}>
            {failed.map((f) => (
              <li key={f.originalName + (f.error ?? "")} style={{ fontSize: "0.9rem" }}>
                <span style={{ fontWeight: 600 }}>{f.originalName}</span>
                {f.error ? <span className="co-muted"> — {f.error}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {success.driveFolderUrl ? (
          <p>
            <a href={success.driveFolderUrl} target="_blank" rel="noreferrer">
              Open Drive folder
            </a>
          </p>
        ) : null}
        <div className="co-stack" style={{ gap: "0.5rem" }}>
          <Link href="/admin/contentops/batches" className="co-btn primary" style={{ textAlign: "center", textDecoration: "none" }}>
            View Batches
          </Link>
          <Link href="/admin/contentops" className="co-btn" style={{ textAlign: "center", textDecoration: "none" }}>
            Open ContentOps Home
          </Link>
          <button
            type="button"
            className="co-btn"
            onClick={() => {
              setSuccess(null);
              setError(null);
            }}
          >
            Upload More
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="co-stack" style={{ padding: "1rem", maxWidth: 560, margin: "0 auto", gap: "1rem", position: "relative" }}>
      <LoadingOverlay open={busy} text="Uploading…" fullscreen />
      <h1 style={{ margin: 0, fontSize: "clamp(1.25rem, 4vw, 1.5rem)" }}>Upload to Incoming</h1>
      <p className="co-muted">
        <Link href="/admin/contentops">← Inbox</Link>
      </p>
      {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}

      <p className="co-muted" style={{ margin: 0, fontSize: "0.9rem" }}>
        For now, use smaller videos. Large video upload support will be improved in a later phase.
      </p>

      <label className="co-stack" style={{ gap: "0.35rem" }}>
        <span className="co-muted">Files (images & videos)</span>
        <input
          type="file"
          multiple
          accept="image/*,video/*"
          className="co-input"
          style={{ minHeight: 48, padding: "0.5rem" }}
          disabled={busy}
          onChange={(e) => {
            onPickFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </label>

      <p style={{ margin: 0, fontSize: "0.95rem" }}>
        Selected: <strong>{rows.length}</strong> file{rows.length === 1 ? "" : "s"}
        {rows.length > 0 ? (
          <>
            {" "}
            · {formatBytes(totalBytes)}
          </>
        ) : null}
      </p>

      {rows.length > 0 ? (
        <ul className="co-stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: "0.5rem" }}>
          {rows.map((r) => (
            <li
              key={r.id}
              className="co-panel"
              style={{
                padding: "0.65rem 0.75rem",
                display: "flex",
                flexWrap: "wrap",
                gap: "0.5rem",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ flex: "1 1 12rem", minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{r.file.name}</div>
                <div className="co-muted" style={{ fontSize: "0.8rem" }}>
                  {r.file.type || "unknown type"} · {formatBytes(r.file.size)}
                </div>
              </div>
              <button type="button" className="co-btn" disabled={busy} onClick={() => removeRow(r.id)} style={{ minHeight: 44, minWidth: 44 }}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <details className="co-panel" style={{ padding: "0.75rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, minHeight: 44, listStylePosition: "outside" }}>
          Optional metadata
        </summary>
        <div className="co-stack" style={{ marginTop: "0.75rem", gap: "0.75rem" }}>
          <label className="co-stack">
            <span className="co-muted">Machine family</span>
            <select className="co-select" value={machineFamily} onChange={(e) => setMachineFamily(e.target.value)} disabled={busy}>
              <option value="">—</option>
              {MACHINE_FAMILY_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="co-stack">
            <span className="co-muted">Machine model {loadingModels ? "(loading…)" : null}</span>
            {modelOptions.length > 0 ? (
              <select className="co-select" value={machineModel} onChange={(e) => setMachineModel(e.target.value)} disabled={busy}>
                <option value="">—</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input className="co-input" value={machineModel} onChange={(e) => setMachineModel(e.target.value)} disabled={busy} placeholder="Model" />
            )}
          </label>
          <label className="co-stack">
            <span className="co-muted">Topic</span>
            <select className="co-select" value={topic} onChange={(e) => setTopic(e.target.value)} disabled={busy}>
              <option value="">—</option>
              {TOPIC_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="co-stack">
            <span className="co-muted">Location</span>
            <input className="co-input" value={location} onChange={(e) => setLocation(e.target.value)} disabled={busy} placeholder="City / site" />
          </label>
          <label className="co-stack">
            <span className="co-muted">Notes (optional)</span>
            <textarea
              className="co-textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={busy}
              placeholder="Internal notes for this batch"
              rows={3}
            />
          </label>
        </div>
      </details>

      <button type="button" className="co-btn primary" style={{ minHeight: 48, fontSize: "1rem" }} disabled={busy || rows.length === 0} onClick={() => void submit()}>
        Upload to Incoming
      </button>
    </div>
  );
}

import { randomBytes } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { assertContentOpsRequest } from "@/lib/contentops-auth";
import { normalizeContentOpsMachineFamily } from "@/lib/contentops-constants";
import {
  ensureIncomingBatchFolderPath,
  sanitizePathSegment,
  uploadBufferToDriveFolder,
} from "@/lib/google-drive";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const MAX_FILES_PER_BATCH = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_BATCH_BYTES = 100 * 1024 * 1024;

const DEFAULT_UPLOAD_NOTE = "Uploaded without manual tags. Please review before creating post.";
const PARTIAL_METADATA_NOTE = "Partial manual tags provided. Please review before creating post.";

function formTrimString(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function isSupportedMediaMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return m.startsWith("image/") || m.startsWith("video/");
}

function safeUploadFailureMessage(err: unknown): string {
  if (!(err instanceof Error)) return "Upload failed";
  const msg = err.message.trim().slice(0, 200);
  if (/GOOGLE_SERVICE_ACCOUNT_JSON|private\s*key|refresh.?token|credential/i.test(msg)) {
    return "Drive configuration error";
  }
  return msg || "Upload failed";
}

function buildBatchCodeAndPrefix(uploadedAt: Date): { batchCode: string; storedPrefix: string } {
  const ymd = `${uploadedAt.getUTCFullYear()}${String(uploadedAt.getUTCMonth() + 1).padStart(2, "0")}${String(
    uploadedAt.getUTCDate(),
  ).padStart(2, "0")}`;
  const hm = `${String(uploadedAt.getUTCHours()).padStart(2, "0")}${String(uploadedAt.getUTCMinutes()).padStart(2, "0")}`;
  const suffix = randomBytes(2).toString("hex");
  return {
    batchCode: `batch_${ymd}_${hm}_${suffix}`,
    storedPrefix: `${ymd}_${hm}_batch_${suffix}`,
  };
}

function buildStoredFileName(originalName: string, slotIndex: number, storedPrefix: string): string {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  const safeBase = sanitizePathSegment(base).replace(/\s+/g, "_").slice(0, 80) || "file";
  const idx = String(slotIndex).padStart(3, "0");
  return `${storedPrefix}_${idx}_${safeBase}${ext}`;
}

type FileOutcome = {
  originalName: string;
  ok: boolean;
  storedName?: string;
  driveFileId?: string;
  error?: string;
};

type ValidatedUploadFile = {
  file: File;
  originalName: string;
  mime: string;
  size: number;
};

function resolveBatchMetadata(params: {
  machineFamilyIn: string;
  machineModelIn: string;
  topicIn: string;
  locationIn: string;
  notesIn: string;
}) {
  const { machineFamilyIn, machineModelIn, topicIn, locationIn, notesIn } = params;
  const mainProvided = [machineFamilyIn, machineModelIn, topicIn, locationIn].map((s) => s.length > 0);
  const mainCount = mainProvided.filter(Boolean).length;

  const machineFamily = machineFamilyIn
    ? normalizeContentOpsMachineFamily(machineFamilyIn) || machineFamilyIn
    : "Unknown";
  const machineModel = machineModelIn || "Unknown";
  const topic = topicIn || "Uncategorized";
  const location = locationIn || "Unknown";

  if (mainCount === 0) {
    return {
      machineFamily: "Unknown",
      machineModel: "Unknown",
      topic: "Uncategorized",
      location: "Unknown",
      metadataSource: "DEFAULT",
      reviewStatus: "NEEDS_REVIEW",
      notes: notesIn || DEFAULT_UPLOAD_NOTE,
    };
  }

  if (mainCount === 4) {
    return {
      machineFamily,
      machineModel,
      topic,
      location,
      metadataSource: "USER_ENTERED",
      reviewStatus: "READY",
      notes: notesIn || null,
    };
  }

  const partialNotes = notesIn ? `${notesIn}\n\n${PARTIAL_METADATA_NOTE}` : PARTIAL_METADATA_NOTE;
  return {
    machineFamily,
    machineModel,
    topic,
    location,
    metadataSource: "USER_ENTERED",
    reviewStatus: "NEEDS_REVIEW",
    notes: partialNotes,
  };
}

function validateFilesForUpload(rawFiles: File[]): {
  outcomes: FileOutcome[];
  validFiles: ValidatedUploadFile[];
} {
  const outcomes: FileOutcome[] = [];
  const validFiles: ValidatedUploadFile[] = [];
  let batchBytes = 0;

  for (const file of rawFiles) {
    const originalName = file.name || "unnamed";
    const mime = file.type || "application/octet-stream";
    const size = file.size;

    if (!isSupportedMediaMime(mime)) {
      outcomes.push({ originalName, ok: false, error: "Unsupported file type" });
      continue;
    }

    if (size > MAX_FILE_BYTES) {
      outcomes.push({ originalName, ok: false, error: "File exceeds 25 MB limit" });
      continue;
    }

    if (batchBytes + size > MAX_BATCH_BYTES) {
      outcomes.push({ originalName, ok: false, error: "Would exceed 100 MB batch limit" });
      continue;
    }

    batchBytes += size;
    validFiles.push({ file, originalName, mime, size });
  }

  return { outcomes, validFiles };
}

export async function POST(request: Request) {
  try {
    await assertContentOpsRequest(request);
  } catch (e) {
    const code = (e as Error & { statusCode?: number }).statusCode;
    if (code === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const rawFiles = formData.getAll("files").filter((x): x is File => typeof File !== "undefined" && x instanceof File);
  if (rawFiles.length === 0) {
    return NextResponse.json({ error: "At least one file is required" }, { status: 400 });
  }

  if (rawFiles.length > MAX_FILES_PER_BATCH) {
    return NextResponse.json(
      { error: `Too many files (max ${MAX_FILES_PER_BATCH} per batch)` },
      { status: 400 },
    );
  }

  const machineFamilyIn = formTrimString(formData, "machineFamily");
  const machineModelIn = formTrimString(formData, "machineModel");
  const topicIn = formTrimString(formData, "topic");
  const locationIn = formTrimString(formData, "location");
  const notesIn = formTrimString(formData, "notes");

  const meta = resolveBatchMetadata({ machineFamilyIn, machineModelIn, topicIn, locationIn, notesIn });

  const { outcomes: preUploadOutcomes, validFiles } = validateFilesForUpload(rawFiles);

  if (validFiles.length === 0) {
    return NextResponse.json(
      {
        error: "No valid files to upload (check type and size limits)",
        files: preUploadOutcomes,
      },
      { status: 400 },
    );
  }

  const uploadedAt = new Date();
  const { batchCode, storedPrefix } = buildBatchCodeAndPrefix(uploadedAt);

  let folderId: string | null = null;
  let folderUrl: string | null = null;

  try {
    const folder = await ensureIncomingBatchFolderPath({ uploadedAt, batchCode });
    folderId = folder.folderId;
    folderUrl = folder.folderUrl;
    console.log(`[contentops] Upload batch folder path created ${folder.pathLabel}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Incoming folder setup failed";
    console.warn("[contentops] Upload batch folder setup failed:", msg);
    return NextResponse.json({ error: "Incoming Drive folder is not configured or could not be created" }, { status: 503 });
  }

  const batch = await prisma.uploadBatch.create({
    data: {
      batchCode,
      uploadedAt,
      uploadedBy: "Staff",
      machineFamily: meta.machineFamily,
      machineModel: meta.machineModel,
      topic: meta.topic,
      location: meta.location,
      metadataSource: meta.metadataSource,
      reviewStatus: meta.reviewStatus,
      fileCount: 0,
      driveFolderId: folderId,
      driveFolderUrl: folderUrl,
      notes: meta.notes,
    },
  });

  console.log(`[contentops] Upload batch created ${batchCode}`);

  const outcomes: FileOutcome[] = [...preUploadOutcomes];
  let supportIndex = 0;
  let successfulUploadCount = 0;

  for (const item of validFiles) {
    const { file, originalName, mime } = item;
    supportIndex += 1;
    const storedName = buildStoredFileName(originalName, supportIndex, storedPrefix);
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const uploaded = await uploadBufferToDriveFolder({
        parentFolderId: folderId!,
        storedFileName: storedName,
        mimeType: mime,
        body: buf,
      });
      const sizeBytes = BigInt(buf.length);
      await prisma.incomingAsset.create({
        data: {
          batchId: batch.id,
          driveFileId: uploaded.id,
          originalName,
          storedName: uploaded.name,
          mimeType: uploaded.mimeType,
          sizeBytes,
          webViewLink: uploaded.webViewLink,
          thumbnailLink: uploaded.thumbnailLink,
          uploadStatus: "UPLOADED",
        },
      });
      successfulUploadCount += 1;
      console.log(`[contentops] Uploaded file ${uploaded.name}`);
      outcomes.push({
        originalName,
        ok: true,
        storedName: uploaded.name,
        driveFileId: uploaded.id,
      });
    } catch (err) {
      // TODO: failed asset persistence will need driveFileId nullable in a future migration.
      const safe = safeUploadFailureMessage(err);
      console.warn(`[contentops] Upload failed for file ${originalName}:`, safe);
      outcomes.push({ originalName, ok: false, error: safe });
    }
  }

  // UploadBatch.fileCount stores successful uploads only.
  await prisma.uploadBatch.update({
    where: { id: batch.id },
    data: { fileCount: successfulUploadCount },
  });

  const failedCount = outcomes.filter((o) => !o.ok).length;

  return NextResponse.json({
    ok: true,
    batchId: batch.id,
    batchCode,
    uploadedCount: successfulUploadCount,
    failedCount,
    files: outcomes,
    driveFolderUrl: folderUrl,
  });
}

import path from "node:path";
import { randomBytes } from "node:crypto";
import { defaultCtaUrl, normalizeContentOpsMachineFamily } from "@/lib/contentops-constants";
import {
  createShortcut,
  ensureByDateFolder,
  ensureByMachineFolder,
  ensureCanonicalPostFolder,
  getFileMetadata,
  moveAndRenameFile,
  sanitizePathSegment,
} from "@/lib/google-drive";
import { generateDraftsJson, type DraftsJson } from "@/lib/openai-drafts";
import { syncMasterSheetForPost } from "@/lib/googleSheets";
import { prisma } from "@/lib/prisma";
import { getOptionalRedis } from "@/lib/redis";
import { sendTelegramDraftReadyMessage } from "@/lib/telegram";

const STATUS_PROCESSING = "PROCESSING";
const STATUS_DRAFT_READY = "DRAFT_READY";
const STATUS_FAILED = "FAILED";

function slugifyText(value: string, max = 24): string {
  return sanitizePathSegment(value)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "item";
}

function shortCode(): string {
  return randomBytes(2).toString("hex");
}

function buildPostSlug(machineFamily: string, machineModel: string | null, topic: string, createdAt: Date): string {
  const head = slugifyText(machineModel || machineFamily, 16);
  const topicSlug = slugifyText(topic, 20);
  const date = `${createdAt.getUTCFullYear()}${String(createdAt.getUTCMonth() + 1).padStart(2, "0")}${String(
    createdAt.getUTCDate(),
  ).padStart(2, "0")}`;
  return `${head}-${topicSlug}-${date}-${shortCode()}`;
}

function modelSlug(value?: string | null): string {
  if (!value) return "";
  return slugifyText(value, 24);
}

function buildFinalName(slug: string, machineModel: string | null | undefined, originalName: string): string {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext).replace(/[/\\?%*:|"'<>]/g, "-").slice(0, 96);
  const model = modelSlug(machineModel);
  return `${slug}_${model ? `${model}_` : ""}${base || "asset"}${ext}`;
}

function stubDraftsJson(): DraftsJson {
  return {
    fb: { caption: "TEST_MODE Facebook caption", hashtags: "#resiklo #test" },
    ig: { caption: "TEST_MODE Instagram caption", hashtags: "#resiklo #test" },
    tiktok: { caption: "TEST_MODE TikTok caption", hashtags: "#resiklo #test" },
    youtube: { title: "TEST_MODE YouTube title", description: "TEST_MODE YouTube description" },
    website: { snippet: "TEST_MODE website snippet" },
  };
}

function draftCreatesFromJson(postId: string, platforms: string[], data: DraftsJson) {
  const rows = [];
  const upper = new Set(platforms.map((p) => p.toUpperCase()));

  if (upper.has("FB")) rows.push({ postId, platform: "FB", caption: data.fb.caption, hashtags: data.fb.hashtags, version: 1 });
  if (upper.has("IG")) rows.push({ postId, platform: "IG", caption: data.ig.caption, hashtags: data.ig.hashtags, version: 1 });
  if (upper.has("TIKTOK")) {
    rows.push({ postId, platform: "TIKTOK", caption: data.tiktok.caption, hashtags: data.tiktok.hashtags, version: 1 });
  }
  if (upper.has("YOUTUBE")) {
    rows.push({ postId, platform: "YOUTUBE", title: data.youtube.title, description: data.youtube.description, version: 1 });
  }
  if (upper.has("WEBSITE")) rows.push({ postId, platform: "WEBSITE", caption: data.website.snippet, version: 1 });

  return rows;
}

async function rememberMachineModel(machineFamily: string, machineModel?: string | null): Promise<void> {
  const model = machineModel?.trim();
  if (!model) return;
  const existing = await prisma.machineModelOption.findFirst({
    where: { family: machineFamily, model },
    select: { id: true },
  });
  if (existing) {
    await prisma.machineModelOption.update({
      where: { id: existing.id },
      data: { isActive: true },
    });
    return;
  }
  await prisma.machineModelOption.create({
    data: { family: machineFamily, model, isActive: true },
  });
}

export async function processNewContentOpsPost(input: {
  machineFamily: string;
  machineModel?: string | null;
  topic: string;
  location?: string | null;
  platforms: string[];
  driveFileIds: string[];
}): Promise<{ postId: string; sheetSyncFailed?: boolean }> {
  const testMode = process.env.CONTENTOPS_TEST_MODE === "true";
  const redis = getOptionalRedis();
  void redis?.incr("contentops:posts_created").catch(() => undefined);

  const rawFamily = input.machineFamily?.trim() ?? "";
  const canonicalFamily = normalizeContentOpsMachineFamily(rawFamily);
  const normalizedFamily = canonicalFamily ? sanitizePathSegment(canonicalFamily) : sanitizePathSegment(rawFamily);
  const normalizedModel = input.machineModel?.trim() ? sanitizePathSegment(input.machineModel) : null;
  const createdAt = new Date();
  const slug = buildPostSlug(normalizedFamily, normalizedModel, input.topic, createdAt);

  const post = await prisma.post.create({
    data: {
      slug,
      machine: normalizedFamily,
      machineFamily: normalizedFamily,
      machineModel: normalizedModel,
      topic: input.topic,
      location: input.location ?? null,
      platforms: input.platforms.map((p) => p.toUpperCase()),
      status: STATUS_PROCESSING,
      createdAt,
    },
  });

  await rememberMachineModel(normalizedFamily, normalizedModel);

  try {
    if (testMode) {
      console.log(
        "[contentops] TEST_MODE=true; skipping Drive folder/shortcut creation, folder URL fields will be blank",
      );
      await prisma.asset.createMany({
        data: input.driveFileIds.map((driveFileId, i) => ({
          postId: post.id,
          driveFileId,
          originalName: `test-asset-${i + 1}.jpg`,
          finalName: buildFinalName(post.slug, normalizedModel, `test-asset-${i + 1}.jpg`),
          mimeType: "image/jpeg",
          size: null,
          webViewLink: null,
          thumbnailLink: null,
        })),
      });

      const draftRows = draftCreatesFromJson(post.id, input.platforms, stubDraftsJson());
      if (draftRows.length) await prisma.draft.createMany({ data: draftRows });
      await prisma.post.update({ where: { id: post.id }, data: { status: STATUS_DRAFT_READY } });
      let sheetSyncFailed = false;
      try {
        sheetSyncFailed = await syncMasterSheetForPost(post.id, { includeAssets: true });
      } catch (sheetError) {
        const e = sheetError instanceof Error ? sheetError : new Error(String(sheetError));
        console.error("[contentops] sheet sync failed", e.message, e.stack ?? "");
        sheetSyncFailed = true;
      }
      return { postId: post.id, sheetSyncFailed };
    }

    const metas = await Promise.all(input.driveFileIds.map((id) => getFileMetadata(id)));
    const canonicalFolderId = await ensureCanonicalPostFolder({
      machineFamily: normalizedFamily,
      machineModel: normalizedModel,
      createdAt: post.createdAt,
      slug: post.slug,
    });

    const moved: { meta: (typeof metas)[0]; finalName: string; afterMove: Awaited<ReturnType<typeof moveAndRenameFile>> }[] = [];
    for (const meta of metas) {
      const finalName = buildFinalName(post.slug, normalizedModel, meta.name);
      const afterMove = await moveAndRenameFile(meta.id, canonicalFolderId, finalName);
      moved.push({ meta, finalName, afterMove });
    }

    // Drive files already moved above; a failure here leaves them orphaned in the canonical folder.
    await prisma.asset.createMany({
      data: moved.map(({ meta, finalName, afterMove }) => ({
        postId: post.id,
        driveFileId: afterMove.id ?? meta.id,
        originalName: meta.name,
        finalName,
        mimeType: afterMove.mimeType ?? meta.mimeType,
        size: afterMove.size != null ? BigInt(afterMove.size) : meta.size != null ? BigInt(meta.size) : null,
        webViewLink: afterMove.webViewLink ?? meta.webViewLink ?? null,
        thumbnailLink: afterMove.thumbnailLink ?? meta.thumbnailLink ?? null,
      })),
    });

    const year = post.createdAt.getUTCFullYear().toString();
    const month = String(post.createdAt.getUTCMonth() + 1).padStart(2, "0");
    const byMachineId = await ensureByMachineFolder(normalizedFamily, normalizedModel);
    const byDateId = await ensureByDateFolder(year, month);

    console.log(
      `[contentops] Drive folders created for post ${post.id}: libraryFolderId=${canonicalFolderId}, byDateId=${byDateId}, byMachineId=${byMachineId}`,
    );

    for (let i = 0; i < moved.length; i++) {
      const item = moved[i]!;
      const ext = path.extname(item.finalName) || path.extname(item.meta.name) || "";
      const shortcutName = `${post.slug}__${String(i + 1).padStart(2, "0")}${ext}`;
      const targetId = item.afterMove.id ?? item.meta.id;
      await createShortcut(byMachineId, targetId, shortcutName);
      await createShortcut(byDateId, targetId, shortcutName);
    }

    const draftsJson = await generateDraftsJson({
      machine: normalizedModel ? `${normalizedFamily} ${normalizedModel}` : normalizedFamily,
      topic: input.topic,
      location: input.location,
      ctaUrl: defaultCtaUrl(),
      platforms: input.platforms.map((p) => p.toUpperCase()),
    });
    const draftRows = draftCreatesFromJson(post.id, input.platforms, draftsJson);
    if (draftRows.length) await prisma.draft.createMany({ data: draftRows });

    const updatedPost = await prisma.post.update({
      where: { id: post.id },
      data: {
        status: STATUS_DRAFT_READY,
        libraryFolderId: canonicalFolderId,
        libraryFolderUrl: `https://drive.google.com/drive/folders/${canonicalFolderId}`,
        byDateShortcutUrl: `https://drive.google.com/drive/folders/${byDateId}`,
        byMachineShortcutUrl: `https://drive.google.com/drive/folders/${byMachineId}`,
      },
    });
    console.log("[contentops] Post folder fields saved", {
      postId: updatedPost.id,
      libraryFolderId: updatedPost.libraryFolderId,
      hasLibraryFolderUrl: !!updatedPost.libraryFolderUrl,
      hasByDateShortcutUrl: !!updatedPost.byDateShortcutUrl,
      hasByMachineShortcutUrl: !!updatedPost.byMachineShortcutUrl,
    });
    let sheetSyncFailed = false;
    try {
      sheetSyncFailed = await syncMasterSheetForPost(post.id, { includeAssets: true });
    } catch (sheetError) {
      const e = sheetError instanceof Error ? sheetError : new Error(String(sheetError));
      console.error("[contentops] sheet sync failed", e.message, e.stack ?? "");
      sheetSyncFailed = true;
    }

    try {
      await sendTelegramDraftReadyMessage({
        postId: post.id,
        machine: normalizedModel ? `${normalizedFamily}/${normalizedModel}` : normalizedFamily,
        topic: input.topic,
      });
    } catch (e) {
      console.error("[contentops] Telegram notify failed (post still DRAFT_READY):", e);
    }

    return { postId: post.id, sheetSyncFailed };
  } catch (e) {
    await prisma.post.update({ where: { id: post.id }, data: { status: STATUS_FAILED } });
    throw e;
  }
}
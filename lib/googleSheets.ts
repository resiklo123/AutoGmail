import "server-only";
import { google, sheets_v4 } from "googleapis";
import { prisma } from "@/lib/prisma";

const POSTING_LOG_TAB = "PostingLog";
const POSTING_LOG_PLATFORM_ORDER = ["FB", "IG", "TIKTOK", "YOUTUBE", "WEBSITE"] as const;

const POSTS_TAB = "Posts";
const POSTS_HEADERS = [
  "PostId",
  "CreatedAt",
  "CreatedBy",
  "Status",
  "UpdatedAt",
  "MachineFamily",
  "MachineModel",
  "Topic",
  "Location",
  "PlatformsCSV",
  "AssetCount",
  "LibraryFolderId",
  "LibraryFolderURL",
  "ByDateShortcutURL",
  "ByMachineShortcutURL",
] as const;

const ASSETS_TAB = "Assets";
const ASSETS_HEADERS = [
  "PostId",
  "AssetId",
  "CreatedAt",
  "DriveFileId",
  "OriginalName",
  "FinalName",
  "MimeType",
  "WebViewLink",
  "ThumbnailLink",
  "LibraryFolderId",
  "LibraryFolderURL",
  "ByDateShortcutURL",
  "ByMachineShortcutURL",
] as const;

const REQUIRED_HEADERS = [
  "PostId",
  "CreatedAt",
  "UpdatedAt",
  "Status",
  "MachineFamily",
  "MachineModel",
  "Topic",
  "Location",
  "Platforms",
  "DriveFolderUrl",
  "AssetCount",
  "LibraryFolderId",
  "LibraryFolderURL",
  "ByDateShortcutURL",
  "ByMachineShortcutURL",
  "PrimaryAssetDriveUrl",
  "FB_Url",
  "IG_Url",
  "TikTok_Url",
  "YouTube_Url",
  "Website_Url",
  "PostedAt",
  "PostedBy",
  "Notes",
] as const;

/** When writing sheet rows, also fill existing duplicate-equivalent columns (first column wins for reads). */
const HEADERS_MIRROR_DUPLICATES = new Set([
  "PostId",
  "Platforms",
  "PlatformsCSV",
  "AssetCount",
  "DriveFolderUrl",
  "LibraryFolderId",
  "LibraryFolderURL",
  "ByDateShortcutURL",
  "ByMachineShortcutURL",
]);

/** Maps human-readable sheet labels to canonical writer keys (POSTS_HEADERS / ASSETS_HEADERS / PostingLog). */
const HEADER_ALIASES: Record<string, string> = {
  PostID: "PostId",
  AssetID: "AssetId",
  "Platforms (CSV)": "PlatformsCSV",
  LibraryFolderID: "LibraryFolderId",
  DriveFileID: "DriveFileId",
  DriveFileURL: "WebViewLink",
  OriginalFileName: "OriginalName",
  NewFileName: "FinalName",
};

function parseServiceAccountJson(raw: string | undefined): object {
  if (!raw || !raw.trim()) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is empty");
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as object;
  } catch {
    try {
      const unescaped = JSON.parse(`"${trimmed.replace(/"/g, '\\"')}"`) as string;
      return JSON.parse(unescaped) as object;
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
  }
}

function getMasterSheetId(): string | null {
  const sheetId = process.env.CONTENTOPS_MASTER_SHEET_ID?.trim();
  if (!sheetId) {
    console.warn("[contentops] CONTENTOPS_MASTER_SHEET_ID missing; skipping Sheets mirror sync.");
    return null;
  }
  return sheetId;
}

/** Last 6 chars of spreadsheet id for logs only (never log full id). */
function safeSheetIdSuffix(spreadsheetId: string): string {
  const t = spreadsheetId.trim();
  if (t.length <= 6) return `...${t}`;
  return `...${t.slice(-6)}`;
}

function logBlankFolderFieldsForPost(post: {
  id: string;
  libraryFolderId: string | null;
  libraryFolderUrl: string | null;
  byDateShortcutUrl: string | null;
  byMachineShortcutUrl: string | null;
}): void {
  const hasLibId = !!(post.libraryFolderId && String(post.libraryFolderId).trim());
  const hasLibUrl = !!(post.libraryFolderUrl && post.libraryFolderUrl.trim());
  const hasByDate = !!(post.byDateShortcutUrl && post.byDateShortcutUrl.trim());
  const hasByMachine = !!(post.byMachineShortcutUrl && post.byMachineShortcutUrl.trim());
  if (hasLibId && hasLibUrl && hasByDate && hasByMachine) return;
  const testMode = process.env.CONTENTOPS_TEST_MODE === "true";
  console.log(
    `[contentops] Sheet sync: folder fields blank for post ${post.id}; testMode=${testMode}; libraryFolderId=${hasLibId ? "present" : "empty"}`,
  );
}

function getSheetsClient(): sheets_v4.Sheets {
  const credentials = parseServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function driveFileUrl(fileId: string, webViewLink?: string | null): string {
  return webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
}

function normalizeCell(value: unknown): string {
  return value == null ? "" : String(value);
}

function getRowValue(row: string[], map: Map<string, number>, header: string): string {
  const idx = map.get(header);
  if (idx == null) return "";
  return normalizeCell(row[idx]);
}

function columnLetterFromIndex(zeroBasedIndex: number): string {
  let n = zeroBasedIndex + 1;
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function canonicalHeaderName(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  return HEADER_ALIASES[t] ?? t;
}

/** First-wins canonical map + duplicate column indices (later duplicates are not write targets). */
function buildCanonicalHeaderResolution(
  rawHeaderRow: (string | undefined)[],
  logPrefix: string,
  options?: { logAliases?: boolean },
): { map: Map<string, number>; secondaryByCanonical: Map<string, number[]> } {
  const logAliases = options?.logAliases !== false;
  const map = new Map<string, number>();
  const secondaryByCanonical = new Map<string, number[]>();
  rawHeaderRow.forEach((cell, idx) => {
    const raw = normalizeCell(cell).trim();
    if (!raw) return;
    const canonical = canonicalHeaderName(raw);
    if (logAliases && raw !== canonical) {
      console.log(`[contentops] ${logPrefix}: mapped alias "${raw}" → "${canonical}"`);
    }
    if (!map.has(canonical)) {
      map.set(canonical, idx);
    } else {
      const primary = map.get(canonical)!;
      console.warn(
        `[contentops] ${logPrefix}: duplicate canonical header "${canonical}" found at col ${columnLetterFromIndex(primary)} and col ${columnLetterFromIndex(idx)}; using col ${columnLetterFromIndex(primary)}`,
      );
      const sec = secondaryByCanonical.get(canonical) ?? [];
      sec.push(idx);
      secondaryByCanonical.set(canonical, sec);
    }
  });
  return { map, secondaryByCanonical };
}

/**
 * Resolves row-1 headers: alias → canonical name; first column wins on duplicate canonicals.
 * Logs when an alias is applied. Returns map: canonical header → 0-based column index.
 */
function resolveHeaderMap(
  rawHeaderRow: (string | undefined)[],
  logPrefix: string,
  options?: { logAliases?: boolean },
): Map<string, number> {
  return buildCanonicalHeaderResolution(rawHeaderRow, logPrefix, options).map;
}

/** PostingLog: HEADER_ALIASES first (e.g. Platforms (CSV) → PlatformsCSV), then PlatformsCSV → Platforms. */
function postingLogCellToCanonical(raw: string): string {
  let canonical = canonicalHeaderName(raw);
  if (canonical === "PlatformsCSV") canonical = "Platforms";
  return canonical;
}

/** PostingLog row-1: first-wins map + duplicate column indices (for copy repair). */
function buildPostingLogHeaderResolution(rawHeaderRow: (string | undefined)[]): {
  map: Map<string, number>;
  secondaryByCanonical: Map<string, number[]>;
} {
  const map = new Map<string, number>();
  const secondaryByCanonical = new Map<string, number[]>();
  rawHeaderRow.forEach((cell, idx) => {
    const raw = normalizeCell(cell).trim();
    if (!raw) return;
    const canonical = postingLogCellToCanonical(raw);
    if (raw !== canonical) {
      console.log(`[contentops] PostingLog tab: mapped alias "${raw}" → "${canonical}"`);
    }
    if (!map.has(canonical)) {
      map.set(canonical, idx);
    } else {
      const primary = map.get(canonical)!;
      console.warn(
        `[contentops] PostingLog tab: duplicate canonical header "${canonical}" found at col ${columnLetterFromIndex(primary)} and col ${columnLetterFromIndex(idx)}; using col ${columnLetterFromIndex(primary)}`,
      );
      const sec = secondaryByCanonical.get(canonical) ?? [];
      sec.push(idx);
      secondaryByCanonical.set(canonical, sec);
    }
  });
  return { map, secondaryByCanonical };
}

function postingLogHeaderCanonicalForDedupe(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  return postingLogCellToCanonical(t);
}

async function assertTabExists(sheets: sheets_v4.Sheets, spreadsheetId: string, tabTitle: string, label: string): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const titles = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean) as string[]);
  if (!titles.has(tabTitle)) {
    throw new Error(`[contentops] ${label}: tab "${tabTitle}" is missing`);
  }
}

/** Copy duplicate-column values into the preferred (first) column when primary is blank; updates sheet rows in place. */
async function repairSheetTabDuplicateColumnData(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tabTitle: string,
  logPrefix: string,
  sheetRows: string[][],
  map: Map<string, number>,
  secondaryByCanonical: Map<string, number[]>,
): Promise<void> {
  const headerLen = sheetRows[0]?.length ?? 0;
  for (let r = 1; r < sheetRows.length; r++) {
    const row = sheetRows[r];
    if (!row?.length) continue;
    while (row.length < headerLen) row.push("");
    let changed = false;
    for (const [canonical, dupIdxs] of secondaryByCanonical.entries()) {
      const primaryIdx = map.get(canonical);
      if (primaryIdx == null) continue;
      for (const dupIdx of dupIdxs) {
        const pv = normalizeCell(row[primaryIdx]).trim();
        const dv = normalizeCell(row[dupIdx]).trim();
        if (!pv && dv) {
          row[primaryIdx] = dv;
          changed = true;
          const rowNum = r + 1;
          console.log(
            `[contentops] ${logPrefix}: copied "${canonical}" value from col ${columnLetterFromIndex(dupIdx)} (row ${rowNum}) to col ${columnLetterFromIndex(primaryIdx)} (row ${rowNum})`,
          );
        }
      }
    }
    if (changed) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${tabTitle}'!${r + 1}:${r + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [row] },
      });
    }
  }
}

async function repairPostingLogDuplicateColumnData(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetRows: string[][],
  map: Map<string, number>,
  secondaryByCanonical: Map<string, number[]>,
): Promise<void> {
  await repairSheetTabDuplicateColumnData(
    sheets,
    spreadsheetId,
    POSTING_LOG_TAB,
    "PostingLog tab",
    sheetRows,
    map,
    secondaryByCanonical,
  );
}

function ensureRowLengthForIndex(row: string[], idx: number): void {
  while (row.length <= idx) row.push("");
}

/**
 * Writes a cell value to the primary column and, for safe headers only, to existing duplicate columns.
 * Returns true if at least one duplicate (non-primary) column was written.
 */
function writeValueToPrimaryAndDuplicateHeaders(
  row: string[],
  map: Map<string, number>,
  secondaryByCanonical: Map<string, number[]>,
  header: string,
  value: string,
): boolean {
  const primaryIdx = map.get(header);
  const dupIdxs = secondaryByCanonical.get(header) ?? [];

  if (!HEADERS_MIRROR_DUPLICATES.has(header)) {
    if (primaryIdx == null) return false;
    ensureRowLengthForIndex(row, primaryIdx);
    row[primaryIdx] = value;
    return false;
  }

  let mirroredDuplicate = false;
  if (primaryIdx != null) {
    ensureRowLengthForIndex(row, primaryIdx);
    row[primaryIdx] = value;
  }
  for (const dupIdx of dupIdxs) {
    ensureRowLengthForIndex(row, dupIdx);
    row[dupIdx] = value;
    mirroredDuplicate = true;
  }
  return mirroredDuplicate;
}

function mergeRowWithValueMap(
  headerRow: string[],
  map: Map<string, number>,
  base: string[],
  valueByHeader: Map<string, string>,
  secondaryByCanonical: Map<string, number[]>,
  options?: { onDuplicateMirror?: (canonicalHeader: string) => void },
): string[] {
  const row = base.slice();
  let maxIdx = Math.max(headerRow.length > 0 ? headerRow.length - 1 : 0, row.length > 0 ? row.length - 1 : 0, 0);
  for (const idx of map.values()) maxIdx = Math.max(maxIdx, idx);
  for (const ids of secondaryByCanonical.values()) {
    for (const idx of ids) maxIdx = Math.max(maxIdx, idx);
  }
  while (row.length <= maxIdx) row.push("");

  for (const [header, value] of valueByHeader.entries()) {
    const mirrored = writeValueToPrimaryAndDuplicateHeaders(row, map, secondaryByCanonical, header, value);
    if (mirrored && options?.onDuplicateMirror) options.onDuplicateMirror(header);
  }
  return row;
}

function logContentOpsSheetSyncFailed(err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error("[contentops] sheet sync failed", e.message, e.stack);
}

async function ensurePostingLogTabAndHeaders(sheets: sheets_v4.Sheets, spreadsheetId: string): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const titles = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean) as string[]);
  if (!titles.has(POSTING_LOG_TAB)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: POSTING_LOG_TAB } } }],
      },
    });
  }

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${POSTING_LOG_TAB}'!1:1`,
  });
  const current = (headerRes.data.values?.[0] ?? []).map((v) => normalizeCell(v).trim());
  const existingCanonical = new Set(
    current.filter((h) => h.length > 0).map((h) => postingLogHeaderCanonicalForDedupe(h)),
  );
  const missing = REQUIRED_HEADERS.filter((h) => !existingCanonical.has(h));
  if (missing.length > 0) {
    const nextHeaders = [...current, ...missing];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${POSTING_LOG_TAB}'!1:1`,
      valueInputOption: "RAW",
      requestBody: { values: [nextHeaders] },
    });
    console.log(`[contentops] PostingLog tab: appended missing headers ${missing.join(", ")}`);
  }
}

function newestDateIso(dates: Array<Date | null | undefined>): string {
  const valid = dates.filter((d): d is Date => d instanceof Date);
  if (valid.length === 0) return new Date().toISOString();
  valid.sort((a, b) => b.getTime() - a.getTime());
  return valid[0]!.toISOString();
}

export async function upsertPostingLogRow(postId: string): Promise<void> {
  const spreadsheetId = getMasterSheetId();
  if (!spreadsheetId) return;

  console.log(
    `[contentops] Sheets mirror target configured: CONTENTOPS_MASTER_SHEET_ID ending ${safeSheetIdSuffix(spreadsheetId)}`,
  );

  const sheets = getSheetsClient();
  await ensurePostingLogTabAndHeaders(sheets, spreadsheetId);

  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: {
      assets: {
        orderBy: [{ id: "asc" }],
      },
      drafts: {
        select: { updatedAt: true },
      },
      logs: {
        select: {
          platform: true,
          postedUrl: true,
          postedAt: true,
          postedBy: true,
          notes: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!post) return;

  logBlankFolderFieldsForPost(post);

  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${POSTING_LOG_TAB}'`,
  });
  const sheetRows = (sheetRes.data.values ?? []).map((row) => row.map((v) => normalizeCell(v)));
  const headerRow = sheetRows[0] ?? REQUIRED_HEADERS.slice();
  const { map, secondaryByCanonical } = buildPostingLogHeaderResolution(headerRow);
  await repairPostingLogDuplicateColumnData(sheets, spreadsheetId, sheetRows, map, secondaryByCanonical);

  const exactRowIndex = sheetRows.slice(1).findIndex((row) => getRowValue(row, map, "PostId") === post.id);
  const existingRow = exactRowIndex >= 0 ? sheetRows[exactRowIndex + 1] : [];

  const logByPlatform = new Map(post.logs.map((log) => [log.platform, log]));
  const platformLogs = POSTING_LOG_PLATFORM_ORDER
    .map((platform) => logByPlatform.get(platform))
    .filter((log): log is NonNullable<(typeof post.logs)[number]> => log != null);
  const preferredNote =
    logByPlatform.get("FB")?.notes?.trim() ||
    logByPlatform.get("IG")?.notes?.trim() ||
    logByPlatform.get("TIKTOK")?.notes?.trim() ||
    logByPlatform.get("YOUTUBE")?.notes?.trim() ||
    logByPlatform.get("WEBSITE")?.notes?.trim() ||
    platformLogs.find((log) => (log.notes ?? "").trim().length > 0)?.notes?.trim() ||
    "";

  const postedDates = platformLogs.map((l) => l.postedAt).filter((d): d is Date => d != null);
  postedDates.sort((a, b) => b.getTime() - a.getTime());
  const postedAtIso = postedDates.length > 0 ? postedDates[0]!.toISOString() : "";

  let firstPostedBy = "";
  for (const log of platformLogs) {
    const pb = log.postedBy?.trim();
    if (pb) {
      firstPostedBy = pb;
      break;
    }
  }

  const firstAsset = post.assets[0];
  const firstAssetUrl = firstAsset ? driveFileUrl(firstAsset.driveFileId, firstAsset.webViewLink) : "";

  const dbDriveFolderUrl: string | null = post.libraryFolderUrl ?? null;
  const existingDriveFolderUrl = getRowValue(existingRow, map, "DriveFolderUrl");
  const driveFolderUrl = dbDriveFolderUrl || existingDriveFolderUrl || "";

  const updatedAt = newestDateIso([...post.drafts.map((d) => d.updatedAt), ...post.logs.map((l) => l.updatedAt), post.createdAt]);

  const valueByHeader = new Map<string, string>([
    ["PostId", post.id],
    ["CreatedAt", post.createdAt.toISOString()],
    ["UpdatedAt", updatedAt],
    ["Status", post.status],
    ["MachineFamily", post.machineFamily],
    ["MachineModel", post.machineModel ?? ""],
    ["Topic", post.topic],
    ["Location", post.location ?? ""],
    ["Platforms", post.platforms.join(",")],
    ["DriveFolderUrl", driveFolderUrl],
    ["AssetCount", String(post.assets.length)],
    ["LibraryFolderId", post.libraryFolderId ?? ""],
    ["LibraryFolderURL", post.libraryFolderUrl ?? ""],
    ["ByDateShortcutURL", post.byDateShortcutUrl ?? ""],
    ["ByMachineShortcutURL", post.byMachineShortcutUrl ?? ""],
    ["PrimaryAssetDriveUrl", firstAssetUrl],
    ["FB_Url", logByPlatform.get("FB")?.postedUrl ?? ""],
    ["IG_Url", logByPlatform.get("IG")?.postedUrl ?? ""],
    ["TikTok_Url", logByPlatform.get("TIKTOK")?.postedUrl ?? ""],
    ["YouTube_Url", logByPlatform.get("YOUTUBE")?.postedUrl ?? ""],
    ["Website_Url", logByPlatform.get("WEBSITE")?.postedUrl ?? ""],
    ["PostedAt", postedAtIso],
    ["PostedBy", firstPostedBy],
    ["Notes", preferredNote],
  ]);

  const duplicateMirrorLog = (canonicalHeader: string) => {
    if (canonicalHeader === "PostId") {
      console.log("[contentops] PostingLog tab: mirrored duplicate header PostId");
    }
    if (canonicalHeader === "Platforms") {
      console.log("[contentops] PostingLog tab: mirrored duplicate header Platforms");
    }
  };

  const hasPostingLogTrackedExtras =
    map.has("AssetCount") ||
    map.has("LibraryFolderId") ||
    map.has("LibraryFolderURL") ||
    map.has("ByDateShortcutURL") ||
    map.has("ByMachineShortcutURL") ||
    map.has("PostedBy") ||
    map.has("PostedAt") ||
    map.has("Notes");

  if (exactRowIndex >= 0) {
    const rowNumber = exactRowIndex + 2;
    const outputRow = mergeRowWithValueMap(headerRow, map, existingRow, valueByHeader, secondaryByCanonical, {
      onDuplicateMirror: duplicateMirrorLog,
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${POSTING_LOG_TAB}'!${rowNumber}:${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [outputRow] },
    });
    console.log(`[contentops] PostingLog tab: upserted row for post ${post.id}`);
    if (hasPostingLogTrackedExtras) {
      console.log(`[contentops] PostingLog tab: updated AssetCount/folder/posting fields for post ${post.id}`);
    }
    await upsertPostsRow(post.id);
    return;
  }

  const outputRow = mergeRowWithValueMap(
    headerRow,
    map,
    Array.from({ length: headerRow.length }, () => ""),
    valueByHeader,
    secondaryByCanonical,
    { onDuplicateMirror: duplicateMirrorLog },
  );
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${POSTING_LOG_TAB}'`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [outputRow] },
  });
  console.log(`[contentops] PostingLog tab: upserted row for post ${post.id}`);
  if (hasPostingLogTrackedExtras) {
    console.log(`[contentops] PostingLog tab: updated AssetCount/folder/posting fields for post ${post.id}`);
  }
  await upsertPostsRow(post.id);
}

export async function upsertPostsRow(postId: string): Promise<void> {
  const spreadsheetId = getMasterSheetId();
  if (!spreadsheetId) return;

  const sheets = getSheetsClient();
  await assertTabExists(sheets, spreadsheetId, POSTS_TAB, "Posts tab");

  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      status: true,
      machineFamily: true,
      machineModel: true,
      topic: true,
      location: true,
      platforms: true,
      libraryFolderId: true,
      libraryFolderUrl: true,
      byDateShortcutUrl: true,
      byMachineShortcutUrl: true,
      _count: { select: { assets: true } },
      drafts: {
        select: { platform: true, caption: true, hashtags: true, title: true, description: true },
      },
      logs: {
        select: {
          platform: true,
          postedUrl: true,
          postedAt: true,
          postedBy: true,
          notes: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!post) return;

  logBlankFolderFieldsForPost(post);

  let headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${POSTS_TAB}'!1:1`,
  });
  let rawCells = headerRes.data.values?.[0] ?? [];
  let { map, secondaryByCanonical } = buildCanonicalHeaderResolution(rawCells, "Posts tab");

  if (!map.has("UpdatedAt")) {
    const nextRow = [...rawCells.map((c) => normalizeCell(c)), "UpdatedAt"];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${POSTS_TAB}'!1:1`,
      valueInputOption: "RAW",
      requestBody: { values: [nextRow] },
    });
    console.log(`[contentops] Posts tab: appended missing header "UpdatedAt" at column ${nextRow.length}`);
    headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${POSTS_TAB}'!1:1`,
    });
    rawCells = headerRes.data.values?.[0] ?? [];
    ({ map, secondaryByCanonical } = buildCanonicalHeaderResolution(rawCells, "Posts tab", { logAliases: false }));
  }

  const isMissingPostsHeader = (header: (typeof POSTS_HEADERS)[number]): boolean => {
    if (header === "PlatformsCSV") {
      // For Posts tab only, either PlatformsCSV or Platforms satisfies platform CSV presence.
      return !map.has("PlatformsCSV") && !map.has("Platforms");
    }
    return !map.has(header);
  };

  let missingPosts = POSTS_HEADERS.filter((h) => isMissingPostsHeader(h));
  if (missingPosts.length > 0) {
    const nextRow = [...rawCells.map((c) => normalizeCell(c)), ...missingPosts];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${POSTS_TAB}'!1:1`,
      valueInputOption: "RAW",
      requestBody: { values: [nextRow] },
    });
    console.log(`[contentops] Posts tab: appended missing headers ${missingPosts.join(", ")}`);
    headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${POSTS_TAB}'!1:1`,
    });
    rawCells = headerRes.data.values?.[0] ?? [];
    ({ map, secondaryByCanonical } = buildCanonicalHeaderResolution(rawCells, "Posts tab", { logAliases: false }));
    missingPosts = POSTS_HEADERS.filter((h) => isMissingPostsHeader(h));
    if (missingPosts.length > 0) {
      const msg = `[contentops] Posts tab: missing required headers [${missingPosts.join(", ")}]`;
      console.error(msg);
      throw new Error(`Missing required Posts headers: ${missingPosts.join(", ")}`);
    }
  }

  const sheetResPosts = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${POSTS_TAB}'`,
  });
  let sheetRowsPosts = (sheetResPosts.data.values ?? []).map((row) => row.map((v) => normalizeCell(v)));
  if (sheetRowsPosts.length === 0) {
    sheetRowsPosts = [rawCells.map((c) => normalizeCell(c))];
  }
  ({ map, secondaryByCanonical } = buildCanonicalHeaderResolution(sheetRowsPosts[0], "Posts tab", { logAliases: false }));
  await repairSheetTabDuplicateColumnData(
    sheets,
    spreadsheetId,
    POSTS_TAB,
    "Posts tab",
    sheetRowsPosts,
    map,
    secondaryByCanonical,
  );

  const headerRow = (sheetRowsPosts[0] ?? []).map((c) => normalizeCell(c));
  if (map.get("PostId") == null) {
    throw new Error("Posts tab: PostId column not found after alias resolution");
  }
  const exactRowIndex = sheetRowsPosts.slice(1).findIndex((row) => getRowValue(row, map, "PostId") === post.id);
  const existingRow =
    exactRowIndex >= 0
      ? [...(sheetRowsPosts[exactRowIndex + 1] ?? [])]
      : [];
  while (existingRow.length < headerRow.length) existingRow.push("");

  const valueByHeader = new Map<string, string>([
    ["PostId", post.id],
    ["CreatedAt", post.createdAt.toISOString()],
    ["CreatedBy", ""],
    ["Status", post.status],
    ["UpdatedAt", post.updatedAt.toISOString()],
    ["MachineFamily", post.machineFamily],
    ["MachineModel", post.machineModel ?? ""],
    ["Topic", post.topic],
    ["Location", post.location ?? ""],
    ["AssetCount", String(post._count.assets)],
    ["LibraryFolderId", post.libraryFolderId ?? ""],
    ["LibraryFolderURL", post.libraryFolderUrl ?? ""],
    ["ByDateShortcutURL", post.byDateShortcutUrl ?? ""],
    ["ByMachineShortcutURL", post.byMachineShortcutUrl ?? ""],
  ]);

  const platformsJoined = post.platforms.join(",");
  if (map.has("PlatformsCSV")) valueByHeader.set("PlatformsCSV", platformsJoined);
  if (map.has("Platforms")) valueByHeader.set("Platforms", platformsJoined);

  const draftByPlatform = new Map(post.drafts.map((d) => [d.platform, d]));
  const optionalDraftCols: [string, string][] = [
    ["Caption_FB", draftByPlatform.get("FB")?.caption ?? ""],
    ["Hashtags_FB", draftByPlatform.get("FB")?.hashtags ?? ""],
    ["Caption_IG", draftByPlatform.get("IG")?.caption ?? ""],
    ["Hashtags_IG", draftByPlatform.get("IG")?.hashtags ?? ""],
    ["Caption_TikTok", draftByPlatform.get("TIKTOK")?.caption ?? ""],
    ["Hashtags_TikTok", draftByPlatform.get("TIKTOK")?.hashtags ?? ""],
    ["Title_YouTube", draftByPlatform.get("YOUTUBE")?.title ?? ""],
    ["Description_YouTube", draftByPlatform.get("YOUTUBE")?.description ?? ""],
  ];
  for (const [col, val] of optionalDraftCols) {
    if (map.has(col)) valueByHeader.set(col, val);
  }

  const logByPlatform = new Map(post.logs.map((log) => [log.platform, log]));
  const platformLogs = POSTING_LOG_PLATFORM_ORDER
    .map((platform) => logByPlatform.get(platform))
    .filter((log): log is NonNullable<(typeof post.logs)[number]> => log != null);
  let appliedPostingLogMirrorFields = false;
  const markPostedMirror = () => {
    appliedPostingLogMirrorFields = true;
  };

  const postedUrlPairs: [string, string, string][] = [
    ["FB", "FB_Post_URL", "FB_Url"],
    ["IG", "IG_Post_URL", "IG_Url"],
    ["TIKTOK", "TikTok_Post_URL", "TikTok_Url"],
    ["YOUTUBE", "YouTube_Video_URL", "YouTube_Url"],
    ["WEBSITE", "Website_Post_URL", "Website_Url"],
  ];
  for (const [platformKey, primaryUrlCol, legacyUrlCol] of postedUrlPairs) {
    const url = logByPlatform.get(platformKey)?.postedUrl ?? "";
    for (const col of [primaryUrlCol, legacyUrlCol]) {
      if (map.has(col)) {
        valueByHeader.set(col, url);
        markPostedMirror();
      }
    }
  }

  const postedDates = platformLogs.map((l) => l.postedAt).filter((d): d is Date => d != null);
  if (postedDates.length > 0 && map.has("PostedAt")) {
    postedDates.sort((a, b) => b.getTime() - a.getTime());
    valueByHeader.set("PostedAt", postedDates[0]!.toISOString());
    markPostedMirror();
  }

  let firstPostedBy = "";
  for (const log of platformLogs) {
    const pb = log.postedBy?.trim();
    if (pb) {
      firstPostedBy = pb;
      break;
    }
  }
  if (firstPostedBy && map.has("PostedBy")) {
    valueByHeader.set("PostedBy", firstPostedBy);
    markPostedMirror();
  }

  const existingNotesCell = getRowValue(existingRow, map, "Notes").trim();
  if (map.has("Notes") && !existingNotesCell) {
    const preferredNoteFromLogs =
      logByPlatform.get("FB")?.notes?.trim() ||
      logByPlatform.get("IG")?.notes?.trim() ||
      logByPlatform.get("TIKTOK")?.notes?.trim() ||
      logByPlatform.get("YOUTUBE")?.notes?.trim() ||
      logByPlatform.get("WEBSITE")?.notes?.trim() ||
      platformLogs.find((log) => (log.notes ?? "").trim().length > 0)?.notes?.trim() ||
      "";
    if (preferredNoteFromLogs) {
      valueByHeader.set("Notes", preferredNoteFromLogs);
      markPostedMirror();
    }
  }

  if (appliedPostingLogMirrorFields) {
    console.log(`[contentops] Posts tab: updated posted fields for post ${post.id}`);
  }

  if (exactRowIndex >= 0) {
    const rowNumber = exactRowIndex + 2;
    const outputRow = mergeRowWithValueMap(headerRow, map, existingRow, valueByHeader, secondaryByCanonical);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${POSTS_TAB}'!${rowNumber}:${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [outputRow] },
    });
    sheetRowsPosts[exactRowIndex + 1] = outputRow;
    console.log(`[contentops] Posts tab: upserted row for post ${post.id}`);
    return;
  }

  const outputRow = mergeRowWithValueMap(
    headerRow,
    map,
    Array.from({ length: headerRow.length }, () => ""),
    valueByHeader,
    secondaryByCanonical,
  );
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${POSTS_TAB}'`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [outputRow] },
  });
  sheetRowsPosts.push(outputRow);
  console.log(`[contentops] Posts tab: upserted row for post ${post.id}`);
}

export async function upsertAssetsRows(postId: string): Promise<void> {
  const spreadsheetId = getMasterSheetId();
  if (!spreadsheetId) return;

  const sheets = getSheetsClient();
  await assertTabExists(sheets, spreadsheetId, ASSETS_TAB, "Assets tab");

  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: {
      assets: { orderBy: [{ id: "asc" }] },
    },
  });
  if (!post) return;

  logBlankFolderFieldsForPost(post);

  let headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${ASSETS_TAB}'!1:1`,
  });
  let rawCells = headerRes.data.values?.[0] ?? [];
  let { map, secondaryByCanonical } = buildCanonicalHeaderResolution(rawCells, "Assets tab");

  let missingAssets = ASSETS_HEADERS.filter((h) => !map.has(h));
  if (missingAssets.length > 0) {
    const nextRow = [...rawCells.map((c) => normalizeCell(c)), ...missingAssets];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${ASSETS_TAB}'!1:1`,
      valueInputOption: "RAW",
      requestBody: { values: [nextRow] },
    });
    console.log(`[contentops] Assets tab: appended missing headers ${missingAssets.join(", ")}`);
    headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${ASSETS_TAB}'!1:1`,
    });
    rawCells = headerRes.data.values?.[0] ?? [];
    ({ map, secondaryByCanonical } = buildCanonicalHeaderResolution(rawCells, "Assets tab", { logAliases: false }));
    missingAssets = ASSETS_HEADERS.filter((h) => !map.has(h));
    if (missingAssets.length > 0) {
      const msg = `[contentops] Assets tab: missing required headers [${missingAssets.join(", ")}]`;
      console.error(msg);
      throw new Error(`Missing required Assets headers: ${missingAssets.join(", ")}`);
    }
  }

  const sheetResAssets = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${ASSETS_TAB}'`,
  });
  let sheetRowsAssets = (sheetResAssets.data.values ?? []).map((row) => row.map((v) => normalizeCell(v)));
  if (sheetRowsAssets.length === 0) {
    sheetRowsAssets = [rawCells.map((c) => normalizeCell(c))];
  }
  ({ map, secondaryByCanonical } = buildCanonicalHeaderResolution(sheetRowsAssets[0], "Assets tab", { logAliases: false }));
  await repairSheetTabDuplicateColumnData(
    sheets,
    spreadsheetId,
    ASSETS_TAB,
    "Assets tab",
    sheetRowsAssets,
    map,
    secondaryByCanonical,
  );

  const headerRow = (sheetRowsAssets[0] ?? []).map((c) => normalizeCell(c));
  if (map.get("AssetId") == null) {
    throw new Error("Assets tab: AssetId column not found after alias resolution");
  }

  for (const asset of post.assets) {
    const exactRowIndex = sheetRowsAssets.slice(1).findIndex((row) => getRowValue(row, map, "AssetId") === asset.id);
    const existingRow =
      exactRowIndex >= 0 ? [...(sheetRowsAssets[exactRowIndex + 1] ?? [])] : [];
    while (existingRow.length < headerRow.length) existingRow.push("");

    const valueByHeader = new Map<string, string>([
      ["PostId", post.id],
      ["AssetId", asset.id],
      ["CreatedAt", asset.createdAt.toISOString()],
      ["DriveFileId", asset.driveFileId],
      ["OriginalName", asset.originalName],
      ["FinalName", asset.finalName],
      ["MimeType", asset.mimeType],
      ["WebViewLink", asset.webViewLink ?? ""],
      ["ThumbnailLink", asset.thumbnailLink ?? ""],
      ["LibraryFolderId", post.libraryFolderId ?? ""],
      ["LibraryFolderURL", post.libraryFolderUrl ?? ""],
      ["ByDateShortcutURL", post.byDateShortcutUrl ?? ""],
      ["ByMachineShortcutURL", post.byMachineShortcutUrl ?? ""],
    ]);

    if (map.has("FileType")) valueByHeader.set("FileType", asset.mimeType.split("/")[0] ?? "");
    if (map.has("SizeBytes")) valueByHeader.set("SizeBytes", asset.size != null ? String(asset.size) : "");
    if (map.has("MachineFamily")) valueByHeader.set("MachineFamily", post.machineFamily);
    if (map.has("MachineModel")) valueByHeader.set("MachineModel", post.machineModel ?? "");
    if (map.has("Topic")) valueByHeader.set("Topic", post.topic);

    if (exactRowIndex >= 0) {
      const rowNumber = exactRowIndex + 2;
      const outputRow = mergeRowWithValueMap(headerRow, map, existingRow, valueByHeader, secondaryByCanonical);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${ASSETS_TAB}'!${rowNumber}:${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: { values: [outputRow] },
      });
      sheetRowsAssets[exactRowIndex + 1] = outputRow;
      console.log(`[contentops] Assets tab: upserted row for asset ${asset.id}`);
    } else {
      const outputRow = mergeRowWithValueMap(
        headerRow,
        map,
        Array.from({ length: headerRow.length }, () => ""),
        valueByHeader,
        secondaryByCanonical,
      );
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `'${ASSETS_TAB}'`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [outputRow] },
      });
      sheetRowsAssets.push(outputRow);
      console.log(`[contentops] Assets tab: upserted row for asset ${asset.id}`);
    }
  }
}

/**
 * Runs PostingLog upsert (which also refreshes the Posts row), then optionally Assets rows.
 * Returns true if any step threw (each failure is logged).
 */
export async function syncMasterSheetForPost(postId: string, options?: { includeAssets?: boolean }): Promise<boolean> {
  let failed = false;
  const run = async (stepLabel: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[contentops] sheet sync step failed: ${stepLabel}`, err instanceof Error ? err.message : err);
      logContentOpsSheetSyncFailed(err);
      failed = true;
    }
  };
  await run("PostingLog mirror", () => upsertPostingLogRow(postId));
  if (options?.includeAssets !== false) {
    await run("Assets tab", () => upsertAssetsRows(postId));
  }
  return failed;
}

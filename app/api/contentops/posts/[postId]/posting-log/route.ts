import { NextResponse } from "next/server";
import { z } from "zod";
import { assertContentOpsRequest } from "@/lib/contentops-auth";
import { upsertPostingLogRow } from "@/lib/googleSheets";
import { prisma } from "@/lib/prisma";

const PLATFORM_IDS = ["FB", "IG", "TIKTOK", "YOUTUBE", "WEBSITE"] as const;

/** Normalize optional posting URL; throws if a non-blank value is not a valid URL after https prepending. */
function normalizeOptionalPostedUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("INVALID_POSTED_URL");
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  new URL(withScheme);
  return withScheme;
}

const EntrySchema = z.object({
  postedUrl: z.union([z.string(), z.null()]).optional(),
  postedAt: z.string().datetime().optional().nullable(),
  postedBy: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const BodySchema = z.object({
  entries: z.record(z.enum(PLATFORM_IDS), EntrySchema.partial()),
});

type Ctx = { params: Promise<{ postId: string }> };

async function getPayload(postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, platforms: true } });
  if (!post) return null;

  const rows = await prisma.postingLog.findMany({
    where: { postId, platform: { in: PLATFORM_IDS as unknown as string[] } },
    orderBy: [{ platform: "asc" }],
  });

  const entries = Object.fromEntries(
    rows.map((r: { platform: string; postedUrl: string | null; postedAt: Date | null; postedBy: string | null; notes: string | null; updatedAt: Date }) => [
      r.platform,
      {
        postedUrl: r.postedUrl,
        postedAt: r.postedAt,
        postedBy: r.postedBy,
        notes: r.notes,
        updatedAt: r.updatedAt,
      },
    ]),
  );

  return { entries, selectedPlatforms: post.platforms };
}

export async function GET(request: Request, context: Ctx) {
  try {
    await assertContentOpsRequest(request);
  } catch (e) {
    const code = (e as Error & { statusCode?: number }).statusCode;
    if (code === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const { postId } = await context.params;
  const payload = await getPayload(postId);
  if (!payload) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(payload);
}

async function save(request: Request, context: Ctx) {
  try {
    await assertContentOpsRequest(request);
  } catch (e) {
    const code = (e as Error & { statusCode?: number }).statusCode;
    if (code === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const { postId } = await context.params;
  const exists = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  const issues: { platform: (typeof PLATFORM_IDS)[number]; field: "postedUrl"; message: "Invalid URL" }[] = [];
  for (const platform of PLATFORM_IDS) {
    const payload = parsed.data.entries[platform];
    if (!payload || payload.postedUrl === undefined) continue;
    try {
      normalizeOptionalPostedUrl(payload.postedUrl);
    } catch {
      issues.push({ platform, field: "postedUrl", message: "Invalid URL" });
    }
  }
  if (issues.length > 0) {
    return NextResponse.json({ error: "Invalid posting log URL", issues }, { status: 400 });
  }

  const submittedPlatforms = Object.keys(parsed.data.entries).filter((p): p is (typeof PLATFORM_IDS)[number] =>
    (PLATFORM_IDS as readonly string[]).includes(p),
  );
  const existingRows = await prisma.postingLog.findMany({
    where: { postId, platform: { in: submittedPlatforms } },
    select: { platform: true, postedAt: true },
  });
  const existingByPlatform = new Map(existingRows.map((r) => [r.platform, r]));

  for (const [platform, payload] of Object.entries(parsed.data.entries)) {
    const normalizedPostedUrl =
      payload.postedUrl === undefined ? undefined : normalizeOptionalPostedUrl(payload.postedUrl);
    const existingPostedAt = existingByPlatform.get(platform)?.postedAt ?? null;

    let postedAtForUpdate: Date | undefined | null;
    if (payload.postedAt !== undefined) {
      postedAtForUpdate = payload.postedAt ? new Date(payload.postedAt) : null;
    } else if (normalizedPostedUrl && existingPostedAt == null) {
      postedAtForUpdate = new Date();
    } else {
      postedAtForUpdate = undefined;
    }

    let postedAtForCreate: Date | null;
    if (payload.postedAt) {
      postedAtForCreate = new Date(payload.postedAt);
    } else if (normalizedPostedUrl) {
      postedAtForCreate = new Date();
    } else {
      postedAtForCreate = null;
    }

    await prisma.postingLog.upsert({
      where: { postId_platform: { postId, platform } },
      create: {
        postId,
        platform,
        postedUrl: normalizedPostedUrl ?? null,
        postedAt: postedAtForCreate,
        postedBy: payload.postedBy ?? null,
        notes: payload.notes ?? null,
      },
      update: {
        postedUrl: normalizedPostedUrl === undefined ? undefined : normalizedPostedUrl,
        postedAt: postedAtForUpdate,
        postedBy: payload.postedBy === undefined ? undefined : payload.postedBy,
        notes: payload.notes === undefined ? undefined : payload.notes,
      },
    });
  }

  let sheetSyncFailed = false;
  try {
    await upsertPostingLogRow(postId);
  } catch (sheetError) {
    console.warn("[contentops] Sheets sync failed after posting-log update:", sheetError);
    sheetSyncFailed = true;
  }

  const data = await getPayload(postId);
  return NextResponse.json({ ...data, sheetSyncFailed });
}

export async function POST(request: Request, context: Ctx) {
  return save(request, context);
}

export async function PUT(request: Request, context: Ctx) {
  return save(request, context);
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { assertContentOpsRequest } from "@/lib/contentops-auth";
import { upsertPostingLogRow } from "@/lib/googleSheets";
import { prisma } from "@/lib/prisma";

const PLATFORM_IDS = ["FB", "IG", "TIKTOK", "YOUTUBE", "WEBSITE"] as const;

const EntrySchema = z.object({
  postedUrl: z.string().url().optional().nullable(),
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

  for (const [platform, payload] of Object.entries(parsed.data.entries)) {
    await prisma.postingLog.upsert({
      where: { postId_platform: { postId, platform } },
      create: {
        postId,
        platform,
        postedUrl: payload.postedUrl ?? null,
        postedAt: payload.postedAt ? new Date(payload.postedAt) : payload.postedUrl ? new Date() : null,
        postedBy: payload.postedBy ?? null,
        notes: payload.notes ?? null,
      },
      update: {
        postedUrl: payload.postedUrl === undefined ? undefined : payload.postedUrl,
        postedAt: payload.postedAt === undefined ? undefined : payload.postedAt ? new Date(payload.postedAt) : null,
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

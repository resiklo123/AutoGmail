import { NextResponse } from "next/server";
import { z } from "zod";
import { assertContentOpsRequest } from "@/lib/contentops-auth";
import { upsertPostingLogRow } from "@/lib/googleSheets";
import { prisma } from "@/lib/prisma";

const POST_STATUS_VALUES = ["PROCESSING", "DRAFT_READY", "DRAFT", "POSTED", "ARCHIVED", "FAILED"] as const;

const Body = z.object({
  status: z.enum(POST_STATUS_VALUES),
  postedUrl: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

type Ctx = { params: Promise<{ postId: string }> };

export async function POST(request: Request, context: Ctx) {
  try {
    await assertContentOpsRequest(request);
  } catch (e) {
    const code = (e as Error & { statusCode?: number }).statusCode;
    if (code === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const { postId } = await context.params;
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  const exists = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.post.update({ where: { id: postId }, data: { status: parsed.data.status } });

  if (parsed.data.status === "POSTED" && (parsed.data.postedUrl || parsed.data.notes)) {
    await prisma.postingLog.upsert({
      where: { postId_platform: { postId, platform: "MANUAL" } },
      create: {
        postId,
        platform: "MANUAL",
        postedUrl: parsed.data.postedUrl ?? null,
        postedAt: new Date(),
        notes: parsed.data.notes ?? null,
      },
      update: {
        postedUrl: parsed.data.postedUrl ?? null,
        postedAt: new Date(),
        notes: parsed.data.notes ?? null,
      },
    });
  }

  let sheetSyncFailed = false;
  try {
    await upsertPostingLogRow(postId);
  } catch (sheetError) {
    console.warn("[contentops] Sheets sync failed after status update:", sheetError);
    sheetSyncFailed = true;
  }

  return NextResponse.json({ ok: true, sheetSyncFailed });
}
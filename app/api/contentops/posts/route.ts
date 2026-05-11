import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertContentOpsRequest } from "@/lib/contentops-auth";
import { processNewContentOpsPost } from "@/lib/contentops-post-processor";

const Body = z.object({
  machineFamily: z.string().min(1),
  machineModel: z.string().optional().nullable(),
  topic: z.string().min(1),
  location: z.string().optional().nullable(),
  platforms: z.array(z.string()).min(1),
  driveFileIds: z.array(z.string()).min(1),
});

export async function POST(request: Request) {
  try {
    await assertContentOpsRequest(request);
  } catch (e) {
    const code = (e as Error & { statusCode?: number }).statusCode;
    if (code === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

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

  try {
    const { postId, sheetSyncFailed } = await processNewContentOpsPost(parsed.data);
    return NextResponse.json({ postId, sheetSyncFailed: !!sheetSyncFailed });
  } catch (e) {
    console.error("[contentops] POST /posts failed:", e);
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2022") {
      const column =
        e.meta && typeof e.meta === "object" && "column" in e.meta
          ? (e.meta as { column: unknown }).column
          : undefined;
      const body =
        column !== undefined
          ? {
              ok: false as const,
              error: "schema_drift" as const,
              code: "P2022" as const,
              meta: { column },
            }
          : { ok: false as const, error: "schema_drift" as const, code: "P2022" as const };
      return NextResponse.json(body, { status: 500 });
    }
    return NextResponse.json({ error: "Processing failed" }, { status: 502 });
  }
}
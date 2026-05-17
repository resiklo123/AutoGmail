import { NextResponse } from "next/server";
import { assertContentOpsRequest } from "@/lib/contentops-auth";
import { serializeUploadBatchDetail } from "@/lib/contentops-serialize";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ batchId: string }> };

export async function GET(request: Request, context: Ctx) {
  try {
    await assertContentOpsRequest(request);
  } catch (e) {
    const code = (e as Error & { statusCode?: number }).statusCode;
    if (code === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const { batchId: param } = await context.params;
  const batch = await prisma.uploadBatch.findFirst({
    where: { OR: [{ id: param }, { batchCode: param }] },
    include: {
      assets: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(serializeUploadBatchDetail(batch));
}

import { NextResponse } from "next/server";
import { assertContentOpsRequest } from "@/lib/contentops-auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  try {
    await assertContentOpsRequest(request);
  } catch (e) {
    const code = (e as Error & { statusCode?: number }).statusCode;
    if (code === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const url = new URL(request.url);
  const take = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 40));

  const batches = await prisma.uploadBatch.findMany({
    orderBy: { uploadedAt: "desc" },
    take,
    select: {
      id: true,
      batchCode: true,
      uploadedAt: true,
      uploadedBy: true,
      machineFamily: true,
      machineModel: true,
      topic: true,
      location: true,
      fileCount: true,
      reviewStatus: true,
      metadataSource: true,
      driveFolderUrl: true,
      notes: true,
    },
  });

  return NextResponse.json({ batches });
}

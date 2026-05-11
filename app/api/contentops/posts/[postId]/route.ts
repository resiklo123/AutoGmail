import { NextResponse } from "next/server";
import { assertContentOpsRequest } from "@/lib/contentops-auth";
import { prisma } from "@/lib/prisma";
import { serializePostDetail } from "@/lib/contentops-serialize";

type Ctx = { params: Promise<{ postId: string }> };

export async function GET(request: Request, context: Ctx) {
  try {
    await assertContentOpsRequest(request);
  } catch (e) {
    const code = (e as Error & { statusCode?: number }).statusCode;
    if (code === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }
  const { postId } = await context.params;
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: { assets: true, drafts: true, logs: true },
  });
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(serializePostDetail(post));
}

import { NextResponse } from "next/server";
import { assertContentOpsRequest } from "@/lib/contentops-auth";
import { prisma } from "@/lib/prisma";

const ORDERED = ["FB", "IG", "TIKTOK", "YOUTUBE", "WEBSITE"] as const;

function badgeFor(platforms: string[], entries: { platform: string; postedUrl: string | null }[]): string {
  const required = ORDERED.filter((p) => platforms.map((x) => x.toUpperCase()).includes(p));
  const posted = required.filter((p) => entries.some((e) => e.platform === p && !!e.postedUrl?.trim()));
  if (required.length > 0 && posted.length === required.length) return "Fully posted";
  if (posted.length > 0) return "Posted";
  return "Draft ready";
}

export async function GET(request: Request) {
  try {
    await assertContentOpsRequest(request);
  } catch (e) {
    const code = (e as Error & { statusCode?: number }).statusCode;
    if (code === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const posts = await prisma.post.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      logs: {
        where: { platform: { in: ORDERED as unknown as string[] } },
        select: { platform: true, postedUrl: true },
      },
    },
  });

  return NextResponse.json({
    posts: posts.map((p: {
      id: string;
      slug: string;
      machineFamily: string;
      machineModel: string | null;
      topic: string;
      status: string;
      createdAt: Date;
      platforms: string[];
      logs: { platform: string; postedUrl: string | null }[];
    }) => ({
      id: p.id,
      slug: p.slug,
      machineFamily: p.machineFamily,
      machineModel: p.machineModel,
      topic: p.topic,
      status: p.status,
      createdAt: p.createdAt,
      badge: badgeFor(p.platforms, p.logs),
    })),
  });
}

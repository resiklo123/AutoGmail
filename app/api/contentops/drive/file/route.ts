import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import { requireContentOpsAuth } from "@/lib/contentops-auth";
import { getDriveClient } from "@/lib/google-drive";

function authErrorResponse(e: unknown): NextResponse {
  const code = (e as Error & { statusCode?: number }).statusCode;
  if (code === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    await requireContentOpsAuth(request);
  } catch (e) {
    return authErrorResponse(e);
  }

  const url = new URL(request.url);
  const fileId = url.searchParams.get("id")?.trim();
  if (!fileId) {
    return NextResponse.json({ error: "Missing drive file id" }, { status: 400 });
  }

  try {
    const drive = getDriveClient();
    const meta = await drive.files.get({
      fileId,
      fields: "mimeType,name",
      supportsAllDrives: true,
    });

    const mimeType = meta.data.mimeType ?? "application/octet-stream";
    if (!mimeType.startsWith("image/")) {
      return new NextResponse("Preview only supports image files", {
        status: 415,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "private, max-age=60",
        },
      });
    }

    const media = await drive.files.get(
      {
        fileId,
        alt: "media",
        supportsAllDrives: true,
      },
      { responseType: "stream" },
    );

    const stream = media.data as Readable;
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (e) {
    console.error("[contentops] GET /drive/file failed:", e);
    return NextResponse.json({ error: "Processing failed" }, { status: 502 });
  }
}

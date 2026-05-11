import { NextResponse } from "next/server";
import { assertContentOpsRequest } from "@/lib/contentops-auth";
import { listIncomingFiles } from "@/lib/google-drive";

export async function GET(request: Request) {
  try {
    await assertContentOpsRequest(request);
  } catch (e) {
    const code = (e as Error & { statusCode?: number }).statusCode;
    if (code === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }
  try {
    const files = await listIncomingFiles(50);
    return NextResponse.json({ files });
  } catch (e) {
    console.error("[contentops] GET /incoming failed:", e);
    return NextResponse.json({ error: "Processing failed" }, { status: 502 });
  }
}

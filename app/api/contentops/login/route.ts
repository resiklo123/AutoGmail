import { NextResponse } from "next/server";
import { z } from "zod";
import { CONTENTOPS_SESSION_COOKIE, mintSessionCookieValue, verifyContentOpsPasscode } from "@/lib/contentops-auth";
import { cookies } from "next/headers";

const Body = z.object({
  passcode: z.string().min(1),
});

export async function POST(request: Request) {
  if (!process.env.CONTENTOPS_PASSCODE) {
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
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!verifyContentOpsPasscode(parsed.data.passcode)) {
    return NextResponse.json({ error: "Invalid passcode" }, { status: 401 });
  }
  const store = await cookies();
  store.set(CONTENTOPS_SESSION_COOKIE, mintSessionCookieValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });
  return NextResponse.json({ ok: true });
}

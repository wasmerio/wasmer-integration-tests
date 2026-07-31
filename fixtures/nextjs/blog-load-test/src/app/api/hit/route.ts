import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const path = new URL(request.url).searchParams.get("path") ?? "/";
  const hit = await prisma.pageView.create({ data: { path } });
  return NextResponse.json({ id: hit.id });
}

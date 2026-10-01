import { NextResponse, type NextRequest } from "next/server";

// No matcher, so Next.js also runs this for absolute paths outside basePath.
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set(
    "x-mw",
    `${request.nextUrl.basePath || "(none)"}|${request.nextUrl.pathname}`,
  );
  return response;
}

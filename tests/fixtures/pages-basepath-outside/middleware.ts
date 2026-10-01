import { NextResponse, type NextRequest } from "next/server";

// No matcher, so Next.js also runs this for absolute paths outside basePath.
export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/echo") {
    return NextResponse.json({
      basePath: request.nextUrl.basePath,
      pathname: request.nextUrl.pathname,
    });
  }
  return NextResponse.next();
}

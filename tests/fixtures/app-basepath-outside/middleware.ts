import { NextResponse, type NextRequest } from "next/server";

// No matcher, so Next.js also runs this for absolute paths outside basePath.
export function middleware(request: NextRequest) {
  const { basePath, pathname } = request.nextUrl;
  const response =
    !basePath && pathname === "/mw-rewrite-outside"
      ? NextResponse.rewrite(new URL("/base/hello", request.url))
      : NextResponse.next();
  response.headers.set("x-mw", `${basePath || "(none)"}|${pathname}`);
  return response;
}

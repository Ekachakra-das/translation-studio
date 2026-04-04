import { NextRequest, NextResponse } from "next/server";

const TRANSLATION_API_TOKEN_COOKIE = "translation_api_token";
const TRANSLATION_API_TOKEN_MAX_AGE = 60 * 60 * 24 * 30;

function getTranslationApiToken(): string | null {
  const token = process.env.TRANSLATION_API_TOKEN?.trim();
  return token && token.length > 0 ? token : null;
}

function shouldSetCookie(request: NextRequest): boolean {
  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith("/api/")) {
    return false;
  }
  if (pathname.startsWith("/_next/")) {
    return false;
  }
  if (pathname === "/favicon.ico") {
    return false;
  }
  return true;
}

export function middleware(request: NextRequest) {
  const token = getTranslationApiToken();
  if (!token || !shouldSetCookie(request)) {
    return NextResponse.next();
  }

  const response = NextResponse.next();
  const currentToken = request.cookies.get(TRANSLATION_API_TOKEN_COOKIE)?.value;
  if (currentToken !== token) {
    response.cookies.set(TRANSLATION_API_TOKEN_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: TRANSLATION_API_TOKEN_MAX_AGE
    });
  }

  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"]
};

import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  // getUser() verifies the JWT with Supabase Auth — more reliable than getSession()
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAuthPage = request.nextUrl.pathname === "/auth";

  // Unauthenticated user hitting a protected route → redirect to /auth
  if (!user && !isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth";
    return NextResponse.redirect(url);
  }

  // Authenticated user hitting /auth → redirect to home
  if (user && isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Run on all paths except Next.js internals and static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

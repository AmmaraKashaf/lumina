/**
 * Auth-aware fetch wrapper.
 * Attaches the Supabase Bearer token to every request automatically.
 * All pages should use this instead of raw `fetch`.
 */
import { createClient } from "./supabase";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers: Record<string, string> = {};

  if (options.headers) {
    Object.assign(headers, options.headers as Record<string, string>);
  }

  if (session?.access_token) {
    headers["Authorization"] = `Bearer ${session.access_token}`;
  }

  // Don't override Content-Type for FormData uploads — browser sets multipart boundary
  if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  return fetch(`${API}${path}`, { ...options, headers });
}

/** Convenience: call apiFetch and redirect to /auth on 401 */
export async function apiFetchOrRedirect(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const res = await apiFetch(path, options);
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = "/auth";
  }
  return res;
}

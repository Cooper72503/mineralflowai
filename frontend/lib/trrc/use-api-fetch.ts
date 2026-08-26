"use client";

/**
 * Shared authenticated-fetch hook for TRRC due diligence pages — extracted
 * from trrc-due-diligence/page.tsx verbatim so the portfolio/bulk page can
 * reuse it without duplicating (and risking drift from) several real,
 * live-confirmed bug fixes:
 *
 *  - Bearer token in a ref, not cookies alone — non-ASCII cookie values
 *    were causing a ByteString error.
 *  - cache: "no-store" — without it the browser served a stale GET
 *    response for a run-status poll indefinitely, confirmed against the
 *    DB showing the run had actually completed.
 *  - credentials: "include" — "omit" silently meant cookies were never
 *    sent as a fallback when bearer auth failed against the deployed site.
 *  - A single refresh-and-retry on a 401 — a long-idle tab's access token
 *    can genuinely expire without onAuthStateChange ever firing.
 */

import { useCallback, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

export function useApiFetch() {
  const tokenRef = useRef<string>("");
  const supabaseRef = useRef(createClient());

  useEffect(() => {
    const supabase = supabaseRef.current;
    supabase.auth.getSession().then(({ data }) => {
      tokenRef.current = data.session?.access_token ?? "";
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      tokenRef.current = session?.access_token ?? "";
    });
    return () => subscription.unsubscribe();
  }, []);

  return useCallback(async (url: string, init: RequestInit = {}) => {
    const doFetch = (token: string) => {
      const headers: Record<string, string> = {
        ...(init.headers as Record<string, string> ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      return fetch(url, { ...init, credentials: "include", headers, cache: init.cache ?? "no-store" });
    };

    const res = await doFetch(tokenRef.current);
    if (res.status !== 401) return res;

    const { data, error: refreshError } = await supabaseRef.current.auth.refreshSession();
    if (refreshError || !data.session?.access_token) return res;
    tokenRef.current = data.session.access_token;
    return doFetch(tokenRef.current);
  }, []);
}

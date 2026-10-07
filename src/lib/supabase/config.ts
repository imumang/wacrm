const LOCAL_SUPABASE_PROXY_PATH = "/supabase";

export function getServerSupabaseUrl() {
  return (
    process.env.SUPABASE_INTERNAL_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!
  ).replace(/\/$/, "");
}

export function getSupabaseAuthCookieName(url = getServerSupabaseUrl()) {
  return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
}

export function getBrowserSupabaseUrl(origin?: string) {
  const browserOrigin =
    origin ?? (typeof window === "undefined" ? undefined : window.location.origin);

  const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;

  if (!browserOrigin || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(configuredUrl)) {
    return configuredUrl.replace(/\/$/, "");
  }

  return new URL(LOCAL_SUPABASE_PROXY_PATH, browserOrigin).toString().replace(/\/$/, "");
}

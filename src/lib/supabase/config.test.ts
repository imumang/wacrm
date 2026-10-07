import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getBrowserSupabaseUrl,
  getServerSupabaseUrl,
  getSupabaseAuthCookieName,
} from "./config";

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
});

afterEach(() => {
  if (originalUrl === undefined) {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  } else {
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  }
});

describe("Supabase client configuration", () => {
  it("routes browser traffic through the current HTTPS app origin", () => {
    expect(getBrowserSupabaseUrl("https://chat.clearwasteremoval.uk")).toBe(
      "https://chat.clearwasteremoval.uk/supabase",
    );
  });

  it("routes localhost browser traffic through the local app origin", () => {
    expect(getBrowserSupabaseUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/supabase",
    );
  });

  it("keeps the private Supabase URL for server rendering", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    expect(getServerSupabaseUrl()).toBe("http://127.0.0.1:54321");
  });

  it("preserves Supabase's existing cookie name for the private URL", () => {
    expect(getSupabaseAuthCookieName("http://127.0.0.1:54321")).toBe(
      "sb-127-auth-token",
    );
  });

  it("does not proxy an already-public Supabase URL", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    expect(getBrowserSupabaseUrl("https://chat.clearwasteremoval.uk")).toBe(
      "https://project.supabase.co",
    );
  });
});

import { supabase } from "./supabase";

const API_URL = process.env.EXPO_PUBLIC_API_URL;

if (!API_URL) {
  throw new Error("Missing EXPO_PUBLIC_API_URL — see .env (backend base URL, e.g. http://localhost:8000).");
}

// Mirrors backends/api/app/adaptation_vocabulary.py's AdaptationProposal — field names match
// exactly (snake_case) since this is the raw JSON the backend returns, not remapped client-side.
export type AdaptationProposal = {
  font_scale: number;
  line_spacing: "normal" | "relaxed" | "loose";
  letter_spacing: "normal" | "wide";
  contrast_mode: "none" | "high" | "dark";
  reduce_motion: boolean;
  touch_target_boost: boolean;
  reading_mode: boolean;
  rationale: string;
};

async function authHeader(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in — no Supabase session to authenticate the backend call.");
  return `Bearer ${token}`;
}

// POST /profile/refresh (docs/ARCHITECTURE.md §3 steps 4-6): merges evidence_log into
// capability_profile, proposes + validates a Layer A adaptation. Returns null when there's
// no evidence yet to reason over (backend responds 204), which is a normal, expected state
// — not an error — for a user who hasn't played any mini-game yet.
export async function refreshProfile(): Promise<AdaptationProposal | null> {
  const response = await fetch(`${API_URL}/profile/refresh`, {
    method: "POST",
    headers: { Authorization: await authHeader() },
  });

  if (response.status === 204) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`profile/refresh failed (${response.status}): ${body}`);
  }
  return (await response.json()) as AdaptationProposal;
}

// GET /me/adaptation — cheap reuse path: rereads whatever was last accepted, no LLM call.
// Call this on normal app opens/reopens; reserve refreshProfile() (which does invoke the
// LLM) for when there's genuinely new evidence to reason over, e.g. right after finishing
// the mini-games. Also doubles as "has this user already been profiled at least once?" —
// App.tsx uses a non-null result here to decide whether to skip onboarding.
export async function getLatestAdaptation(): Promise<AdaptationProposal | null> {
  const response = await fetch(`${API_URL}/me/adaptation`, {
    headers: { Authorization: await authHeader() },
  });

  if (response.status === 204) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`me/adaptation failed (${response.status}): ${body}`);
  }
  return (await response.json()) as AdaptationProposal;
}

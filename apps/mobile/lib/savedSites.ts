import { supabase } from "./supabase";

export type SavedSite = {
  id: string;
  url: string;
  label: string;
  position: number;
};

// A small real starting set so the "VOS SITES" grid isn't empty on first use — French
// administrative/utility sites plus one common one, editable/removable immediately (not a
// fixed list baked into the UI). Seeded once per user, client-side, the first time their
// saved_sites list is empty; never re-seeded after that even if the user deletes everything.
const STARTER_SITES: Omit<SavedSite, "id">[] = [
  { url: "https://www.service-public.fr", label: "Service-public.fr", position: 0 },
  { url: "https://handicap.gouv.fr", label: "handicap.gouv.fr", position: 1 },
  { url: "https://www.impots.gouv.fr", label: "impots.gouv.fr", position: 2 },
  { url: "https://www.youtube.com", label: "YouTube", position: 3 },
];

export async function listSavedSites(userId: string): Promise<SavedSite[]> {
  const { data, error } = await supabase
    .from("saved_sites")
    .select("id, url, label, position")
    .order("position", { ascending: true });
  if (error) throw error;

  if (data.length === 0) {
    // First visit: seed the starter set, then read back what was actually inserted (not the
    // local STARTER_SITES constants) so callers always get real row ids.
    const { error: seedError } = await supabase
      .from("saved_sites")
      .insert(STARTER_SITES.map((s) => ({ ...s, user_id: userId })));
    if (seedError) throw seedError;

    const { data: seeded, error: reReadError } = await supabase
      .from("saved_sites")
      .select("id, url, label, position")
      .order("position", { ascending: true });
    if (reReadError) throw reReadError;
    return seeded;
  }

  return data;
}

export async function addSavedSite(userId: string, url: string, label: string): Promise<void> {
  const { data: existing, error: countError } = await supabase
    .from("saved_sites")
    .select("position")
    .order("position", { ascending: false })
    .limit(1);
  if (countError) throw countError;

  const nextPosition = existing.length > 0 ? existing[0].position + 1 : 0;
  const { error } = await supabase
    .from("saved_sites")
    .insert({ user_id: userId, url, label, position: nextPosition });
  if (error) throw error;
}

export async function removeSavedSite(siteId: string): Promise<void> {
  const { error } = await supabase.from("saved_sites").delete().eq("id", siteId);
  if (error) throw error;
}

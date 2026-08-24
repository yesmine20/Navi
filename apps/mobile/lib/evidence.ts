import { supabase } from "./supabase";

type Axis = "motor_precision" | "reading_comfort" | "visual_processing_style";

export async function logEvidence(
  userId: string,
  axis: Axis,
  payload: Record<string, unknown>
) {
  // Direct write to evidence_log, RLS-scoped by the caller's own session — no backend
  // round trip needed for this table (docs/ARCHITECTURE.md §2: "Mobile (sync queue)").
  const { error } = await supabase.from("evidence_log").insert({
    user_id: userId,
    source: "mini_game",
    axis,
    payload,
  });
  if (error) throw error;
}

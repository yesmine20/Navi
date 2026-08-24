-- Navi v2 — initial schema (docs/ARCHITECTURE.md §2, principles #2-4 in §0)
-- 3 app tables + auth.users (Supabase-managed). RLS enforced via auth.uid() on every table.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- capability_profile — one row per user per axis. Score + trend only, ever.
-- No condition/diagnosis field exists here or anywhere else (principle #2).
-- ---------------------------------------------------------------------------
create table capability_profile (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  axis text not null check (axis in ('motor_precision', 'reading_comfort', 'visual_processing_style')),
  score numeric not null check (score >= 0 and score <= 1),
  trend numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, axis)
);

alter table capability_profile enable row level security;

create policy "capability_profile_select_own"
  on capability_profile for select
  using (auth.uid() = user_id);

-- Written only by the Profiling & Adaptation Agent via Data MCP, using the caller's own
-- token (never the service-role key) so this policy is what actually enforces the boundary.
create policy "capability_profile_upsert_own"
  on capability_profile for insert
  with check (auth.uid() = user_id);

create policy "capability_profile_update_own"
  on capability_profile for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- evidence_log — raw evidence events (game telemetry, passive signals, conversation-
-- derived signals). Append-only: no update/delete policy is defined on purpose.
-- ---------------------------------------------------------------------------
create table evidence_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source in ('mini_game', 'passive_signal', 'conversation')),
  axis text not null check (axis in ('motor_precision', 'reading_comfort', 'visual_processing_style')),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table evidence_log enable row level security;

create policy "evidence_log_select_own"
  on evidence_log for select
  using (auth.uid() = user_id);

create policy "evidence_log_insert_own"
  on evidence_log for insert
  with check (auth.uid() = user_id);

create index evidence_log_user_axis_idx on evidence_log (user_id, axis, created_at desc);

-- ---------------------------------------------------------------------------
-- adaptation_feedback — one row per event (accept/decline/revert) on a proposed
-- adaptation. This is the bandit's reward signal (docs/ARCHITECTURE.md §5). Append-only.
--
-- adaptation_id is stamped by the Profiling & Adaptation Agent when the adaptation is
-- proposed, and echoed back on every event for it — it's what lets a later 'revert' row
-- be joined back to the 'accept' row it undoes. Not a DB default: the caller supplies the
-- same value across the accept/decline row and any subsequent revert row.
-- ---------------------------------------------------------------------------
create table adaptation_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  adaptation_id uuid not null,
  proposed jsonb not null,
  decision text not null check (decision in ('accept', 'decline', 'revert')),
  decided_at timestamptz not null default now(),
  unique (user_id, adaptation_id, decision)
);

alter table adaptation_feedback enable row level security;

create policy "adaptation_feedback_select_own"
  on adaptation_feedback for select
  using (auth.uid() = user_id);

create policy "adaptation_feedback_insert_own"
  on adaptation_feedback for insert
  with check (auth.uid() = user_id);

create index adaptation_feedback_user_idx on adaptation_feedback (user_id, decided_at desc);
create index adaptation_feedback_adaptation_idx on adaptation_feedback (user_id, adaptation_id);

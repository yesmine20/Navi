-- saved_sites — the "VOS SITES" shortcut grid on the browser home screen. Per-user list of
-- sites the person actually visits with Navi, not a fixed/shared default list, so Layer A
-- adaptation (docs/THIRD_PARTY_ADAPTATION.md) is being applied to real destinations this
-- specific person cares about, not arbitrary example URLs.

create table saved_sites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  url text not null,
  label text not null,
  -- Manual ordering (drag-to-reorder later, if ever) rather than created_at — the "VOS SITES"
  -- grid position is a user preference, not a log.
  position int not null default 0,
  created_at timestamptz not null default now()
);

alter table saved_sites enable row level security;

create policy "saved_sites_select_own"
  on saved_sites for select
  using (auth.uid() = user_id);

create policy "saved_sites_insert_own"
  on saved_sites for insert
  with check (auth.uid() = user_id);

create policy "saved_sites_update_own"
  on saved_sites for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "saved_sites_delete_own"
  on saved_sites for delete
  using (auth.uid() = user_id);

create index saved_sites_user_idx on saved_sites (user_id, position);

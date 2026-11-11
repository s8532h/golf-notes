-- Golf Notes: private per-user storage
-- Safe, additive schema for the current app.
-- Existing rows and tables are preserved. Run this in Supabase SQL Editor.
-- Never put a service_role key in the client app.

-- Legacy compatibility table. The app still reads/writes this during migration.
create table if not exists public.golf_notes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  notes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Dedicated memo table.
create table if not exists public.golf_memos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id text not null,
  title text not null default '',
  body text not null default '',
  category text,
  original_category text,
  tag text,
  memo_date text,
  next_action text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dedicated round-history table.
create table if not exists public.golf_rounds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id text not null,
  played_at date,
  course_name text,
  total_score integer,
  putts integer,
  ob_count integer,
  fairway_hits integer,
  gir_count integer,
  memo text,
  next_action text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Other app records: practice, measurements, distances, goals, course notes,
-- AI analysis cards, and related user-owned data.
create table if not exists public.golf_user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  records jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Keep existing table layouts compatible if the tables were created earlier.
alter table public.golf_notes
  add column if not exists notes jsonb not null default '[]'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

alter table public.golf_memos
  add column if not exists source_id text,
  add column if not exists title text not null default '',
  add column if not exists body text not null default '',
  add column if not exists category text,
  add column if not exists original_category text,
  add column if not exists tag text,
  add column if not exists memo_date text,
  add column if not exists next_action text,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.golf_rounds
  add column if not exists source_id text,
  add column if not exists played_at date,
  add column if not exists course_name text,
  add column if not exists total_score integer,
  add column if not exists putts integer,
  add column if not exists ob_count integer,
  add column if not exists fairway_hits integer,
  add column if not exists gir_count integer,
  add column if not exists memo text,
  add column if not exists next_action text,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.golf_user_data
  add column if not exists records jsonb not null default '[]'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

-- The app upserts memo and round rows using (user_id, source_id).
create unique index if not exists golf_memos_user_source_uidx
  on public.golf_memos (user_id, source_id);
create unique index if not exists golf_rounds_user_source_uidx
  on public.golf_rounds (user_id, source_id);

-- Enable row-level security on every table.
alter table public.golf_notes enable row level security;
alter table public.golf_memos enable row level security;
alter table public.golf_rounds enable row level security;
alter table public.golf_user_data enable row level security;

-- Remove all prior policies on these four tables first. This avoids leaving
-- an older permissive policy in place alongside the policies below.
do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('golf_notes','golf_memos','golf_rounds','golf_user_data')
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- Legacy table policies.
create policy "Users can read their own golf notes"
  on public.golf_notes for select to authenticated
  using (auth.uid() = user_id);
create policy "Users can insert their own golf notes"
  on public.golf_notes for insert to authenticated
  with check (auth.uid() = user_id);
create policy "Users can update their own golf notes"
  on public.golf_notes for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their own golf notes"
  on public.golf_notes for delete to authenticated
  using (auth.uid() = user_id);

-- Memo table policies.
create policy "Users can read their own golf memos"
  on public.golf_memos for select to authenticated
  using (auth.uid() = user_id);
create policy "Users can insert their own golf memos"
  on public.golf_memos for insert to authenticated
  with check (auth.uid() = user_id);
create policy "Users can update their own golf memos"
  on public.golf_memos for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their own golf memos"
  on public.golf_memos for delete to authenticated
  using (auth.uid() = user_id);

-- Round table policies.
create policy "Users can read their own golf rounds"
  on public.golf_rounds for select to authenticated
  using (auth.uid() = user_id);
create policy "Users can insert their own golf rounds"
  on public.golf_rounds for insert to authenticated
  with check (auth.uid() = user_id);
create policy "Users can update their own golf rounds"
  on public.golf_rounds for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their own golf rounds"
  on public.golf_rounds for delete to authenticated
  using (auth.uid() = user_id);

-- Other user data policies.
create policy "Users can read their own golf user data"
  on public.golf_user_data for select to authenticated
  using (auth.uid() = user_id);
create policy "Users can insert their own golf user data"
  on public.golf_user_data for insert to authenticated
  with check (auth.uid() = user_id);
create policy "Users can update their own golf user data"
  on public.golf_user_data for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- No anon/public policies. Do not expose private records.

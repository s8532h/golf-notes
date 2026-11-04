-- Golf Notes: private per-user storage
-- Run this in the Supabase SQL Editor for your own project.

create table if not exists public.golf_notes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  notes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.golf_notes enable row level security;

drop policy if exists "Users can read their own golf notes" on public.golf_notes;
create policy "Users can read their own golf notes"
  on public.golf_notes for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own golf notes" on public.golf_notes;
create policy "Users can insert their own golf notes"
  on public.golf_notes for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own golf notes" on public.golf_notes;
create policy "Users can update their own golf notes"
  on public.golf_notes for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own golf notes" on public.golf_notes;
create policy "Users can delete their own golf notes"
  on public.golf_notes for delete
  to authenticated
  using (auth.uid() = user_id);

-- Do not create a public/anon policy. Never put a service_role key in the app.

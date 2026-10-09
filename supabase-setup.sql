-- Run this once in Supabase Dashboard > SQL Editor.
-- The bucket is private. Darb serves requested files through short-lived signed URLs.
-- The database table has no public policies; only the Node.js server uses its service role key.

create table if not exists public.darb_records (
  collection text not null check (collection in ('lesson', 'content', 'migration')),
  id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (collection, id)
);

alter table public.darb_records enable row level security;

-- The server's Supabase secret key uses the service_role database role.
grant usage on schema public to service_role;
grant all privileges on table public.darb_records to service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values ('darb-files', 'darb-files', false, 52428800)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

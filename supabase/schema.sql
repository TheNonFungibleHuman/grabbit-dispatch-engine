-- ==========================================================
-- Grabbit Express Supabase Database & Storage Setup
-- Run this in your Supabase SQL Editor: https://supabase.com/dashboard/project/_/sql
-- ==========================================================

-- 1. Create Documents table (for transcripts, order drafts, admin knowledge, stats)
create table if not exists public.grabbit_documents (
  pathname text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Index for fast lookup by update time
create index if not exists idx_grabbit_documents_updated on public.grabbit_documents(updated_at desc);

-- Grant permissions only to service_role (backend agent). Revoke from anon & authenticated.
revoke all on table public.grabbit_documents from anon, authenticated;
grant all on table public.grabbit_documents to service_role;

-- Enable RLS
alter table public.grabbit_documents enable row level security;

-- Drop existing policies if present
drop policy if exists "Allow full access to service role" on public.grabbit_documents;
drop policy if exists "Allow full access to service role only" on public.grabbit_documents;
drop policy if exists "Allow read access to public" on public.grabbit_documents;

-- Policy: Restrict full access strictly to service_role
create policy "Allow full access to service role only"
  on public.grabbit_documents
  to service_role
  using (true)
  with check (true);

-- 2. Create Public Storage Bucket for Package Photos
insert into storage.buckets (id, name, public)
values ('package-images', 'package-images', true)
on conflict (id) do update set public = true;

-- Drop existing storage policies if present
drop policy if exists "Public Access to Package Images" on storage.objects;
drop policy if exists "Service Role can Upload Package Images" on storage.objects;

-- Policy: Anyone can view package images via public URL
create policy "Public Access to Package Images"
  on storage.objects
  for select
  using (bucket_id = 'package-images');

-- Policy: Service role can upload and manage images
create policy "Service Role can Upload Package Images"
  on storage.objects
  for all
  using (bucket_id = 'package-images')
  with check (bucket_id = 'package-images');

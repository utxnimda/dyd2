-- 若项目已按旧版 schema 部署过，在 Supabase SQL Editor 中单独执行本文件以追加「点歌上报」表与策略。

create table if not exists public.song_pick_requests (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references public.songs (id) on delete cascade,
  visitor_id text not null,
  created_at timestamptz not null default now ()
);

create index if not exists song_pick_requests_created on public.song_pick_requests (created_at desc);

alter table public.song_pick_requests enable row level security;

drop policy if exists "song_pick_requests insert anon" on public.song_pick_requests;
create policy "song_pick_requests insert anon" on public.song_pick_requests for insert to anon
with check (
  exists (select 1 from public.songs s where s.id = song_pick_requests.song_id)
  and length(trim(visitor_id)) >= 16
);

drop policy if exists "song_pick_requests select admin" on public.song_pick_requests;
create policy "song_pick_requests select admin" on public.song_pick_requests for select to authenticated
using (public.is_admin ());

drop policy if exists "song_pick_requests delete admin" on public.song_pick_requests;
create policy "song_pick_requests delete admin" on public.song_pick_requests for delete to authenticated
using (public.is_admin ());

grant insert on public.song_pick_requests to anon;
grant select, delete on public.song_pick_requests to authenticated;

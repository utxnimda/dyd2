-- 在 Supabase：SQL Editor → New query → 粘贴运行（可按需修改种子歌单）

create extension if not exists "pgcrypto";

create table if not exists public.songs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  artist text not null,
  note text not null default '',
  link_url text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.song_likes (
  song_id uuid not null references public.songs (id) on delete cascade,
  visitor_id text not null,
  created_at timestamptz not null default now(),
  primary key (song_id, visitor_id)
);

create table if not exists public.song_comments (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references public.songs (id) on delete cascade,
  author text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists song_comments_by_song on public.song_comments (song_id, created_at desc);

alter table public.songs enable row level security;
alter table public.song_likes enable row level security;
alter table public.song_comments enable row level security;

drop policy if exists "songs read" on public.songs;
create policy "songs read" on public.songs for select using (true);

drop policy if exists "likes read" on public.song_likes;
create policy "likes read" on public.song_likes for select using (true);

drop policy if exists "comments read" on public.song_comments;
create policy "comments read" on public.song_comments for select using (true);

drop policy if exists "comments insert" on public.song_comments;
create policy "comments insert" on public.song_comments for insert
with check (
  length(trim(author)) between 1 and 40
  and length(trim(body)) between 1 and 500
);

create or replace function public.toggle_like (p_song_id uuid, p_visitor_id text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_visitor_id is null or length(trim(p_visitor_id)) < 16 then
    raise exception 'invalid visitor';
  end if;
  if not exists (select 1 from songs where id = p_song_id) then
    raise exception 'song not found';
  end if;

  if exists (
    select 1 from song_likes where song_id = p_song_id and visitor_id = p_visitor_id
  ) then
    delete from song_likes where song_id = p_song_id and visitor_id = p_visitor_id;
    return json_build_object('liked', false);
  end if;

  insert into song_likes (song_id, visitor_id) values (p_song_id, p_visitor_id);
  return json_build_object('liked', true);
end;
$$;

grant usage on schema public to anon, authenticated;
grant select on public.songs to anon, authenticated;
grant select on public.song_likes to anon, authenticated;
grant select, insert on public.song_comments to anon, authenticated;
grant execute on function public.toggle_like (uuid, text) to anon, authenticated;

revoke insert, update, delete on public.song_likes from anon, authenticated;
revoke insert, update, delete on public.songs from anon, authenticated;

-- ========== 管理员：仅列入 admin_users 的账号可增删改歌曲 ==========
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade
);

alter table public.admin_users enable row level security;

create or replace function public.is_admin ()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  );
$$;

grant execute on function public.is_admin () to authenticated;

drop policy if exists "songs insert admin" on public.songs;
drop policy if exists "songs update admin" on public.songs;
drop policy if exists "songs delete admin" on public.songs;

create policy "songs insert admin" on public.songs for insert to authenticated
with check (public.is_admin ());

create policy "songs update admin" on public.songs for update to authenticated
using (public.is_admin ())
with check (public.is_admin ());

create policy "songs delete admin" on public.songs for delete to authenticated
using (public.is_admin ());

grant insert, update, delete on public.songs to authenticated;

-- ========== 点歌上报（访客可提交，仅管理员可读 / 删） ==========
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

-- ========== 相册（视若珍宝）与获奖记录（中军帐下） ==========
create table if not exists public.gallery_items (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  caption text not null default '',
  approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now ()
);

create unique index if not exists gallery_items_path_uq on public.gallery_items (path);

create table if not exists public.award_records (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  detail text not null default '',
  source_url text not null default '',
  awarded_at date,
  sort_order int not null default 0,
  created_at timestamptz not null default now ()
);

alter table public.gallery_items enable row level security;
alter table public.award_records enable row level security;

drop policy if exists "gallery read" on public.gallery_items;
drop policy if exists "gallery select" on public.gallery_items;
create policy "gallery select" on public.gallery_items for select
using (approval_status = 'approved' or public.is_admin ());

drop policy if exists "gallery insert visitor" on public.gallery_items;
create policy "gallery insert visitor" on public.gallery_items for insert to anon
with check (
  length(trim(caption)) <= 500
  and approval_status = 'pending'
);

drop policy if exists "gallery update admin" on public.gallery_items;
create policy "gallery update admin" on public.gallery_items for update to authenticated
using (public.is_admin ())
with check (public.is_admin ());

drop policy if exists "gallery delete admin" on public.gallery_items;
create policy "gallery delete admin" on public.gallery_items for delete to authenticated
using (public.is_admin ());

drop policy if exists "awards read" on public.award_records;
create policy "awards read" on public.award_records for select using (true);

drop policy if exists "awards insert admin" on public.award_records;
create policy "awards insert admin" on public.award_records for insert to authenticated
with check (public.is_admin ());

drop policy if exists "awards update admin" on public.award_records;
create policy "awards update admin" on public.award_records for update to authenticated
using (public.is_admin ())
with check (public.is_admin ());

drop policy if exists "awards delete admin" on public.award_records;
create policy "awards delete admin" on public.award_records for delete to authenticated
using (public.is_admin ());

grant select on public.gallery_items to anon, authenticated;
grant insert on public.gallery_items to anon, authenticated;
grant update, delete on public.gallery_items to authenticated;
grant select on public.award_records to anon, authenticated;
grant insert, update, delete on public.award_records to authenticated;

insert into storage.buckets (id, name, public)
values ('gallery', 'gallery', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "gallery objects public read" on storage.objects;
create policy "gallery objects public read"
on storage.objects for select
using (bucket_id = 'gallery');

drop policy if exists "gallery objects anon insert" on storage.objects;
create policy "gallery objects anon insert"
on storage.objects for insert to anon
with check (bucket_id = 'gallery');

drop policy if exists "gallery objects auth delete admin" on storage.objects;
create policy "gallery objects auth delete admin"
on storage.objects for delete to authenticated
using (bucket_id = 'gallery' and public.is_admin ());

-- 将你登录用的 Supabase Auth 用户 UUID 写入（Authentication → Users 复制）
-- insert into public.admin_users (user_id) values ('在此粘贴-uuid');

-- 示例歌曲：仅在歌单为空时插入（避免重复执行脚本时重复插入）；id 与前端 SAMPLE_SONGS 对齐便于演示
insert into public.songs (id, title, artist, note, link_url, sort_order)
select v.id, v.title, v.artist, v.note, v.link_url, v.sort_order
from (
  values
    ('11111111-1111-4111-8111-111111111101'::uuid, '轨迹', '周杰伦', '', '', 1),
    ('11111111-1111-4111-8111-111111111102'::uuid, '倒带', '蔡依林', '', '', 2),
    ('11111111-1111-4111-8111-111111111103'::uuid, '恋人', '李荣浩', '', '', 3),
    ('11111111-1111-4111-8111-111111111104'::uuid, '童话镇', '暗杠', '', '', 4),
    ('11111111-1111-4111-8111-111111111105'::uuid, '白色风车', '周杰伦', '', '', 5),
    ('11111111-1111-4111-8111-111111111106'::uuid, '褪黑素', '江皓南', '', '', 6),
    ('11111111-1111-4111-8111-111111111107'::uuid, '关键字', '林俊杰', '', '', 7),
    ('11111111-1111-4111-8111-111111111108'::uuid, '嘉宾', '张远', '', '', 8),
    ('11111111-1111-4111-8111-111111111109'::uuid, '画心', '张靓颖', '', '', 9),
    ('11111111-1111-4111-8111-111111111110'::uuid, '七月七日晴', '许慧欣', '', '', 10),
    ('11111111-1111-4111-8111-111111111111'::uuid, '呼吸决定', 'Fine乐团', '', '', 11),
    ('11111111-1111-4111-8111-111111111112'::uuid, '邮差', '王菲', '', '', 12)
) as v (id, title, artist, note, link_url, sort_order)
where not exists (select 1 from public.songs);

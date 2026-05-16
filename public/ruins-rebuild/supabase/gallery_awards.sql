-- 相册与获奖记录（在已有 schema / is_admin 基础上追加执行）
-- Storage：若下列桶插入失败，请在 Dashboard → Storage 手动新建公开桶 gallery

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

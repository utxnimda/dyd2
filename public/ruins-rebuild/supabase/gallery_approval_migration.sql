-- 相册审核（在已有 gallery_items 上追加）。执行后：访客上传为「待审核」，仅管理员可见；通过后前台展示。
-- 已有照片全部视为「已通过」，避免相册突然变空。

alter table public.gallery_items
  add column if not exists approval_status text;

update public.gallery_items
set approval_status = 'approved'
where approval_status is null or btrim(approval_status) = '';

alter table public.gallery_items
  alter column approval_status set default 'pending';

alter table public.gallery_items
  alter column approval_status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'gallery_items' and c.conname = 'gallery_items_approval_status_check'
  ) then
    alter table public.gallery_items
      add constraint gallery_items_approval_status_check
      check (approval_status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

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

grant update, delete on public.gallery_items to authenticated;

drop policy if exists "gallery objects auth delete admin" on storage.objects;
create policy "gallery objects auth delete admin"
on storage.objects for delete to authenticated
using (bucket_id = 'gallery' and public.is_admin ());

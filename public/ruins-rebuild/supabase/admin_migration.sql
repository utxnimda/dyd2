-- 若你已部署过旧版 schema，请在 SQL Editor 执行本文件以启用后台管理权限。
-- 执行后务必插入你自己的管理员 UUID：Authentication → Users → 复制用户 id

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

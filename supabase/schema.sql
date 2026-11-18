-- Clan page: who stands on which resource point, live for the whole clan.
-- Run once in Supabase: SQL Editor -> paste -> Run. Then set the passwords (see the end of the file).
-- Everything goes through the functions below; the tables are closed to the browser except reading marks
-- (and an admin reading the members). Anonymous sign-in gives each browser its own user id.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.clan_members (
  user_id     uuid primary key,
  nick        text not null,
  role        text not null check (role in ('guest', 'viewer', 'marker', 'admin', 'owner')),
  banned      boolean not null default false,
  guest_until timestamptz,
  joined_at   timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);
create unique index if not exists clan_members_nick on public.clan_members (lower(nick));

-- Bcrypt hashes of the role passwords; nobody reads them, the functions compare.
create table if not exists public.clan_codes (
  role text primary key check (role in ('viewer', 'marker', 'admin', 'owner')),
  hash text not null
);

-- One-hour guest passwords made by the owner: they let one only look.
create table if not exists public.clan_guest_codes (
  hash       text primary key,
  expires_at timestamptz not null,
  created_by text
);

-- A point is marked or not (as on the bot's map): who marked it and when. A player marks as many as he likes.
-- (Until 2026-11-18 a player had one mark keyed by him: that table goes, its few marks with it.)
do $$ begin
  if exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
              where i.indrelid = to_regclass('public.clan_marks') and i.indisprimary and a.attname = 'user_id') then
    drop table public.clan_marks;
  end if;
end $$;
create table if not exists public.clan_marks (
  point      text primary key check (point ~ '^[a-z0-9-]+/[a-z0-9-]+$'),
  user_id    uuid not null references public.clan_members (user_id) on delete cascade,
  nick       text not null,
  created_at timestamptz not null default now()
);
create index if not exists clan_marks_user on public.clan_marks (user_id);

-- Passwords off (an admin's switch): a nick alone lets one in with the marker's rights; switched back on,
-- those who came in so are out. Admins always need their password.
create table if not exists public.clan_settings (
  id         int primary key default 1 check (id = 1),
  open       boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by text
);
insert into public.clan_settings (id) values (1) on conflict (id) do nothing;
alter table public.clan_members add column if not exists via_open boolean not null default false;

alter table public.clan_settings enable row level security;
alter table public.clan_members enable row level security;
alter table public.clan_codes enable row level security;
alter table public.clan_guest_codes enable row level security;
alter table public.clan_marks enable row level security;

-- The caller's role, or null: not joined, banned or a guest whose hour is over.
create or replace function public.clan_role() returns text
language sql stable security definer set search_path = public as $$
  select case
           when m.banned then null
           when m.role = 'guest' and (m.guest_until is null or m.guest_until < now()) then null
           when m.via_open and not (select s.open from public.clan_settings s where s.id = 1) then null
           else m.role
         end
  from public.clan_members m where m.user_id = auth.uid()
$$;

drop function if exists public.clan_guest_code();
drop policy if exists clan_marks_read on public.clan_marks;
create policy clan_marks_read on public.clan_marks for select to authenticated
  using (public.clan_role() is not null);

drop policy if exists clan_settings_read on public.clan_settings;
create policy clan_settings_read on public.clan_settings for select to authenticated using (true);

drop policy if exists clan_members_read on public.clan_members;
create policy clan_members_read on public.clan_members for select to authenticated
  using (user_id = auth.uid() or public.clan_role() in ('admin', 'owner'));

-- The rank of a role: who may act on whom.
create or replace function public.clan_rank(r text) returns int
language sql immutable as $$
  select case r when 'owner' then 4 when 'admin' then 3 when 'marker' then 2 when 'viewer' then 1 else 0 end
$$;

create or replace function public.clan_me() returns json
language plpgsql security definer set search_path = public as $$
declare m public.clan_members;
begin
  update public.clan_members set last_seen = now() where user_id = auth.uid() returning * into m;
  if m.user_id is null then return null; end if;
  return json_build_object('nick', m.nick, 'role', public.clan_role(), 'joined_as', m.role, 'via_open', m.via_open,
                           'banned', m.banned, 'guest_until', m.guest_until, 'id', m.user_id);
end $$;

-- Enter with a password and a nick. The password decides the role; the nick is unique (case aside).
create or replace function public.clan_join(p_code text, p_nick text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  uid uuid := auth.uid();
  v_nick text := btrim(regexp_replace(coalesce(p_nick, ''), '\s+', ' ', 'g'));
  new_role text;
  until timestamptz;
  open_entry boolean := false;
  other public.clan_members;
  mine public.clan_members;
begin
  if uid is null then raise exception 'not_signed_in'; end if;
  if char_length(v_nick) < 2 or char_length(v_nick) > 24 then raise exception 'bad_nick'; end if;
  select * into mine from public.clan_members where user_id = uid;
  if mine.banned then raise exception 'banned'; end if;

  select c.role into new_role from public.clan_codes c
   where c.hash = crypt(coalesce(p_code, ''), c.hash)
   order by public.clan_rank(c.role) desc limit 1;
  if new_role is null then
    select g.expires_at into until from public.clan_guest_codes g
     where g.expires_at > now() and g.hash = crypt(coalesce(p_code, ''), g.hash) limit 1;
    if until is not null then
      new_role := 'guest';
    elsif (select s.open from public.clan_settings s where s.id = 1) then
      new_role := 'marker';   -- passwords are off: the nick is enough
      open_entry := true;
    else
      perform pg_sleep(0.5);   -- slows down guessing
      raise exception 'bad_code';
    end if;
  end if;

  select * into other from public.clan_members where lower(clan_members.nick) = lower(v_nick) and clan_members.user_id <> uid;
  if other.user_id is not null then
    raise exception '%', case when other.banned then 'banned' else 'nick_taken' end;
  end if;

  insert into public.clan_members (user_id, nick, role, guest_until, via_open)
  values (uid, v_nick, new_role, until, open_entry)
  on conflict (user_id) do update set nick = excluded.nick, role = excluded.role, guest_until = excluded.guest_until,
                                      via_open = excluded.via_open, last_seen = now();
  update public.clan_marks set nick = v_nick where clan_marks.user_id = uid;
  if new_role not in ('marker', 'admin', 'owner') then delete from public.clan_marks where clan_marks.user_id = uid; end if;
  return public.clan_me();
end $$;

-- Mark a point in the caller's name (a marked one stays as it is).
create or replace function public.clan_mark(p_point text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.clan_members;
begin
  if public.clan_rank(public.clan_role()) < 2 then raise exception 'forbidden'; end if;
  select * into m from public.clan_members where user_id = auth.uid();
  insert into public.clan_marks (point, user_id, nick) values (p_point, m.user_id, m.nick)
  on conflict (point) do nothing;
end $$;

-- A click on a point: marked -> unmarked, unmarked -> marked by the caller. Returns whether it is marked now.
create or replace function public.clan_toggle(p_point text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if public.clan_rank(public.clan_role()) < 2 then raise exception 'forbidden'; end if;
  delete from public.clan_marks where point = p_point;
  if found then return false; end if;
  perform public.clan_mark(p_point);
  return true;
end $$;

-- Take one point's mark off, whoever put it.
drop function if exists public.clan_unmark(uuid);
create or replace function public.clan_unmark(p_point text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.clan_rank(public.clan_role()) < 2 then raise exception 'forbidden'; end if;
  delete from public.clan_marks where point = p_point;
end $$;

-- All marks off at once: admins.
create or replace function public.clan_clear_marks() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if public.clan_rank(public.clan_role()) < 3 then raise exception 'forbidden'; end if;
  delete from public.clan_marks where true;
  get diagnostics n = row_count;
  return n;
end $$;

-- A member by nick (case aside) or by id.
create or replace function public.clan_find(p_target text) returns public.clan_members
language sql stable security definer set search_path = public as $$
  select * from public.clan_members
   where lower(nick) = lower(btrim(p_target)) or user_id::text = lower(btrim(p_target))
   limit 1
$$;

-- Block or unblock a player; a blocked one sees nothing, loses his mark and his nick stays taken.
create or replace function public.clan_ban(p_target text, p_banned boolean default true) returns json
language plpgsql security definer set search_path = public as $$
declare t public.clan_members := public.clan_find(p_target);
begin
  if public.clan_rank(public.clan_role()) < 3 then raise exception 'forbidden'; end if;
  if t.user_id is null then raise exception 'not_found'; end if;
  if t.user_id = auth.uid() then raise exception 'self'; end if;
  if public.clan_rank(t.role) >= public.clan_rank(public.clan_role()) then raise exception 'forbidden'; end if;
  update public.clan_members set banned = p_banned where user_id = t.user_id;
  if p_banned then delete from public.clan_marks where user_id = t.user_id; end if;
  return json_build_object('nick', t.nick, 'banned', p_banned);
end $$;

-- Remove a player altogether: his nick becomes free again.
create or replace function public.clan_remove(p_target text) returns json
language plpgsql security definer set search_path = public as $$
declare t public.clan_members := public.clan_find(p_target);
begin
  if public.clan_rank(public.clan_role()) < 3 then raise exception 'forbidden'; end if;
  if t.user_id is null then raise exception 'not_found'; end if;
  if t.user_id = auth.uid() then raise exception 'self'; end if;
  if public.clan_rank(t.role) >= public.clan_rank(public.clan_role()) then raise exception 'forbidden'; end if;
  delete from public.clan_members where user_id = t.user_id;
  return json_build_object('nick', t.nick);
end $$;

-- Leave the clan page: the nick becomes free (a blocked player stays blocked).
create or replace function public.clan_leave() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.clan_members where user_id = auth.uid() and not banned;
end $$;

-- Admins set the passwords of the roles below their own (the owner: all of them), at least 6 characters.
create or replace function public.clan_set_code(p_role text, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_role not in ('viewer', 'marker', 'admin', 'owner') then raise exception 'bad_role'; end if;
  if public.clan_rank(public.clan_role()) < 3 then raise exception 'forbidden'; end if;
  if public.clan_role() <> 'owner' and public.clan_rank(p_role) >= public.clan_rank(public.clan_role()) then
    raise exception 'forbidden';
  end if;
  if char_length(coalesce(p_password, '')) < 6 then raise exception 'short_password'; end if;
  insert into public.clan_codes (role, hash) values (p_role, crypt(p_password, gen_salt('bf', 8)))
  on conflict (role) do update set hash = excluded.hash;
end $$;

-- An admin turns on the guest password for one hour: a simple one (4 random digits unless given),
-- it lets one only look; the guests are out when the hour ends. A new one replaces the old.
create or replace function public.clan_guest_code(p_code text default null) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  code text := btrim(coalesce(p_code, ''));
  until timestamptz := now() + interval '1 hour';
begin
  if public.clan_rank(public.clan_role()) < 3 then raise exception 'forbidden'; end if;
  if code = '' then code := lpad(floor(random() * 10000)::int::text, 4, '0'); end if;
  if char_length(code) < 4 or char_length(code) > 32 then raise exception 'short_guest'; end if;
  if exists (select 1 from public.clan_codes c where c.hash = crypt(code, c.hash)) then raise exception 'same_as_role'; end if;
  delete from public.clan_guest_codes where true;
  insert into public.clan_guest_codes (hash, expires_at, created_by)
  values (crypt(code, gen_salt('bf', 6)), until, (select nick from public.clan_members where user_id = auth.uid()));
  return json_build_object('code', code, 'expires_at', until);
end $$;

-- Whether a guest password is on and till when (admins).
create or replace function public.clan_guest_status() returns json
language plpgsql security definer set search_path = public as $$
begin
  if public.clan_rank(public.clan_role()) < 3 then raise exception 'forbidden'; end if;
  return (select json_build_object('expires_at', max(expires_at), 'by', max(created_by))
            from public.clan_guest_codes where expires_at > now());
end $$;

-- An admin ends the guest password now; the guests in are out as well.
create or replace function public.clan_guest_off() returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.clan_rank(public.clan_role()) < 3 then raise exception 'forbidden'; end if;
  delete from public.clan_guest_codes where true;
  update public.clan_members set guest_until = now() where role = 'guest' and guest_until > now();
end $$;

-- An admin turns the passwords off or on. On: those who came in without one are out (their marks and nicks too).
create or replace function public.clan_set_open(p_open boolean) returns json
language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if public.clan_rank(public.clan_role()) < 3 then raise exception 'forbidden'; end if;
  update public.clan_settings set open = p_open, changed_at = now(),
         changed_by = (select nick from public.clan_members where user_id = auth.uid()) where id = 1;
  if not p_open then
    delete from public.clan_members where via_open;
    get diagnostics n = row_count;
  end if;
  return json_build_object('open', p_open, 'removed', n);
end $$;

-- The bootstrap: sets the four passwords while none is set yet (afterwards only the owner changes them).
create or replace function public.clan_setup(p_owner text, p_admin text, p_marker text, p_viewer text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.clan_codes) then raise exception 'already_set'; end if;
  insert into public.clan_codes (role, hash) values
    ('owner', crypt(p_owner, gen_salt('bf', 8))), ('admin', crypt(p_admin, gen_salt('bf', 8))),
    ('marker', crypt(p_marker, gen_salt('bf', 8))), ('viewer', crypt(p_viewer, gen_salt('bf', 8)));
end $$;

revoke all on function public.clan_setup(text, text, text, text) from public, anon, authenticated;
revoke all on function public.clan_find(text) from public, anon, authenticated;
revoke all on table public.clan_codes, public.clan_guest_codes from anon, authenticated;
revoke all on table public.clan_settings from anon, authenticated;
grant select on table public.clan_settings to authenticated;
revoke insert, update, delete on table public.clan_members, public.clan_marks from anon, authenticated;
grant select on table public.clan_members, public.clan_marks to authenticated;
grant execute on function public.clan_me(), public.clan_join(text, text), public.clan_mark(text),
  public.clan_unmark(text), public.clan_toggle(text), public.clan_clear_marks(), public.clan_ban(text, boolean), public.clan_remove(text),
  public.clan_set_code(text, text), public.clan_guest_code(text), public.clan_guest_status(), public.clan_guest_off(),
  public.clan_role(), public.clan_leave(), public.clan_set_open(boolean) to authenticated;
revoke execute on function public.clan_me(), public.clan_join(text, text), public.clan_mark(text),
  public.clan_unmark(text), public.clan_toggle(text), public.clan_clear_marks(), public.clan_ban(text, boolean), public.clan_remove(text),
  public.clan_set_code(text, text), public.clan_guest_code(text), public.clan_guest_status(), public.clan_guest_off(),
  public.clan_role(), public.clan_leave(), public.clan_set_open(boolean) from public, anon;

-- Marks reach every open page at once.
do $$ begin
  alter publication supabase_realtime add table public.clan_marks;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.clan_settings;
exception when duplicate_object then null;
end $$;

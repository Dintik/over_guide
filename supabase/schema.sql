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

-- One mark a player: the point he stands on (a new mark moves it).
create table if not exists public.clan_marks (
  user_id    uuid primary key references public.clan_members (user_id) on delete cascade,
  point      text not null check (point ~ '^[a-z0-9-]+/[a-z0-9-]+$'),
  nick       text not null,
  created_at timestamptz not null default now()
);

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
           else m.role
         end
  from public.clan_members m where m.user_id = auth.uid()
$$;

drop policy if exists clan_marks_read on public.clan_marks;
create policy clan_marks_read on public.clan_marks for select to authenticated
  using (public.clan_role() is not null);

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
  return json_build_object('nick', m.nick, 'role', public.clan_role(), 'joined_as', m.role,
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
    if until is null then
      perform pg_sleep(0.5);   -- slows down guessing
      raise exception 'bad_code';
    end if;
    new_role := 'guest';
  end if;

  select * into other from public.clan_members where lower(clan_members.nick) = lower(v_nick) and clan_members.user_id <> uid;
  if other.user_id is not null then
    raise exception '%', case when other.banned then 'banned' else 'nick_taken' end;
  end if;

  insert into public.clan_members (user_id, nick, role, guest_until)
  values (uid, v_nick, new_role, until)
  on conflict (user_id) do update set nick = excluded.nick, role = excluded.role,
                                      guest_until = excluded.guest_until, last_seen = now();
  update public.clan_marks set nick = v_nick where clan_marks.user_id = uid;
  if new_role not in ('marker', 'admin', 'owner') then delete from public.clan_marks where clan_marks.user_id = uid; end if;
  return public.clan_me();
end $$;

-- Put the caller's mark on a point (moves it from the old one).
create or replace function public.clan_mark(p_point text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.clan_members;
begin
  if public.clan_rank(public.clan_role()) < 2 then raise exception 'forbidden'; end if;
  select * into m from public.clan_members where user_id = auth.uid();
  insert into public.clan_marks (user_id, point, nick) values (m.user_id, p_point, m.nick)
  on conflict (user_id) do update set point = excluded.point, nick = excluded.nick, created_at = now();
end $$;

-- Take one mark off: the caller's own by default, any player's by his id.
create or replace function public.clan_unmark(p_user uuid default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.clan_rank(public.clan_role()) < 2 then raise exception 'forbidden'; end if;
  delete from public.clan_marks where user_id = coalesce(p_user, auth.uid());
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

-- The owner sets a role's password (at least 6 characters).
create or replace function public.clan_set_code(p_role text, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.clan_role() is distinct from 'owner' then raise exception 'forbidden'; end if;
  if p_role not in ('viewer', 'marker', 'admin', 'owner') then raise exception 'bad_role'; end if;
  if char_length(coalesce(p_password, '')) < 6 then raise exception 'short_password'; end if;
  insert into public.clan_codes (role, hash) values (p_role, crypt(p_password, gen_salt('bf', 8)))
  on conflict (role) do update set hash = excluded.hash;
end $$;

-- The owner makes a guest password for one hour; it is shown once.
create or replace function public.clan_guest_code() returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  code text := '';
  alphabet text := 'abcdefghjkmnpqrstuvwxyz23456789';
  i int;
  until timestamptz := now() + interval '1 hour';
begin
  if public.clan_role() is distinct from 'owner' then raise exception 'forbidden'; end if;
  for i in 1..8 loop
    code := code || substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % char_length(alphabet)), 1);
  end loop;
  delete from public.clan_guest_codes where expires_at < now();
  insert into public.clan_guest_codes (hash, expires_at, created_by)
  values (crypt(code, gen_salt('bf', 8)), until, (select nick from public.clan_members where user_id = auth.uid()));
  return json_build_object('code', code, 'expires_at', until);
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
revoke insert, update, delete on table public.clan_members, public.clan_marks from anon, authenticated;
grant select on table public.clan_members, public.clan_marks to authenticated;
grant execute on function public.clan_me(), public.clan_join(text, text), public.clan_mark(text),
  public.clan_unmark(uuid), public.clan_clear_marks(), public.clan_ban(text, boolean), public.clan_remove(text),
  public.clan_set_code(text, text), public.clan_guest_code(), public.clan_role(), public.clan_leave() to authenticated;
revoke execute on function public.clan_me(), public.clan_join(text, text), public.clan_mark(text),
  public.clan_unmark(uuid), public.clan_clear_marks(), public.clan_ban(text, boolean), public.clan_remove(text),
  public.clan_set_code(text, text), public.clan_guest_code(), public.clan_role(), public.clan_leave() from public, anon;

-- Marks reach every open page at once.
do $$ begin
  alter publication supabase_realtime add table public.clan_marks;
exception when duplicate_object then null;
end $$;

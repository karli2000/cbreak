-- Security review fixes (2026-11-13). Each section names the finding it closes.
--
-- 1. report_user: three throwaway accounts could mute anyone for 24 h from outside the room.
--    A reporter must have accepted the rules and be live in the room and instance of the reported
--    message (or of the target's current row); only reporters whose GitHub account is older than
--    30 days count toward the auto-mute; one auto-mute per target per 24 h; at most 5 reports per
--    reporter per 10 minutes.
-- 2. claim_nickname: an auth user without a GitHub identity got a profile with github_id null, so
--    bans never stuck for such accounts. A first claim now needs a GitHub identity (github_required).
-- 3. Unbounded call loops: join_room is capped per user (private.rate_limits, 30 per minute);
--    send_message checks the rate limits before any regex work, so a refused call is cheap.
-- 4. Presence was client-chosen (a modified client could announce anyone). join_room, leave_room,
--    mod_ban, delete_my_account and the purge now broadcast `presence` events with the nickname
--    from profiles and the live count; clients no longer derive names from presence keys.
-- 5. Reserved nicknames live in one place (private.reserved_nickname), used by nickname_available
--    and claim_nickname; `unknown` and `deleted` are reserved too (the moderator site prints them
--    as placeholders).
-- 6. delete_my_account reset the rename cool-down and freed the nickname at once:
--    private.account_memory keeps nickname, rename time and mute per GitHub id hash for 30 days;
--    a released nickname is held 7 days for its owner; the cool-down and an active mute carry over.
-- 7. Admin-trust caps: filter patterns at most 200 chars, no backreferences, at most 100 rows;
--    room title 1-80, kind/lang at most 32; staff reasons refused above 2000 raw chars.
-- 8. clean_text also strips zero-width and other invisible characters (U+00AD, U+180E, U+200B,
--    U+2060-2064, U+FEFF), and a body of only joiners/marks/variation selectors counts as empty.
-- 9. public_stats() (anon-callable) reads a cached row refreshed by cron every minute instead of
--    counting live on every call.
-- 10. mod_mute never shortens an existing mute (greatest).
-- 11. profiles.github_age_checked_at: the github-age function records every attempt, so a profile
--     whose GitHub lookup keeps failing cannot burn the shared token's rate limit.

-- 5. reserved nicknames ------------------------------------------------------------------------

create function private.reserved_nickname(n text) returns boolean
language sql immutable set search_path = '' as $$
  select lower(coalesce(n, '')) = any (array['admin','administrator','mod','moderator','claude','anthropic',
    'system','coffee','coffeebreak','cbreak','root','support','staff','unknown','deleted'])
$$;
revoke execute on function private.reserved_nickname(text) from public, anon, authenticated;

-- 6. account memory ------------------------------------------------------------------------------

create table private.account_memory (
  github_id_hash text primary key,
  nickname extensions.citext,
  nickname_changed_at timestamptz,
  muted_until timestamptz,
  deleted_at timestamptz not null default now()
);
create index account_memory_nickname_idx on private.account_memory (nickname);
alter table private.account_memory enable row level security;
revoke all on table private.account_memory from public, anon, authenticated;

create function private.github_hash(gh bigint) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(gh::text, 'UTF8')), 'hex')
$$;
revoke execute on function private.github_hash(bigint) from public, anon, authenticated;

-- A nickname released by another GitHub account less than 7 days ago is still theirs.
create function private.nickname_held(n text, hash text) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from private.account_memory am
    where am.nickname = n::extensions.citext
      and am.deleted_at > now() - interval '7 days'
      and (hash is null or am.github_id_hash <> hash))
$$;
revoke execute on function private.nickname_held(text, text) from public, anon, authenticated;

-- 3. per-user call limits ------------------------------------------------------------------------

-- Successful calls are counted (a refused call rolls its increment back), so once the count reaches
-- the maximum every further call in the window is refused after one cheap upsert.
create table private.rate_limits (
  user_id uuid not null,
  kind text not null,
  window_start timestamptz not null,
  count int not null,
  primary key (user_id, kind)
);
alter table private.rate_limits enable row level security;
revoke all on table private.rate_limits from public, anon, authenticated;

create function private.bump_limit(p_kind text, p_window interval, p_max int) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); n int;
begin
  insert into private.rate_limits as l (user_id, kind, window_start, count)
  values (uid, p_kind, now(), 1)
  on conflict (user_id, kind) do update
    set window_start = case when l.window_start <= now() - p_window then now() else l.window_start end,
        count = case when l.window_start <= now() - p_window then 1 else l.count + 1 end
  returning l.count into n;
  if n > p_max then raise exception 'rate_limited'; end if;
end $$;
revoke execute on function private.bump_limit(text, interval, int) from public, anon, authenticated;

-- 4. server-sourced presence ---------------------------------------------------------------------

create function private.announce(p_room text, p_instance int, p_event text, p_uid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare n int; nick text;
begin
  select count(*) into n from public.occupancy o
  where o.room = p_room and o.instance = p_instance and o.last_seen > now() - interval '90 seconds';
  select p.nickname::text into nick from public.profiles p where p.id = p_uid;
  perform private.broadcast('room:' || p_room || ':' || p_instance, 'presence',
    jsonb_build_object('event', p_event, 'user_id', p_uid, 'nickname', nick, 'here', n));
end $$;
revoke execute on function private.announce(text, int, text, uuid) from public, anon, authenticated;

-- 8. clean_text ----------------------------------------------------------------------------------

create or replace function private.clean_text(t text) returns text
language sql immutable set search_path = '' as $$
  select case when s ~ '^[‌-‏؜︀-️]*$' then '' else s end
  from (
    select regexp_replace(
      regexp_replace(coalesce(t, ''),
        '[\u0001-\u001f\u007f-\u009f­᠎​  ‪-‮⁠-⁤⁦-⁩﻿]', '', 'g'),
      '^[[:space:]   -   　]+|[[:space:]   -   　]+$', '', 'g') as s
  ) x
$$;

-- 11. github-age attempts ------------------------------------------------------------------------

alter table public.profiles add column github_age_checked_at timestamptz;

-- 2, 5, 6. nickname_available and claim_nickname ------------------------------------------------

create or replace function public.nickname_available(nick text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  n text := lower(coalesce(nick, ''));
  hash text;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if n !~ '^[a-z0-9_-]{3,20}$' then return false; end if;
  if private.reserved_nickname(n) then return false; end if;
  select private.github_hash(coalesce(p.github_id, i.provider_id::bigint)) into hash
  from (select 1) one
  left join public.profiles p on p.id = uid
  left join auth.identities i on i.user_id = uid and i.provider = 'github';
  if private.nickname_held(n, hash) then return false; end if;
  return not exists (
    select 1 from public.profiles where nickname = n::extensions.citext
  );
end $$;

create or replace function public.claim_nickname(nick text) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  n text := lower(coalesce(nick, ''));
  p public.profiles;
  gh bigint;
  hash text;
  mem private.account_memory;
  cname text;
  has_profile boolean;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  select * into p from public.profiles where id = uid for update;
  has_profile := found; -- later lookups overwrite `found`
  if has_profile and p.banned_at is not null then raise exception 'banned'; end if;

  if n !~ '^[a-z0-9_-]{3,20}$' then raise exception 'nickname_invalid'; end if;
  if private.reserved_nickname(n) then raise exception 'nickname_reserved'; end if;

  -- unchanged name: no-op
  if has_profile and p.nickname is not null and p.nickname = n::extensions.citext then
    return p;
  end if;

  if has_profile and p.nickname is not null
     and p.nickname_changed_at is not null
     and p.nickname_changed_at > now() - interval '30 days' then
    raise exception 'nickname_change_too_soon';
  end if;

  if has_profile then
    hash := private.github_hash(p.github_id);
  else
    select i.provider_id::bigint into gh
    from auth.identities i where i.user_id = uid and i.provider = 'github' limit 1;
    -- every account is a GitHub account: bans and the account memory are keyed by its id
    if gh is null then raise exception 'github_required'; end if;
    hash := private.github_hash(gh);
    if exists (select 1 from public.banned_github_ids b where b.github_id_hash = hash) then
      raise exception 'banned';
    end if;
    select * into mem from private.account_memory am where am.github_id_hash = hash;
    -- the rename cool-down of a deleted account carries over to its new profile
    if mem.nickname_changed_at is not null and mem.nickname_changed_at > now() - interval '30 days'
       and mem.nickname is distinct from n::extensions.citext then
      raise exception 'nickname_change_too_soon';
    end if;
  end if;

  if exists (select 1 from public.profiles where nickname = n::extensions.citext and id <> uid)
     or private.nickname_held(n, hash) then
    raise exception 'nickname_taken';
  end if;

  begin
    if has_profile then
      update public.profiles set nickname = n, nickname_changed_at = now()
      where id = uid returning * into p;
    else
      insert into public.profiles (id, github_id, nickname, nickname_changed_at, muted_until)
      values (uid, gh, n, mem.nickname_changed_at,
              case when mem.muted_until > now() then mem.muted_until end)
      returning * into p;
    end if;
  exception when unique_violation then
    get stacked diagnostics cname = constraint_name;
    if cname = 'profiles_nickname_key' then
      raise exception 'nickname_taken';
    end if;
    raise;
  end;
  return p;
end $$;

-- 4, 6. delete_my_account ------------------------------------------------------------------------

create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); p public.profiles; o public.occupancy;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into p from public.profiles where id = uid for update;
  if found and p.github_id is not null then
    if p.banned_at is not null then
      insert into public.banned_github_ids (github_id_hash, banned_at, reason)
      values (private.github_hash(p.github_id), p.banned_at, p.ban_reason)
      on conflict do nothing;
    end if;
    insert into private.account_memory as am (github_id_hash, nickname, nickname_changed_at, muted_until, deleted_at)
    values (private.github_hash(p.github_id), p.nickname, p.nickname_changed_at, p.muted_until, now())
    on conflict (github_id_hash) do update
      set nickname = excluded.nickname, nickname_changed_at = excluded.nickname_changed_at,
          muted_until = excluded.muted_until, deleted_at = excluded.deleted_at;
  end if;
  if found then
    perform pg_advisory_xact_lock(hashtext('occ:' || uid::text));
    delete from public.occupancy where user_id = uid returning * into o;
    if found and o.last_seen > now() - interval '90 seconds' then
      perform private.announce(o.room, o.instance, 'leave', uid);
    end if;
  end if;
  delete from auth.users where id = uid;
end $$;

-- 3, 4. join_room (body from 20261114000200) ----------------------------------------------------

create or replace function public.join_room(room_slug text, session_id uuid default null, prefer_instance int default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  r public.rooms;
  old public.occupancy;
  inst int;
  n int;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into p from public.profiles where id = uid;
  if not found then raise exception 'no_profile'; end if;
  if p.banned_at is not null then raise exception 'banned'; end if;
  if p.rules_accepted_at is null then raise exception 'rules_not_accepted'; end if;
  select * into r from public.rooms where slug = room_slug;
  if not found then raise exception 'not_found'; end if;
  if not r.is_open then raise exception 'room_closed'; end if;

  -- a helper joins a few times per break at most; a loop would serialize every join on the room lock
  perform private.bump_limit('join', interval '1 minute', 30);

  -- lock order everywhere: per-user lock first, then the per-room lock
  perform pg_advisory_xact_lock(hashtext('occ:' || uid::text));
  perform pg_advisory_xact_lock(hashtext('room:' || room_slug));

  select * into old from public.occupancy o where o.user_id = uid;

  -- a caller who is already live in this room keeps their instance
  select o.instance into inst
  from public.occupancy o
  where o.user_id = uid and o.room = room_slug
    and o.last_seen > now() - interval '90 seconds';

  -- back for another break: the instance the client was in last, while it still has other live
  -- people and room to spare (an empty instance is never picked by number, so nobody opens a
  -- private side room)
  if inst is null and prefer_instance is not null and prefer_instance >= 1 then
    select count(*) into n from public.occupancy o
    where o.room = room_slug and o.instance = prefer_instance and o.user_id <> uid
      and o.last_seen > now() - interval '90 seconds';
    if n between 1 and 49 then inst := prefer_instance; end if;
  end if;

  if inst is null then
    -- fullest live instance with space; the caller's own row does not count
    select o.instance into inst
    from public.occupancy o
    where o.room = room_slug and o.user_id <> uid
      and o.last_seen > now() - interval '90 seconds'
    group by o.instance
    having count(*) < 50
    order by count(*) desc, o.instance asc
    limit 1;

    if inst is null then
      -- smallest positive integer with no live occupants
      select g into inst
      from generate_series(1, (
        select count(distinct o2.instance)::int + 1 from public.occupancy o2
        where o2.room = room_slug and o2.user_id <> uid
          and o2.last_seen > now() - interval '90 seconds')) g
      where not exists (
        select 1 from public.occupancy o
        where o.room = room_slug and o.instance = g and o.user_id <> uid
          and o.last_seen > now() - interval '90 seconds')
      order by g limit 1;
    end if;
  end if;

  insert into public.occupancy (user_id, room, instance, last_seen)
  values (uid, room_slug, inst, now())
  on conflict (user_id) do update
    set room = excluded.room, instance = excluded.instance, last_seen = excluded.last_seen;

  if session_id is not null then
    insert into public.occupancy_sessions (user_id, session_id, last_seen)
    values (uid, join_room.session_id, now())
    on conflict on constraint occupancy_sessions_pkey do update set last_seen = excluded.last_seen;
  end if;

  -- announce a new or moved person; a stale row in the same instance was never announced as gone
  if old.user_id is null or old.room <> room_slug or old.instance <> inst then
    if old.user_id is not null and old.last_seen > now() - interval '90 seconds' then
      perform private.announce(old.room, old.instance, 'leave', uid);
    end if;
    perform private.announce(room_slug, inst, 'join', uid);
  end if;

  select count(*) into n from public.occupancy o
  where o.room = room_slug and o.instance = inst
    and o.last_seen > now() - interval '90 seconds';

  return jsonb_build_object('room', room_slug, 'instance', inst,
    'topic', 'room:' || room_slug || ':' || inst, 'here', n);
end $$;

-- 4. leave_room (body from 20261113000200) -------------------------------------------------------

create or replace function public.leave_room(session_id uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); o public.occupancy;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  -- serialize with join_room / heartbeat of the same user
  perform pg_advisory_xact_lock(hashtext('occ:' || uid::text));
  if session_id is not null then
    delete from public.occupancy_sessions s
    where s.user_id = uid and s.session_id = leave_room.session_id;
    if exists (select 1 from public.occupancy_sessions s
               where s.user_id = uid and s.last_seen > now() - interval '90 seconds') then
      return;
    end if;
  end if;
  delete from public.occupancy where user_id = uid returning * into o;
  if found and o.last_seen > now() - interval '90 seconds' then
    perform private.announce(o.room, o.instance, 'leave', uid);
  end if;
end $$;

-- 4. mod_ban (body from 20261111000900) ---------------------------------------------------------

create or replace function public.mod_ban(target uuid, reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.occupancy; why text;
begin
  perform private.require_rank_over(target, 'moderator');
  if char_length(coalesce(reason, '')) > 2000 then raise exception 'too_long'; end if;
  why := left(nullif(private.clean_text(reason), ''), 500);
  update public.profiles set banned_at = now(), ban_reason = why where id = target;
  perform pg_advisory_xact_lock(hashtext('occ:' || target::text));
  select * into o from public.occupancy where user_id = target;
  if found then
    perform private.broadcast('room:' || o.room || ':' || o.instance, 'kicked',
      jsonb_build_object('user_id', target));
    delete from public.occupancy where user_id = target;
    if o.last_seen > now() - interval '90 seconds' then
      perform private.announce(o.room, o.instance, 'leave', target);
    end if;
  end if;
  perform private.log_action(target, 'mod_ban', reason);
end $$;

-- 4, 6. purge (body from 20261113000200) ---------------------------------------------------------

create or replace function private.purge_expired() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m int; o int := 0; r int; a int; rec record;
begin
  delete from public.messages where created_at < now() - interval '15 minutes';
  get diagnostics m = row_count;
  for rec in select x.user_id, x.room, x.instance from public.occupancy x
             where x.last_seen < now() - interval '90 seconds' loop
    delete from public.occupancy where user_id = rec.user_id;
    perform private.announce(rec.room, rec.instance, 'leave', rec.user_id);
    o := o + 1;
  end loop;
  delete from public.occupancy_sessions where last_seen < now() - interval '90 seconds';
  delete from public.reports
  where status <> 'open' and handled_at < now() - interval '90 days';
  get diagnostics r = row_count;
  delete from public.mod_actions where created_at < now() - interval '1 year';
  get diagnostics a = row_count;
  delete from private.rate_limits where window_start < now() - interval '1 day';
  delete from private.account_memory
  where deleted_at < now() - interval '30 days' and (muted_until is null or muted_until < now());
  return jsonb_build_object('messages', m, 'occupancy', o, 'reports', r, 'mod_actions', a);
end $$;

-- 1. report_user (body from 20261111000900) ------------------------------------------------------

create or replace function public.report_user(target_nickname text, message_id bigint, reason text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  t public.profiles;
  m public.messages;
  clean text;
  o public.occupancy;
  mine public.occupancy;
  v_room text;
  v_instance int;
  snap jsonb;
  ctx jsonb;
  rid bigint;
  reporters int;
  report_ids jsonb;
  nick extensions.citext := lower(coalesce(target_nickname, ''))::extensions.citext;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into p from public.profiles where id = uid;
  if not found then raise exception 'no_profile'; end if;
  if p.banned_at is not null then raise exception 'banned'; end if;
  if p.rules_accepted_at is null then raise exception 'rules_not_accepted'; end if;

  if char_length(coalesce(reason, '')) > 2000 then raise exception 'too_long'; end if;
  clean := private.clean_text(reason);
  if clean = '' then raise exception 'empty'; end if;
  if char_length(clean) > 500 then raise exception 'too_long'; end if;

  if message_id is not null then
    select * into m from public.messages x where x.id = message_id;
    if not found or m.user_id is null then raise exception 'not_found'; end if;
    select * into t from public.profiles where id = m.user_id;
    if not found or not (t.nickname = nick or m.nickname = nick) then raise exception 'not_found'; end if;
  else
    select * into t from public.profiles where nickname = nick;
    if not found then raise exception 'not_found'; end if;
  end if;
  if t.id = uid then raise exception 'cannot_report_self'; end if;

  -- reports come from the room: the reporter must be live where the message was sent (or where
  -- the target is now)
  select * into mine from public.occupancy x
  where x.user_id = uid and x.last_seen > now() - interval '90 seconds';
  if not found then raise exception 'not_in_room'; end if;

  -- serialize reports per target so concurrent third reports cannot miss the auto-mute
  perform pg_advisory_xact_lock(hashtext('report:' || t.id::text));

  if message_id is not null then
    -- re-read under the lock: the message may have been purged meanwhile
    select * into m from public.messages x where x.id = message_id and x.user_id = t.id;
    if not found then raise exception 'not_found'; end if;
    v_room := m.room;
    v_instance := m.instance;
  else
    select * into o from public.occupancy where user_id = t.id;
    if found then v_room := o.room; v_instance := o.instance; end if;
  end if;
  if v_room is null or mine.room <> v_room or mine.instance <> v_instance then
    raise exception 'not_in_room';
  end if;

  if exists (select 1 from public.reports r
              where r.reporter_id = uid and r.target_id = t.id
                and r.created_at > now() - interval '10 minutes') then
    raise exception 'already_reported';
  end if;

  perform private.bump_limit('report', interval '10 minutes', 5);

  if m.id is not null then
    select coalesce(jsonb_agg(e.j order by e.created_at, e.id), '[]'::jsonb) into ctx from (
      select x.id, x.created_at, jsonb_strip_nulls(jsonb_build_object(
               'id', x.id, 'nickname', x.nickname, 'body', x.body, 'created_at', x.created_at,
               'deleted', case when x.deleted_at is not null then true end)) as j
        from public.messages x
       where x.room = v_room and x.instance = v_instance
         and x.created_at between m.created_at - interval '5 minutes' and m.created_at + interval '5 minutes'
       order by abs(extract(epoch from x.created_at - m.created_at)), x.id
       limit 10) e;
  else
    select coalesce(jsonb_agg(e.j order by e.created_at, e.id), '[]'::jsonb) into ctx from (
      select x.id, x.created_at, jsonb_strip_nulls(jsonb_build_object(
               'id', x.id, 'nickname', x.nickname, 'body', x.body, 'created_at', x.created_at,
               'deleted', case when x.deleted_at is not null then true end)) as j
        from public.messages x
       where x.room = v_room and x.instance = v_instance
       order by x.created_at desc, x.id desc
       limit 10) e;
  end if;

  snap := jsonb_build_object(
    'message', case when m.id is not null then jsonb_build_object(
      'id', m.id, 'nickname', m.nickname, 'body', m.body, 'created_at', m.created_at) end,
    'context', ctx);

  insert into public.reports (reporter_id, target_id, message_id, room, instance, reason, snapshot)
  values (uid, t.id, m.id, v_room, v_instance, clean, snap)
  returning id into rid;

  -- only reporters with a GitHub account older than 30 days count (same rule as slow mode)
  select count(distinct r.reporter_id), jsonb_agg(r.id order by r.id)
    into reporters, report_ids
    from public.reports r
    join public.profiles rp on rp.id = r.reporter_id
   where r.target_id = t.id and r.created_at > now() - interval '10 minutes'
     and rp.github_created_at <= now() - interval '30 days';

  if reporters >= 3 and t.role = 'user'
     and not exists (select 1 from public.mod_actions a
                      where a.target_id = t.id and a.action = 'auto_mute'
                        and a.created_at > now() - interval '24 hours') then
    update public.profiles
       set muted_until = greatest(coalesce(muted_until, '-infinity'), now() + interval '24 hours')
     where id = t.id;
    insert into public.mod_actions (actor_id, target_id, action, reason, details)
    values (null, t.id, 'auto_mute', 'auto: 3 reports in 10 min',
            jsonb_build_object('report_ids', report_ids));
  end if;

  return rid;
end $$;

-- 3. send_message (body from 20261111000900): rate checks before any regex work --------------------

create or replace function public.send_message(body text) returns public.messages
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  o public.occupancy;
  clean text;
  last_at timestamptz;
  recent int;
  min_gap interval;
  m public.messages;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  perform pg_advisory_xact_lock(hashtext('send:' || uid::text));

  select * into p from public.profiles where id = uid;
  if not found then raise exception 'no_profile'; end if;
  if p.banned_at is not null then raise exception 'banned'; end if;
  if p.muted_until is not null and p.muted_until > now() then raise exception 'muted'; end if;

  select * into o from public.occupancy where user_id = uid;
  if not found then raise exception 'not_in_room'; end if;
  if not exists (select 1 from public.rooms r where r.slug = o.room and r.is_open) then
    raise exception 'room_closed';
  end if;
  -- a stale row is not revived here (no capacity check); the client must join_room again
  if o.last_seen <= now() - interval '90 seconds' then raise exception 'not_in_room'; end if;

  -- rate limits first (index lookups), so a refused call never reaches the regex work below
  min_gap := case
    when p.github_created_at is null or p.github_created_at > now() - interval '30 days'
      then interval '10 seconds'
    else interval '2 seconds' end;
  select max(x.created_at) into last_at from public.messages x where x.user_id = uid;
  if last_at is not null and last_at > now() - min_gap then raise exception 'rate_limited'; end if;
  select count(*) into recent from public.messages x
   where x.user_id = uid and x.created_at > now() - interval '10 seconds';
  if recent >= 5 then raise exception 'rate_limited'; end if;

  -- cheap length guard before any regex work
  if char_length(coalesce(body, '')) > 1120 then raise exception 'too_long'; end if;
  clean := private.clean_text(body);
  if clean = '' then raise exception 'empty'; end if;
  if char_length(clean) > 280 then raise exception 'too_long'; end if;

  if exists (select 1 from public.messages d
             where d.user_id = uid and d.body = clean and d.created_at > now() - interval '60 seconds') then
    raise exception 'duplicate';
  end if;

  if exists (select 1 from public.word_filter w where clean ~* w.pattern) then
    raise exception 'filtered';
  end if;

  update public.occupancy set last_seen = now() where user_id = uid;

  insert into public.messages (room, instance, user_id, nickname, body)
  values (o.room, o.instance, uid, p.nickname, clean)
  returning * into m;

  perform private.broadcast('room:' || o.room || ':' || o.instance, 'message',
    jsonb_build_object('id', m.id, 'user_id', m.user_id, 'nickname', m.nickname, 'body', m.body,
                       'created_at', m.created_at, 'role', p.role));
  return m;
end $$;

-- 7, 10. moderation and admin caps -------------------------------------------------------------

create or replace function private.log_action(target uuid, act text, why text, det jsonb default '{}')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if char_length(coalesce(why, '')) > 2000 then raise exception 'too_long'; end if;
  insert into public.mod_actions (actor_id, target_id, action, reason, details)
  values (auth.uid(), target, act, left(nullif(private.clean_text(why), ''), 500), coalesce(det, '{}'));
end $$;

create or replace function public.mod_mute(target uuid, minutes int, reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_rank_over(target, 'moderator');
  if minutes is null or minutes not in (10, 60, 1440) then raise exception 'invalid_duration'; end if;
  -- never shortens a mute that is already longer (e.g. an auto-mute); mod_unmute lifts it
  update public.profiles
     set muted_until = greatest(coalesce(muted_until, '-infinity'), now() + make_interval(mins => minutes))
   where id = target;
  perform private.log_action(target, 'mod_mute', reason, jsonb_build_object('minutes', minutes));
end $$;

create or replace function public.admin_upsert_room(slug text, title text, kind text, lang text, is_open boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_title text; v_kind text; v_lang text;
begin
  perform private.require_rank_over(null, 'admin');
  if char_length(coalesce(title, '')) > 2000 or char_length(coalesce(kind, '')) > 2000
     or char_length(coalesce(lang, '')) > 2000 then
    raise exception 'too_long';
  end if;
  v_title := private.clean_text(title);
  if v_title = '' then raise exception 'empty'; end if;
  if char_length(v_title) > 80 then raise exception 'too_long'; end if;
  v_kind := coalesce(nullif(private.clean_text(kind), ''), 'public');
  v_lang := nullif(private.clean_text(lang), '');
  if char_length(v_kind) > 32 or char_length(coalesce(v_lang, '')) > 32 then raise exception 'too_long'; end if;
  insert into public.rooms as r (slug, title, kind, lang, is_open)
  values (slug, v_title, v_kind, v_lang, coalesce(is_open, true))
  on conflict on constraint rooms_pkey do update
    set title = excluded.title, kind = excluded.kind, lang = excluded.lang, is_open = excluded.is_open;
  perform private.log_action(null, 'admin_upsert_room', null,
    jsonb_build_object('slug', slug, 'title', v_title, 'kind', v_kind, 'lang', v_lang, 'is_open', is_open));
end $$;

create or replace function public.admin_add_filter(pattern text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare fid bigint;
begin
  perform private.require_rank_over(null, 'admin');
  -- short, backreference-free patterns only: Postgres regexes with backreferences can take
  -- exponential time, and every send runs every pattern
  if pattern is null or pattern = '' or char_length(pattern) > 200 or pattern ~ '\\[1-9]'
     or not private.is_valid_regex(pattern) then
    raise exception 'invalid_pattern';
  end if;
  if not exists (select 1 from public.word_filter w where w.pattern = admin_add_filter.pattern)
     and (select count(*) from public.word_filter) >= 100 then
    raise exception 'limit_reached';
  end if;
  begin
    insert into public.word_filter as w (pattern, created_by) values (pattern, auth.uid())
    on conflict on constraint word_filter_pattern_key do update set pattern = excluded.pattern
    returning w.id into fid;
  exception when check_violation then raise exception 'invalid_pattern';
  end;
  perform private.log_action(null, 'admin_add_filter', null,
    jsonb_build_object('filter_id', fid, 'pattern', pattern));
  return fid;
end $$;

-- 9. cached public_stats ------------------------------------------------------------------------

create table private.stats_cache (
  one boolean primary key default true check (one),
  stats jsonb not null,
  refreshed_at timestamptz not null default now()
);
alter table private.stats_cache enable row level security;
revoke all on table private.stats_cache from public, anon, authenticated;

create function private.compute_stats() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'chatting', (select count(*) from public.occupancy o where o.last_seen > now() - interval '90 seconds'),
    'users_total', (select count(*) from public.profiles),
    'users_today', (select count(*) from public.profiles p
                     where p.created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
    'messages_total', (select coalesce(sum(c.messages), 0) from private.message_counts c),
    'messages_today', (select coalesce(sum(c.messages), 0) from private.message_counts c
                        where c.day = (now() at time zone 'UTC')::date),
    'day', to_char(now() at time zone 'UTC', 'YYYY-MM-DD'),
    'as_of', now())
$$;
revoke execute on function private.compute_stats() from public, anon, authenticated;

create function private.refresh_stats() returns void
language sql security definer set search_path = '' as $$
  insert into private.stats_cache as c (one, stats, refreshed_at) values (true, private.compute_stats(), now())
  on conflict (one) do update set stats = excluded.stats, refreshed_at = excluded.refreshed_at
$$;
revoke execute on function private.refresh_stats() from public, anon, authenticated;

-- the cached row (refreshed every minute by cron); computed live only while the cache is missing or stale
create or replace function public.public_stats() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select c.stats from private.stats_cache c where c.refreshed_at > now() - interval '2 minutes'),
    private.compute_stats())
$$;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'cbreak-stats') then
    perform cron.unschedule('cbreak-stats');
  end if;
  perform cron.schedule('cbreak-stats', '* * * * *', 'select private.refresh_stats()');
end $$;

-- create or replace keeps existing grants; restate them so this file is self-describing
revoke execute on function public.nickname_available(text), public.claim_nickname(text),
  public.delete_my_account(), public.join_room(text, uuid, int), public.leave_room(uuid),
  public.mod_ban(uuid, text), public.report_user(text, bigint, text), public.send_message(text),
  public.mod_mute(uuid, int, text), public.admin_upsert_room(text, text, text, text, boolean),
  public.admin_add_filter(text) from public, anon;
grant execute on function public.nickname_available(text), public.claim_nickname(text),
  public.delete_my_account(), public.join_room(text, uuid, int), public.leave_room(uuid),
  public.mod_ban(uuid, text), public.report_user(text, bigint, text), public.send_message(text),
  public.mod_mute(uuid, int, text), public.admin_upsert_room(text, text, text, text, boolean),
  public.admin_add_filter(text) to authenticated;
revoke execute on function public.public_stats() from public;
grant execute on function public.public_stats() to anon, authenticated;

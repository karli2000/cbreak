-- Plan 5: several Claude sessions (helper processes) of one account share one occupancy row.
-- occupancy_sessions tracks each helper's liveness; the occupancy row lives while any session is live.

create table public.occupancy_sessions (
  user_id uuid not null references public.occupancy(user_id) on delete cascade,
  session_id uuid not null,
  last_seen timestamptz not null default now(),
  primary key (user_id, session_id)
);
create index occupancy_sessions_user_last_seen_idx on public.occupancy_sessions (user_id, last_seen);
alter table public.occupancy_sessions enable row level security;
revoke all on public.occupancy_sessions from anon, authenticated;

-- join_room ----------------------------------------------------------------------------------------
drop function public.join_room(text);
create function public.join_room(room_slug text, session_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  r public.rooms;
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

  perform pg_advisory_xact_lock(hashtext('room:' || room_slug));

  -- a caller who is already live in this room keeps their instance
  select o.instance into inst
  from public.occupancy o
  where o.user_id = uid and o.room = room_slug
    and o.last_seen > now() - interval '90 seconds';

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

  select count(*) into n from public.occupancy o
  where o.room = room_slug and o.instance = inst
    and o.last_seen > now() - interval '90 seconds';

  return jsonb_build_object('room', room_slug, 'instance', inst,
    'topic', 'room:' || room_slug || ':' || inst, 'here', n);
end $$;

-- heartbeat (body from 000900) ---------------------------------------------------------------------
drop function public.heartbeat();
create function public.heartbeat(session_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  o public.occupancy;
  n int;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into p from public.profiles where id = uid;
  if not found then raise exception 'no_profile'; end if;
  if p.banned_at is not null then raise exception 'banned'; end if;

  select * into o from public.occupancy where user_id = uid;
  if not found then raise exception 'not_in_room'; end if;
  if not exists (select 1 from public.rooms r where r.slug = o.room and r.is_open) then
    raise exception 'room_closed';
  end if;

  if o.last_seen <= now() - interval '90 seconds' then
    -- stale row: re-check capacity under the same lock as join_room
    perform pg_advisory_xact_lock(hashtext('room:' || o.room));
    select count(*) into n from public.occupancy x
    where x.room = o.room and x.instance = o.instance and x.user_id <> uid
      and x.last_seen > now() - interval '90 seconds';
    if n >= 50 then raise exception 'not_in_room'; end if;
  end if;

  update public.occupancy set last_seen = now() where user_id = uid;
  if session_id is not null then
    insert into public.occupancy_sessions (user_id, session_id, last_seen)
    values (uid, heartbeat.session_id, now())
    on conflict on constraint occupancy_sessions_pkey do update set last_seen = excluded.last_seen;
  end if;
  select count(*) into n from public.occupancy x
  where x.room = o.room and x.instance = o.instance
    and x.last_seen > now() - interval '90 seconds';
  return jsonb_build_object('room', o.room, 'instance', o.instance,
    'topic', 'room:' || o.room || ':' || o.instance, 'here', n);
end $$;

-- leave_room ---------------------------------------------------------------------------------------
drop function public.leave_room();
create function public.leave_room(session_id uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if session_id is null then
    delete from public.occupancy where user_id = uid;
  else
    delete from public.occupancy_sessions s
    where s.user_id = uid and s.session_id = leave_room.session_id;
    if not exists (select 1 from public.occupancy_sessions s
                   where s.user_id = uid and s.last_seen > now() - interval '90 seconds') then
      delete from public.occupancy where user_id = uid;
    end if;
  end if;
end $$;

revoke execute on function public.join_room(text, uuid), public.heartbeat(uuid),
  public.leave_room(uuid) from public, anon;
grant execute on function public.join_room(text, uuid), public.heartbeat(uuid),
  public.leave_room(uuid) to authenticated;

-- purge_expired (body from 000800) -----------------------------------------------------------------
create or replace function private.purge_expired() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m int; o int; r int; a int;
begin
  delete from public.messages where created_at < now() - interval '15 minutes';
  get diagnostics m = row_count;
  delete from public.occupancy where last_seen < now() - interval '90 seconds';
  get diagnostics o = row_count;
  delete from public.occupancy_sessions where last_seen < now() - interval '90 seconds';
  delete from public.reports
  where status <> 'open' and handled_at < now() - interval '90 days';
  get diagnostics r = row_count;
  delete from public.mod_actions where created_at < now() - interval '1 year';
  get diagnostics a = row_count;
  return jsonb_build_object('messages', m, 'occupancy', o, 'reports', r, 'mod_actions', a);
end $$;
revoke execute on function private.purge_expired() from public, anon, authenticated;

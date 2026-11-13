-- Sticky instance: a client that comes back for another break asks for the instance it was in
-- (prefer_instance), so a person meets the same people during one Claude Code session.
-- join_room body from 20261113000200 plus the prefer_instance block; old signature dropped.

drop function public.join_room(text, uuid);
create function public.join_room(room_slug text, session_id uuid default null, prefer_instance int default null)
returns jsonb
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

  -- lock order everywhere: per-user lock first, then the per-room lock
  perform pg_advisory_xact_lock(hashtext('occ:' || uid::text));
  perform pg_advisory_xact_lock(hashtext('room:' || room_slug));

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

  select count(*) into n from public.occupancy o
  where o.room = room_slug and o.instance = inst
    and o.last_seen > now() - interval '90 seconds';

  return jsonb_build_object('room', room_slug, 'instance', inst,
    'topic', 'room:' || room_slug || ':' || inst, 'here', n);
end $$;

revoke execute on function public.join_room(text, uuid, int) from public, anon;
grant execute on function public.join_room(text, uuid, int) to authenticated;

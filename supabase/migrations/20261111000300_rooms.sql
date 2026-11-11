-- Room instances and occupancy

create function public.join_room(room_slug text) returns jsonb
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

  insert into public.occupancy (user_id, room, instance, last_seen)
  values (uid, room_slug, inst, now())
  on conflict (user_id) do update
    set room = excluded.room, instance = excluded.instance, last_seen = excluded.last_seen;

  select count(*) into n from public.occupancy o
  where o.room = room_slug and o.instance = inst
    and o.last_seen > now() - interval '90 seconds';

  return jsonb_build_object('room', room_slug, 'instance', inst,
    'topic', 'room:' || room_slug || ':' || inst, 'here', n);
end $$;

create function public.heartbeat() returns jsonb
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

  if o.last_seen <= now() - interval '90 seconds' then
    -- stale row: re-check capacity under the same lock as join_room
    perform pg_advisory_xact_lock(hashtext('room:' || o.room));
    select count(*) into n from public.occupancy x
    where x.room = o.room and x.instance = o.instance and x.user_id <> uid
      and x.last_seen > now() - interval '90 seconds';
    -- raising rolls back any delete, but a stale row is never counted anyway
    if n >= 50 then raise exception 'not_in_room'; end if;
  end if;

  update public.occupancy set last_seen = now() where user_id = uid;
  select count(*) into n from public.occupancy x
  where x.room = o.room and x.instance = o.instance
    and x.last_seen > now() - interval '90 seconds';
  return jsonb_build_object('room', o.room, 'instance', o.instance,
    'topic', 'room:' || o.room || ':' || o.instance, 'here', n);
end $$;

create function public.leave_room() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  delete from public.occupancy where user_id = uid;
end $$;

create function public.room_counts() returns table(room text, instance int, here int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  return query
    select o.room, o.instance, count(*)::int
    from public.occupancy o
    where o.last_seen > now() - interval '90 seconds'
    group by o.room, o.instance
    order by o.room, o.instance;
end $$;

revoke execute on function public.join_room(text), public.heartbeat(),
  public.leave_room(), public.room_counts() from public, anon;
grant execute on function public.join_room(text), public.heartbeat(),
  public.leave_room(), public.room_counts() to authenticated;

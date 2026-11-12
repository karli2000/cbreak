-- Realtime policies: an occupancy row only counts while it is live (last_seen within 90 s),
-- the same liveness rule join_room/heartbeat/room_counts use. Otherwise unchanged from 000700.

drop policy room_members_read on realtime.messages;
drop policy room_members_presence on realtime.messages;

create policy room_members_read on realtime.messages
  for select to authenticated
  using (
    (select realtime.topic()) like 'room:%'
    and exists (select 1 from public.profiles p
                where p.id = (select auth.uid()) and p.banned_at is null)
    and (
      exists (select 1 from public.occupancy o
              where o.user_id = (select auth.uid())
                and o.last_seen > now() - interval '90 seconds'
                and 'room:' || o.room || ':' || o.instance = (select realtime.topic()))
      or (select public.is_staff())
    )
  );

create policy room_members_presence on realtime.messages
  for insert to authenticated
  with check (
    extension = 'presence'
    and (select realtime.topic()) like 'room:%'
    and exists (select 1 from public.profiles p
                where p.id = (select auth.uid()) and p.banned_at is null)
    and (
      exists (select 1 from public.occupancy o
              where o.user_id = (select auth.uid())
                and o.last_seen > now() - interval '90 seconds'
                and 'room:' || o.room || ':' || o.instance = (select realtime.topic()))
      or (select public.is_staff())
    )
  );

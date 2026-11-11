-- Realtime authorization for private room channels (topic 'room:<slug>:<n>').
-- Realtime evaluates these when a client joins a channel (and on a new access_token),
-- then caches the result for that channel; it does not re-check per message.
--
-- Read (SELECT): broadcasts + presence for the caller's current occupancy topic, or any
--   room topic for staff. Banned users never pass.
-- Write (INSERT): presence only. Chat broadcasts come solely from the database via
--   private.broadcast (security definer, bypasses RLS). This also blocks
--   realtime.send(), which is security invoker and executable by anon/authenticated:
--   its insert uses extension = 'broadcast' and fails this policy.
-- anon gets no policy, so it can neither read nor write.

create policy room_members_read on realtime.messages
  for select to authenticated
  using (
    (select realtime.topic()) like 'room:%'
    and exists (select 1 from public.profiles p
                where p.id = (select auth.uid()) and p.banned_at is null)
    and (
      exists (select 1 from public.occupancy o
              where o.user_id = (select auth.uid())
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
                and 'room:' || o.room || ':' || o.instance = (select realtime.topic()))
      or (select public.is_staff())
    )
  );

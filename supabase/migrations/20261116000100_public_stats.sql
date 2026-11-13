-- Numbers for the cbreak.dev homepage (owner, 2026-11-13): people on a break now, people registered
-- (total and today), messages sent (total and today). "Today" is the current UTC day.
--
-- Messages are purged after 15 minutes, so they are counted when inserted: one row per UTC day in
-- private.message_counts, kept forever (one small row a day). Counting starts with this migration,
-- seeded with the messages still in the table.
--
-- public_stats() is the one RPC anon may execute (a deliberate exception to "authenticated only"):
-- it returns nothing but these counts, which the homepage shows to everyone anyway.

create table private.message_counts (
  day date primary key,
  messages bigint not null default 0 check (messages >= 0)
);
alter table private.message_counts enable row level security;
revoke all on table private.message_counts from public, anon, authenticated;

create function private.count_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.message_counts (day, messages)
  values ((new.created_at at time zone 'UTC')::date, 1)
  on conflict (day) do update set messages = private.message_counts.messages + 1;
  return null;
end $$;
revoke execute on function private.count_message() from public, anon, authenticated;

create trigger messages_count after insert on public.messages
  for each row execute function private.count_message();

insert into private.message_counts (day, messages)
select (m.created_at at time zone 'UTC')::date, count(*) from public.messages m group by 1
on conflict (day) do update set messages = private.message_counts.messages + excluded.messages;

create function public.public_stats() returns jsonb
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
revoke execute on function public.public_stats() from public;
grant execute on function public.public_stats() to anon, authenticated;

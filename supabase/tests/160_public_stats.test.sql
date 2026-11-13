-- The cbreak.dev homepage numbers: public_stats() is callable without signing in and returns only
-- counts; messages are counted per UTC day by a trigger, so totals survive the 15-minute purge.
begin;
\ir _helpers.psql
select plan(15);

create temp table base on commit drop as select public.public_stats() as s;
create function pg_temp.d(k text) returns bigint language sql as
  $$ select (public.public_stats() ->> k)::bigint - (select (s ->> k)::bigint from base) $$;

select set_eq($$select jsonb_object_keys(s) from base$$,
  array['chatting', 'users_total', 'users_today', 'messages_total', 'messages_today', 'day', 'as_of'],
  'exactly the seven keys');
select is((select s ->> 'day' from base), to_char(now() at time zone 'UTC', 'YYYY-MM-DD'), 'day is the UTC date');

-- people: every profile counts; today = created since UTC midnight
select tests.create_user('stat_a') as a \gset
select tests.create_user('stat_b') as b \gset
select tests.create_user('stat_old') as old \gset
update public.profiles set created_at = now() - interval '2 days' where id = :'old';
select is(pg_temp.d('users_total'), 3::bigint, 'three more registered');
select is(pg_temp.d('users_today'), 2::bigint, 'two of them today');

-- chatting = live occupancy only
insert into public.occupancy (user_id, room, instance, last_seen) values
  (:'a', 'lobby', 1, now()), (:'old', 'lobby', 1, now() - interval '2 minutes');
select is(pg_temp.d('chatting'), 1::bigint, 'a stale occupancy row is not chatting');

-- messages: counted when inserted, per UTC day of created_at
insert into public.messages (room, instance, user_id, nickname, body) values ('lobby', 1, :'a', 'stat_a', 'one');
insert into public.messages (room, instance, user_id, nickname, body, created_at)
  values ('lobby', 1, :'a', 'stat_a', 'old', now() - interval '2 days');
select is(pg_temp.d('messages_total'), 2::bigint, 'both messages count in the total');
select is(pg_temp.d('messages_today'), 1::bigint, 'only one today');

-- the real path: send_message counts too
insert into public.occupancy (user_id, room, instance, last_seen) values (:'b', 'lobby', 1, now());
select tests.login_as(:'b');
select lives_ok($$select public.send_message('hello')$$, 'send_message works');
select tests.logout();
select is(pg_temp.d('messages_total'), 3::bigint, 'a sent message counts');
select is(pg_temp.d('messages_today'), 2::bigint, 'and counts today');

-- the purge does not lower the totals
delete from public.messages where user_id in (:'a', :'b');
select is(pg_temp.d('messages_total'), 3::bigint, 'deleting messages keeps the total');

-- anyone may read the numbers, nobody the counter table
set local role anon;
select lives_ok($$select public.public_stats()$$, 'anon can call public_stats');
select throws_ok($$select * from private.message_counts$$, '42501', null, 'anon cannot read the counters');
reset role;
select tests.login_as(:'b');
select throws_ok($$select * from private.message_counts$$, '42501', null, 'authenticated cannot read the counters');
select tests.logout();
select function_privs_are('public', 'public_stats', array[]::text[], 'anon', array['EXECUTE'], 'anon has execute');

select * from finish();
rollback;

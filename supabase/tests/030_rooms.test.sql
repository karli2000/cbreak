begin;
\ir _helpers.psql
select plan(17);

select tests.create_user('alice') as a \gset
select tests.create_user('bob') as b \gset
select tests.create_user('banned_guy') as bn \gset
select tests.create_user('norules') as nr \gset
update public.profiles set banned_at = now() where id = :'bn';
update public.profiles set rules_accepted_at = null where id = :'nr';

select throws_ok($$select public.join_room('lobby')$$, 'P0001', 'not_authenticated', 'join without JWT');

-- error paths
select tests.login_as(:'bn');
select throws_ok($$select public.join_room('lobby')$$, 'P0001', 'banned', 'banned cannot join');
select tests.login_as(:'nr');
select throws_ok($$select public.join_room('lobby')$$, 'P0001', 'rules_not_accepted', 'rules required');
select tests.login_as(:'a');
select throws_ok($$select public.join_room('nope')$$, 'P0001', 'not_found', 'unknown room');

-- first joiner
select is(public.join_room('lobby'), '{"room":"lobby","instance":1,"topic":"room:lobby:1","here":1}'::jsonb, 'first joiner gets instance 1');
select is(public.heartbeat(), '{"room":"lobby","instance":1,"topic":"room:lobby:1","here":1}'::jsonb, 'heartbeat returns same shape');

-- re-join moves the caller, one row
select is((public.join_room('lobby'))->>'instance', '1', 're-join stays in instance 1 (own row not counted)');
select tests.logout();
select is((select count(*)::int from public.occupancy where user_id = :'a'), 1, 'one row per user');

-- fill instance 1 with 49 more live users (50 total with alice)
insert into public.occupancy (user_id, room, instance)
select tests.create_user('f' || g), 'lobby', 1 from generate_series(1, 49) g;
select tests.login_as(:'b');
select is((public.join_room('lobby'))->>'instance', '2', '51st joiner gets instance 2');
select tests.logout();

-- stale rows do not count: age all instance-1 rows except alice and make room
update public.occupancy set last_seen = now() - interval '91 seconds'
 where room = 'lobby' and instance = 1 and user_id <> :'a' and user_id in
   (select user_id from public.occupancy where instance = 1 and user_id <> :'a' limit 20);
select tests.login_as(:'a');
select is((select here from public.room_counts() where instance = 1), 30, 'room_counts excludes stale rows');
select is((select count(*)::int from public.room_counts()), 2, 'two live instances');
select tests.logout();

-- fullest with space: inst1 = 30, inst2 = 10 -> inst1
insert into public.occupancy (user_id, room, instance)
select tests.create_user('g' || g), 'lobby', 2 from generate_series(1, 9) g;  -- + bob = 10
select tests.create_user('carol') as c \gset
select tests.login_as(:'c');
select is(public.join_room('lobby'), '{"room":"lobby","instance":1,"topic":"room:lobby:1","here":31}'::jsonb, 'picks fullest instance with space');
select tests.logout();

-- stale-only instance is treated as free: smallest unused number reused
delete from public.occupancy;
insert into public.occupancy (user_id, room, instance, last_seen)
select tests.create_user('h' || g), 'lobby', 1, now() - interval '5 minutes' from generate_series(1, 3) g;
select tests.login_as(:'a');
select is((public.join_room('lobby'))->>'instance', '1', 'stale occupants do not count');
select is((public.join_room('lobby'))->>'here', '1', 'here counts live only');

-- full instance 1 + gap: smallest positive integer unused
select tests.logout();
delete from public.occupancy;
insert into public.occupancy (user_id, room, instance)
select tests.create_user('i' || g), 'lobby', 1 from generate_series(1, 50) g;
insert into public.occupancy (user_id, room, instance)
select tests.create_user('j' || g), 'lobby', 3 from generate_series(1, 50) g;
select tests.login_as(:'a');
select is((public.join_room('lobby'))->>'instance', '2', 'smallest unused number when all full');

-- closed room
select tests.logout();
insert into public.rooms (slug, title, is_open) values ('shut', 'Shut', false);
select tests.login_as(:'a');
select throws_ok($$select public.join_room('shut')$$, 'P0001', 'room_closed', 'closed room');

-- leave / heartbeat
select public.leave_room();
select throws_ok($$select public.heartbeat()$$, 'P0001', 'not_in_room', 'heartbeat after leaving');
select tests.logout();

select * from finish();
rollback;

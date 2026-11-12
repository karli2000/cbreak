begin;
\ir _helpers.psql
select plan(27);

-- users
select tests.create_user('rauth') as au \gset
select tests.create_user('rm1') as m1 \gset
select tests.create_user('rm2') as m2 \gset
select tests.create_user('rstale') as st \gset
select tests.create_user('rbanned') as bn \gset
select tests.create_user('rmod', 'moderator') as md \gset
select tests.create_user('rbmod', 'moderator') as bm \gset
select tests.create_user('rclosed') as cl \gset
select tests.create_user('ren') as rn \gset
select tests.create_user('rpt1') as p1 \gset
select tests.create_user('rpt2') as p2 \gset
select tests.create_user('rkick') as kk \gset
update public.profiles set banned_at = now() where id in (:'bn', :'bm');

insert into public.rooms (slug, title, is_open) values ('shut-x', 'Shut', false);
insert into public.occupancy (user_id, room, instance, last_seen) values
  (:'m1', 'lobby', 1, now()),
  (:'m2', 'lobby', 2, now()),
  (:'st', 'lobby', 1, now() - interval '91 seconds'),
  (:'bn', 'lobby', 1, now()),
  (:'cl', 'shut-x', 1, now()),
  (:'kk', 'lobby', 1, now());

insert into public.messages (room, instance, user_id, nickname, body) values
  ('lobby', 1, :'au', 'rauth', 'rl-1a'),
  ('lobby', 1, :'au', 'rauth', 'rl-1b'),
  ('lobby', 2, :'au', 'rauth', 'rl-2a');
insert into public.messages (room, instance, user_id, nickname, body, deleted_at)
  values ('lobby', 1, :'au', 'rauth', 'rl-1del', now());

-- 1. REST read path on messages mirrors the realtime rule
select tests.login_as(:'m1');
select is((select count(*)::int from public.messages where body like 'rl-%' and instance = 1), 2,
  'member of lobby:1 sees its live messages');
select is((select count(*)::int from public.messages where body like 'rl-%' and instance = 2), 0,
  'member of lobby:1 sees nothing from lobby:2');
select is((select count(*)::int from public.messages where body like 'rl-%' and deleted_at is not null), 0,
  'soft-deleted rows are never readable');
select tests.login_as(:'m2');
select is((select count(*)::int from public.messages where body like 'rl-%' and instance = 1), 0,
  'member of another instance sees none of lobby:1');
select tests.login_as(:'st');
select is((select count(*)::int from public.messages where body like 'rl-%'), 0, 'stale occupancy sees none');
select tests.login_as(:'bn');
select is((select count(*)::int from public.messages where body like 'rl-%'), 0, 'banned with live row sees none');
select tests.login_as(:'md');
select is((select count(*)::int from public.messages where body like 'rl-%'), 3, 'moderator without occupancy sees all live');
select tests.login_as(:'bm');
select is((select count(*)::int from public.messages where body like 'rl-%'), 0, 'banned moderator sees none');
select tests.logout();

-- 2. stale occupancy row cannot send (same contract as heartbeat)
select tests.login_as(:'st');
select throws_ok($$select public.send_message('stale send')$$, 'P0001', 'not_in_room', 'stale row: send refused');
select tests.logout();
select ok((select last_seen < now() - interval '90 seconds' from public.occupancy where user_id = :'st'),
  'stale row not revived');
select is((select count(*)::int from public.messages where body = 'stale send'), 0, 'nothing stored');

-- 3. closed rooms
select tests.login_as(:'cl');
select throws_ok($$select public.send_message('closed send')$$, 'P0001', 'room_closed', 'send in closed room');
select throws_ok($$select public.heartbeat()$$, 'P0001', 'room_closed', 'heartbeat in closed room');
select tests.login_as(:'m1');
select lives_ok($$select public.heartbeat()$$, 'heartbeat in open room still works');

-- 4a. message payload carries user_id
select lives_ok($$select public.send_message('payload check')$$, 'member can send');
select tests.logout();
select is((select array_agg(k order by k) from realtime.messages r, jsonb_object_keys(r.payload) k
            where r.topic = 'room:lobby:1' and r.event = 'message' and r.payload->>'body' = 'payload check'),
  array['body', 'created_at', 'id', 'nickname', 'role', 'user_id'], 'message payload keys');
select is((select payload->>'user_id' from realtime.messages
            where topic = 'room:lobby:1' and event = 'message' and payload->>'body' = 'payload check'),
  :'m1'::text, 'payload user_id is the sender');

-- 4b. report_user resolves the target from the message (author renamed)
insert into public.messages (room, instance, user_id, nickname, body) values ('lobby', 1, :'rn', 'ren', 'rude line');
select id as rmid from public.messages where body = 'rude line' \gset
update public.profiles set nickname = 'ren_new' where id = :'rn';
-- someone else takes the freed old name
select tests.create_user('ren_two') as rn2 \gset
update public.profiles set nickname = 'ren' where id = :'rn2';
select tests.login_as(:'p1');
select ok((select public.report_user('ren', :'rmid', 'rude')) > 0, 'old nickname + message id files a report');
select tests.logout();
select is((select target_id from public.reports where reporter_id = :'p1'), :'rn'::uuid,
  'report filed against the message author, not the new holder of the name');
select tests.login_as(:'p2');
select ok((select public.report_user('REN_NEW', :'rmid', 'rude')) > 0, 'current nickname + message id');
select tests.logout();
select is((select target_id from public.reports where reporter_id = :'p2'), :'rn'::uuid, 'current-name report hits the author');
select tests.login_as(:'p2');
select throws_ok(format($$select public.report_user('rm1', %s, 'x')$$, :'rmid'), 'P0001', 'not_found',
  'nickname unrelated to the message author');
select throws_ok($$select public.report_user('ren', 999999999, 'x')$$, 'P0001', 'not_found', 'missing message');
select tests.login_as(:'rn');
select throws_ok(format($$select public.report_user('ren', %s, 'x')$$, :'rmid'), 'P0001', 'cannot_report_self',
  'author reporting own message by old name');
select tests.login_as(:'p1');
select ok((select public.report_user('ren', null, 'x')) > 0, 'nickname path without message id still works');
select tests.logout();
select is((select target_id from public.reports where reporter_id = :'p1' and message_id is null), :'rn2'::uuid,
  'nickname path resolves the current holder');

-- 5. kicked payload is {user_id} only (realtime.send itself adds a generated uuid `id` when the
--    payload has none, so the stored keys are id + user_id; no reason)
select tests.login_as(:'md');
select public.mod_ban(:'kk', 'secret reason');
select tests.logout();
select is((select array_agg(k order by k) from realtime.messages r, jsonb_object_keys(r.payload) k
            where r.topic = 'room:lobby:1' and r.event = 'kicked' and r.payload->>'user_id' = :'kk'),
  array['id', 'user_id'], 'kicked payload: user_id (+ realtime id), no reason');

select * from finish();
rollback;

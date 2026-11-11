begin;
\ir _helpers.psql
select plan(27);

select tests.create_user('rep1') as r1 \gset
select tests.create_user('rep2') as r2 \gset
select tests.create_user('rep3') as r3 \gset
select tests.create_user('villain') as v \gset
select tests.create_user('other') as o \gset
select tests.create_user('bad_one') as bd \gset
select tests.create_user('noroom') as nr \gset
select tests.create_user('ban_rep') as br \gset
update public.profiles set banned_at = now() where id = :'br';
select tests.create_auth_user() as np \gset

insert into public.occupancy (user_id, room, instance) values (:'v', 'lobby', 1);
insert into public.messages (room, instance, user_id, nickname, body, created_at) values
  ('lobby', 1, :'o', 'other', 'ctx before', now() - interval '2 minutes'),
  ('lobby', 1, :'v', 'villain', 'the bad line', now() - interval '1 minute'),
  ('lobby', 1, :'o', 'other', 'ctx after', now() - interval '30 seconds'),
  ('lobby', 1, :'o', 'other', 'far away', now() - interval '12 minutes'),
  ('lobby', 2, :'o', 'other', 'other instance', now() - interval '1 minute');
insert into public.messages (room, instance, user_id, nickname, body, created_at, deleted_at)
  values ('lobby', 1, :'o', 'other', 'deleted ctx', now() - interval '45 seconds', now());
select id as mid from public.messages where body = 'the bad line' \gset
select id as oid from public.messages where body = 'ctx before' \gset

select throws_ok($$select public.report_user('villain', null, 'x')$$, 'P0001', 'not_authenticated', 'no JWT');
select tests.login_as(:'np');
select throws_ok($$select public.report_user('villain', null, 'x')$$, 'P0001', 'no_profile', 'no profile');
select tests.login_as(:'br');
select throws_ok($$select public.report_user('villain', null, 'x')$$, 'P0001', 'banned', 'banned cannot report');

select tests.login_as(:'r1');
select throws_ok($$select public.report_user('villain', null, '')$$, 'P0001', 'empty', 'empty reason');
select throws_ok($$select public.report_user('villain', null, E'  \x1b\n ')$$, 'P0001', 'empty', 'reason empty after cleaning');
select throws_ok($$select public.report_user('villain', null, repeat('x', 501))$$, 'P0001', 'too_long', '501 chars');
select throws_ok($$select public.report_user('nobody_here', null, 'x')$$, 'P0001', 'not_found', 'unknown nickname');
select throws_ok($$select public.report_user('rep1', null, 'x')$$, 'P0001', 'cannot_report_self', 'self');
select throws_ok($$select public.report_user('REP1', null, 'x')$$, 'P0001', 'cannot_report_self', 'self, case-insensitive');
select throws_ok($$select public.report_user('villain', 999999999, 'x')$$, 'P0001', 'not_found', 'purged message');
select throws_ok(format($$select public.report_user('villain', %s, 'x')$$, :'oid'), 'P0001', 'not_found', 'message of someone else');

-- happy path with message
select ok((select public.report_user('VILLAIN', :'mid', E'spam\x1b[2J ')) > 0, 'report returns id');
select tests.logout();
select is((select status::text from public.reports where reporter_id = :'r1'), 'open', 'status open');
select is((select reason from public.reports where reporter_id = :'r1'), 'spam[2J', 'reason cleaned and trimmed');
select is((select snapshot->'message'->>'body' from public.reports where reporter_id = :'r1'), 'the bad line', 'snapshot message');
select is((select array_agg(c->>'body' order by c->>'created_at') from public.reports r, jsonb_array_elements(r.snapshot->'context') c where r.reporter_id = :'r1'),
  array['ctx before','the bad line','deleted ctx','ctx after'], 'context: same instance, +-5 min only');
select is((select (c->>'deleted')::boolean from public.reports r, jsonb_array_elements(r.snapshot->'context') c where r.reporter_id = :'r1' and c->>'body' = 'deleted ctx'), true, 'soft-deleted flagged');

select tests.login_as(:'r1');
select throws_ok($$select public.report_user('villain', null, 'again')$$, 'P0001', 'already_reported', 'duplicate within 10 min');
select tests.logout();

-- null message: last messages of target's instance
select tests.login_as(:'r2');
select public.report_user('villain', null, 'rude');
select tests.logout();
select is((select snapshot->'message' from public.reports where reporter_id = :'r2'), 'null'::jsonb, 'null message in snapshot');
select is((select jsonb_array_length(snapshot->'context') from public.reports where reporter_id = :'r2'), 5, 'instance-1 lines (no instance 2)');
select is((select muted_until from public.profiles where id = :'v'), null, '2 reporters: not muted');

-- target without occupancy: empty context
select tests.login_as(:'r2');
select public.report_user('noroom', null, 'rude');
select tests.logout();
select is((select snapshot->'context' from public.reports where target_id = :'nr'), '[]'::jsonb, 'no occupancy: empty context');

-- third distinct reporter mutes
select tests.login_as(:'r3');
select public.report_user('villain', null, 'rude');
select tests.logout();
select ok((select muted_until between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute' from public.profiles where id = :'v'), '3 reporters: muted 24h');
select is((select count(*)::int from public.mod_actions where target_id = :'v' and action = 'auto_mute' and actor_id is null), 1, 'auto_mute logged');
select is((select jsonb_array_length(details->'report_ids') from public.mod_actions where target_id = :'v'), 3, 'details has report ids');

-- stale reports do not count / old report does not block
update public.reports set created_at = now() - interval '11 minutes' where reporter_id = :'r1' and target_id = :'v';
select tests.login_as(:'r1');
select lives_ok($$select public.report_user('villain', null, 'still rude')$$, 'report after 10 min allowed');
select tests.logout();
select is((select count(*)::int from public.mod_actions where target_id = :'v' and action = 'auto_mute'), 1, 'no second auto_mute while muted');

select * from finish();
rollback;

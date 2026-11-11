begin;
\ir _helpers.psql
select plan(40);

select tests.create_user('usr') as u \gset
select tests.create_user('victim') as v \gset
select tests.create_user('mod1', 'moderator') as m \gset
select tests.create_user('mod2', 'moderator') as m2 \gset
select tests.create_user('adm', 'admin') as a \gset
select tests.create_user('adm2', 'admin') as a2 \gset

insert into public.occupancy (user_id, room, instance) values (:'v', 'lobby', 1);
insert into public.messages (room, instance, user_id, nickname, body) values ('lobby', 1, :'v', 'victim', 'hello');
insert into public.messages (room, instance, user_id, nickname, body) values ('lobby', 1, :'m2', 'mod2', 'modline');
select id as mid from public.messages where body = 'hello' \gset
select id as mmid from public.messages where body = 'modline' \gset
insert into public.reports (reporter_id, target_id, reason, snapshot) values (:'u', :'v', 'spam', '{}');
select id as rid from public.reports limit 1 \gset

-- plain user is forbidden everywhere
select tests.login_as(:'u');
select throws_ok(format($$select public.mod_delete_message(%s, 'x')$$, :'mid'), 'P0001', 'forbidden', 'user: delete');
select throws_ok(format($$select public.mod_mute('%s', 10, 'x')$$, :'v'), 'P0001', 'forbidden', 'user: mute');
select throws_ok(format($$select public.mod_ban('%s', 'x')$$, :'v'), 'P0001', 'forbidden', 'user: ban');
select throws_ok(format($$select public.mod_resolve_report(%s, 'dismissed')$$, :'rid'), 'P0001', 'forbidden', 'user: resolve');
select throws_ok($$select public.mod_lookup_user('victim')$$, 'P0001', 'forbidden', 'user: lookup');
select throws_ok($$select public.admin_add_filter('x')$$, 'P0001', 'forbidden', 'user: admin_*');
-- moderator is forbidden on admin_*
select tests.login_as(:'m');
select throws_ok(format($$select public.admin_set_role('%s', 'moderator')$$, :'v'), 'P0001', 'forbidden', 'mod: set_role');
select throws_ok(format($$select public.admin_unban('%s', 'x')$$, :'v'), 'P0001', 'forbidden', 'mod: unban');
select throws_ok($$select public.admin_upsert_room('r1', 'R', 'public', null, true)$$, 'P0001', 'forbidden', 'mod: upsert_room');
select throws_ok($$select public.admin_remove_filter(1)$$, 'P0001', 'forbidden', 'mod: remove_filter');
-- rank rule
select throws_ok(format($$select public.mod_ban('%s', 'x')$$, :'m2'), 'P0001', 'forbidden', 'mod cannot ban mod');
select throws_ok(format($$select public.mod_ban('%s', 'x')$$, :'a'), 'P0001', 'forbidden', 'mod cannot ban admin');
select throws_ok(format($$select public.mod_ban('%s', 'x')$$, :'m'), 'P0001', 'forbidden', 'cannot ban self');
select throws_ok(format($$select public.mod_delete_message(%s, 'x')$$, :'mmid'), 'P0001', 'forbidden', 'mod cannot delete mod message');
select throws_ok($$select public.mod_delete_message(999999999, 'x')$$, 'P0001', 'not_found', 'missing message');
select throws_ok(format($$select public.mod_mute('%s', 15, 'x')$$, :'v'), 'P0001', 'invalid_duration', 'bad duration');
select throws_ok($$select public.mod_mute(gen_random_uuid(), 10, 'x')$$, 'P0001', 'not_found', 'unknown target');

-- mute / unmute
select public.mod_mute(:'v', 60, 'spam');
select tests.logout();
select ok((select muted_until between now() + interval '59 minutes' and now() + interval '61 minutes' from public.profiles where id = :'v'), 'muted ~60 min');
select tests.login_as(:'m');
select public.mod_unmute(:'v', 'ok');
select tests.logout();
select is((select muted_until from public.profiles where id = :'v'), null, 'unmuted');

-- delete message
select tests.login_as(:'m');
select public.mod_delete_message(:'mid', 'rude');
select tests.logout();
select is((select deleted_by from public.messages where id = :'mid'), :'m'::uuid, 'deleted_by set');
select is((select count(*)::int from realtime.messages where topic = 'room:lobby:1' and event = 'deleted' and (payload->>'id')::bigint = :'mid'), 1, 'deleted broadcast');
select tests.login_as(:'u');
select is((select count(*)::int from public.messages where id = :'mid'), 0, 'hidden from users');
select tests.login_as(:'m');
select throws_ok(format($$select public.mod_delete_message(%s, 'x')$$, :'mid'), 'P0001', 'not_found', 'already deleted');

-- ban
select public.mod_ban(:'v', 'harassment');
select tests.logout();
select is((select count(*)::int from public.occupancy where user_id = :'v'), 0, 'occupancy removed');
select is((select count(*)::int from realtime.messages where topic = 'room:lobby:1' and event = 'kicked' and payload->>'user_id' = :'v'), 1, 'kicked broadcast');
select tests.login_as(:'v');
select throws_ok($$select public.send_message('hi')$$, 'P0001', 'banned', 'banned send');
select throws_ok($$select public.join_room('lobby')$$, 'P0001', 'banned', 'banned join');
select tests.login_as(:'a');
select public.admin_unban(:'v', 'sorry');
select public.mod_ban(:'m', 'admin bans mod');
select tests.logout();
select ok((select banned_at is null from public.profiles where id = :'v'), 'unbanned');
select ok((select banned_at is not null from public.profiles where id = :'m'), 'admin banned moderator');

-- resolve report
select tests.login_as(:'m2');
select throws_ok(format($$select public.mod_resolve_report(%s, 'open')$$, :'rid'), 'P0001', 'forbidden', 'cannot resolve to open');
select throws_ok($$select public.mod_resolve_report(999999999, 'dismissed')$$, 'P0001', 'not_found', 'unknown report');
select public.mod_resolve_report(:'rid', 'actioned');
select tests.logout();
select is((select handled_by from public.reports where id = :'rid'), :'m2'::uuid, 'handled_by set');

-- admin functions
select tests.login_as(:'a');
select throws_ok(format($$select public.admin_set_role('%s', 'user')$$, :'a2'), 'P0001', 'forbidden', 'admin cannot change other admin');
select public.admin_set_role(:'v', 'moderator');
select public.admin_upsert_room('side-room', 'Side', 'public', 'en', true);
select throws_ok($$select public.admin_add_filter('(')$$, 'P0001', 'invalid_pattern', 'invalid regex');
select public.admin_add_filter('badw');
select tests.logout();
select is((select role::text from public.profiles where id = :'v'), 'moderator', 'role changed');
select is((select title from public.rooms where slug = 'side-room'), 'Side', 'room upserted');

-- lookup (read only) and audit trail
select tests.login_as(:'m2');
select is((select public.mod_lookup_user('VICTIM')->'profile'->>'id'), :'v', 'lookup by nickname');
select is(jsonb_array_length(public.mod_lookup_user('victim')->'reports_against'), 1, 'lookup reports');
select tests.logout();
select is((select count(*)::int from public.mod_actions), 10, 'one mod_actions row per successful call, none for lookups or failures');

select is((select array_agg(action || ':' || actor_id || ':' || coalesce(target_id::text, '-') order by id) from public.mod_actions),
  array['mod_mute:'||:'m'||':'||:'v', 'mod_unmute:'||:'m'||':'||:'v', 'mod_delete_message:'||:'m'||':'||:'v',
        'mod_ban:'||:'m'||':'||:'v', 'admin_unban:'||:'a'||':'||:'v', 'mod_ban:'||:'a'||':'||:'m',
        'mod_resolve_report:'||:'m2'||':'||:'v', 'admin_set_role:'||:'a'||':'||:'v',
        'admin_upsert_room:'||:'a'||':-', 'admin_add_filter:'||:'a'||':-'], 'audit rows: actor, target, action');

select * from finish();
rollback;

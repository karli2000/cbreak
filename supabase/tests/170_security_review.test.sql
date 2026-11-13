-- Security review fixes (migration 20261117000100).
begin;
\ir _helpers.psql
select plan(75);

delete from private.stats_cache;

-- fixtures -----------------------------------------------------------------------------------------
select tests.create_user('sr_a') as a \gset
select tests.create_user('sr_b') as b \gset
select tests.create_user('sr_c') as c \gset
select tests.create_user('sr_young', 'user', '10 days') as young \gset
select tests.create_user('sr_victim') as v \gset
select tests.create_user('sr_far') as far \gset
select tests.create_user('sr_norules') as nr \gset
update public.profiles set rules_accepted_at = null where id = :'nr';
select tests.create_user('sr_mod', 'moderator') as mod \gset
select tests.create_user('sr_adm', 'admin') as adm \gset
insert into public.occupancy (user_id, room, instance) values
  (:'a', 'lobby', 1), (:'b', 'lobby', 1), (:'c', 'lobby', 1), (:'young', 'lobby', 1), (:'v', 'lobby', 1),
  (:'far', 'lobby', 2), (:'nr', 'lobby', 1), (:'mod', 'lobby', 1);
insert into public.messages (room, instance, user_id, nickname, body, created_at) values ('lobby', 1, :'v', 'sr_victim', 'grr', now() - interval '1 minute');
select id as mid from public.messages where body = 'grr' \gset

-- 1. report_user guards ----------------------------------------------------------------------------
select tests.login_as(:'nr');
select throws_ok($$select public.report_user('sr_victim', null, 'x')$$, 'P0001', 'rules_not_accepted', 'a reporter must have accepted the rules');
select tests.login_as(:'far');
select throws_ok($$select public.report_user('sr_victim', null, 'x')$$, 'P0001', 'not_in_room', 'another instance: not_in_room (target row)');
select throws_ok(format($$select public.report_user('sr_victim', %s, 'x')$$, :'mid'), 'P0001', 'not_in_room', 'another instance: not_in_room (message)');
select tests.logout();
delete from public.occupancy where user_id = :'far';
select tests.login_as(:'far');
select throws_ok($$select public.report_user('sr_victim', null, 'x')$$, 'P0001', 'not_in_room', 'reporter outside any room');
select tests.logout();
delete from public.occupancy where user_id = :'v';
select tests.login_as(:'a');
select throws_ok($$select public.report_user('sr_victim', null, 'x')$$, 'P0001', 'not_in_room', 'target outside any room, no message: not_in_room');
select lives_ok(format($$select public.report_user('sr_victim', %s, 'x')$$, :'mid'), 'a message from the reporter''s instance can still be reported');
select tests.login_as(:'young');
select lives_ok(format($$select public.report_user('sr_victim', %s, 'x')$$, :'mid'), 'a young account can report');
select tests.login_as(:'b');
select public.report_user('sr_victim', :'mid', 'x');
select tests.logout();
select is((select muted_until from public.profiles where id = :'v'), null, 'three reporters, one younger than 30 days: no auto-mute');
select tests.login_as(:'c');
select public.report_user('sr_victim', :'mid', 'x');
select tests.logout();
select ok((select muted_until > now() + interval '23 hours' from public.profiles where id = :'v'), 'the third aged reporter mutes');
select is((select jsonb_array_length(details->'report_ids') from public.mod_actions where target_id = :'v' and action = 'auto_mute'), 3, 'only the counted reports are listed');

-- one auto-mute per target per 24 h, even after the mute was shortened
update public.profiles set muted_until = now() + interval '1 hour' where id = :'v';
update public.reports set created_at = now() - interval '11 minutes' where target_id = :'v';
select tests.login_as(:'a'); select public.report_user('sr_victim', :'mid', 'y');
select tests.login_as(:'b'); select public.report_user('sr_victim', :'mid', 'y');
select tests.login_as(:'c'); select public.report_user('sr_victim', :'mid', 'y');
select tests.logout();
select is((select count(*)::int from public.mod_actions where target_id = :'v' and action = 'auto_mute'), 1, 'no second auto-mute within 24 h');
select ok((select muted_until < now() + interval '2 hours' from public.profiles where id = :'v'), 'the shortened mute stays');

-- at most 5 reports per reporter per 10 minutes
select tests.logout();
insert into public.messages (room, instance, user_id, nickname, body)
select 'lobby', 1, :'b', 'sr_b', 'm' || g from generate_series(1, 5) g;
-- a filed 2 reports in the last 10 minutes (the counter counts successes, not report rows)
select tests.login_as(:'a');
select lives_ok($$select public.report_user('sr_b', null, 'r1')$$, 'report 3 in 10 min');
select tests.logout();
update public.reports set created_at = now() - interval '11 minutes' where reporter_id = :'a' and target_id = :'b';
select tests.login_as(:'a');
select lives_ok($$select public.report_user('sr_b', null, 'r2')$$, 'report 4 in 10 min');
select tests.logout();
update public.reports set created_at = now() - interval '11 minutes' where reporter_id = :'a' and target_id = :'b';
select tests.login_as(:'a');
select lives_ok($$select public.report_user('sr_b', null, 'r3')$$, 'report 5 in 10 min');
select tests.logout();
update public.reports set created_at = now() - interval '11 minutes' where reporter_id = :'a' and target_id = :'b';
select tests.login_as(:'a');
select throws_ok($$select public.report_user('sr_b', null, 'r4')$$, 'P0001', 'rate_limited', 'the 6th report in 10 minutes is refused');
select tests.logout();
update private.rate_limits set window_start = now() - interval '11 minutes' where user_id = :'a' and kind = 'report';
select tests.login_as(:'a');
select lives_ok($$select public.report_user('sr_b', null, 'r5')$$, 'a new window allows reports again');
select tests.logout();

-- 2. a first claim needs a GitHub identity --------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'email-only@test.local', now(), now());
select tests.login_as('00000000-0000-4000-8000-000000000001');
select throws_ok($$select public.claim_nickname('emailonly')$$, 'P0001', 'github_required', 'no GitHub identity: no profile');
select tests.logout();

-- 5. reserved names in one place --------------------------------------------------------------
select tests.create_auth_user(770001) as gh1 \gset
select tests.login_as(:'gh1');
select is(public.nickname_available('cbreak'), false, 'cbreak is not available');
select is(public.nickname_available('unknown'), false, 'unknown is not available');
select throws_ok($$select public.claim_nickname('deleted')$$, 'P0001', 'nickname_reserved', 'deleted is reserved');
select throws_ok($$select public.claim_nickname('cbreak')$$, 'P0001', 'nickname_reserved', 'cbreak is reserved');
select tests.logout();

-- 6. account memory ----------------------------------------------------------------------------
select tests.create_auth_user(770002) as gone \gset
select tests.login_as(:'gone');
select public.claim_nickname('keeper');
select tests.logout();
update public.profiles set nickname_changed_at = now() - interval '1 day', muted_until = now() + interval '1 hour' where id = :'gone';
select tests.login_as(:'gone');
select public.delete_my_account();
select tests.logout();
select is((select nickname::text from private.account_memory where github_id_hash = private.github_hash(770002)), 'keeper', 'the memory keeps the nickname');
select tests.login_as(:'gh1');
select is(public.nickname_available('keeper'), false, 'a just-released nickname is not available to others');
select throws_ok($$select public.claim_nickname('keeper')$$, 'P0001', 'nickname_taken', 'nor claimable by others');
select tests.logout();
select tests.create_auth_user(770002) as back \gset
select tests.login_as(:'back');
select is(public.nickname_available('keeper'), true, 'available to its owner');
select throws_ok($$select public.claim_nickname('another')$$, 'P0001', 'nickname_change_too_soon', 'the rename cool-down carries over');
select is((public.claim_nickname('keeper')).nickname::text, 'keeper', 'the owner gets the name back');
select tests.logout();
select ok((select nickname_changed_at between now() - interval '25 hours' and now() - interval '23 hours' from public.profiles where id = :'back'), 'nickname_changed_at carried over');
select ok((select muted_until between now() + interval '59 minutes' and now() + interval '61 minutes' from public.profiles where id = :'back'), 'an active mute carries over');
update private.account_memory set deleted_at = now() - interval '8 days' where github_id_hash = private.github_hash(770002);
select tests.login_as(:'back');
select public.delete_my_account();
select tests.logout();
update private.account_memory set deleted_at = now() - interval '8 days', muted_until = null where github_id_hash = private.github_hash(770002);
select tests.login_as(:'gh1');
select is(public.nickname_available('keeper'), true, 'after 7 days the name is free');
select tests.logout();
update private.account_memory set deleted_at = now() - interval '31 days' where github_id_hash = private.github_hash(770002);
select private.purge_expired();
select is((select count(*)::int from private.account_memory where github_id_hash = private.github_hash(770002)), 0, 'the purge drops memory older than 30 days');

-- 3. join_room is capped per user ----------------------------------------------------------------
select tests.login_as(:'a');
select lives_ok($$select public.join_room('lobby')$$, 'join 1');
select tests.logout();
update private.rate_limits set count = 30 where user_id = :'a' and kind = 'join';
select tests.login_as(:'a');
select throws_ok($$select public.join_room('lobby')$$, 'P0001', 'rate_limited', 'the 31st join in a minute is refused');
select tests.logout();
select is((select count from private.rate_limits where user_id = :'a' and kind = 'join'), 30, 'a refused call does not count');
update private.rate_limits set window_start = now() - interval '2 minutes' where user_id = :'a' and kind = 'join';
select tests.login_as(:'a');
select lives_ok($$select public.join_room('lobby')$$, 'a new window allows joins again');
select tests.logout();
select is((select count from private.rate_limits where user_id = :'a' and kind = 'join'), 1, 'the window restarted');

-- 4. server-sourced presence ----------------------------------------------------------------------
delete from realtime.messages;
select tests.create_user('sr_new') as nw \gset
select tests.login_as(:'nw');
select public.join_room('lobby');
select tests.logout();
select is((select count(*)::int from realtime.messages where event = 'presence'), 1, 'a join announces once');
select is((select payload - 'id' from realtime.messages where event = 'presence'),
  jsonb_build_object('event', 'join', 'user_id', :'nw', 'nickname', 'sr_new', 'here',
    (select count(*) from public.occupancy where room = 'lobby' and instance = 1)),
  'join payload: event, user_id, nickname from profiles, live count');
select is((select topic from realtime.messages where event = 'presence'), 'room:lobby:1', 'on the instance topic');
select tests.login_as(:'nw');
select public.join_room('lobby');
select tests.logout();
select is((select count(*)::int from realtime.messages where event = 'presence'), 1, 'a repeated join of a live member announces nothing');
select tests.login_as(:'nw');
select public.leave_room();
select tests.logout();
select is((select payload->>'event' from realtime.messages where event = 'presence' order by inserted_at desc, id desc limit 1), 'leave', 'leaving announces leave');
select is((select (payload->>'here')::int from realtime.messages where event = 'presence' order by inserted_at desc, id desc limit 1),
  (select count(*)::int from public.occupancy where room = 'lobby' and instance = 1), 'leave count excludes the leaver');
delete from realtime.messages;
update public.occupancy set last_seen = now() - interval '2 minutes' where user_id = :'c';
select private.purge_expired();
select is((select payload->>'nickname' from realtime.messages where event = 'presence'), 'sr_c', 'the purge announces a stale row as gone');
delete from realtime.messages;
select tests.login_as(:'adm');
select public.mod_ban(:'b', 'bye');
select tests.logout();
select is((select array_agg(event order by event) from realtime.messages), array['kicked', 'presence'], 'a ban kicks and announces the leave');
delete from realtime.messages;
select tests.login_as(:'a');
select public.delete_my_account();
select tests.logout();
select is((select payload->>'event' from realtime.messages where event = 'presence'), 'leave', 'deleting the account announces the leave');

-- 8. clean_text ----------------------------------------------------------------------------------
select is(private.clean_text(E'a​b﻿c­d⁠e'), 'abcde', 'zero-width characters are stripped');
select is(private.clean_text(E'‍‍️'), '', 'only joiners and selectors: empty');
select is(private.clean_text(E'‎'), '', 'only a bidi mark: empty');
select is(private.clean_text(E'\U0001F468‍\U0001F469'), E'\U0001F468‍\U0001F469', 'a ZWJ sequence is kept');

-- 3. send_message: a refused call is cheap (rate check before the body) -------------------------
update public.profiles set muted_until = null where id = :'v';
insert into public.occupancy (user_id, room, instance) values (:'v', 'lobby', 1);
select tests.login_as(:'v');
select lives_ok($$select public.send_message('first')$$, 'send');
select throws_ok(format($$select public.send_message('%s')$$, repeat('x', 2000)), 'P0001', 'rate_limited', 'rate_limited before the length check');
select tests.logout();

-- 10. mod_mute never shortens -------------------------------------------------------------------
update public.profiles set muted_until = now() + interval '20 hours' where id = :'v';
select tests.login_as(:'mod');
select public.mod_mute(:'v', 10, 'x');
select tests.logout();
select ok((select muted_until > now() + interval '19 hours' from public.profiles where id = :'v'), 'a shorter mod_mute keeps the longer mute');
select tests.login_as(:'mod');
select public.mod_unmute(:'v', 'x');
select public.mod_mute(:'v', 60, 'x');
select tests.logout();
select ok((select muted_until between now() + interval '59 minutes' and now() + interval '61 minutes' from public.profiles where id = :'v'), 'unmute then mute sets the new length');

-- 7. caps for staff input ----------------------------------------------------------------------
select tests.login_as(:'mod');
select throws_ok(format($$select public.mod_mute('%s', 10, '%s')$$, :'v', repeat('x', 2001)), 'P0001', 'too_long', 'a 2001-char reason is refused');
select tests.login_as(:'adm');
select throws_ok(format($$select public.admin_add_filter('%s')$$, repeat('a', 201)), 'P0001', 'invalid_pattern', 'a 201-char pattern is refused');
select throws_ok($$select public.admin_add_filter('(a)\1')$$, 'P0001', 'invalid_pattern', 'a backreference is refused');
select throws_ok(format($$select public.admin_upsert_room('r-long', '%s', 'public', null, true)$$, repeat('t', 81)), 'P0001', 'too_long', 'an 81-char title is refused');
select throws_ok($$select public.admin_upsert_room('r-empty', E' ​ ', 'public', null, true)$$, 'P0001', 'empty', 'an invisible title is refused');
select lives_ok($$select public.admin_upsert_room('r-ok', 'Fine', null, '', true)$$, 'kind null and lang empty are accepted');
select is((select kind || ':' || coalesce(lang, '-') from public.rooms where slug = 'r-ok'), 'public:-', 'kind defaults, lang null');
select tests.logout();
insert into public.word_filter (pattern) select 'f' || g from generate_series(1, 100) g;
select tests.login_as(:'adm');
select throws_ok($$select public.admin_add_filter('one_more')$$, 'P0001', 'limit_reached', 'the 101st pattern is refused');
select lives_ok($$select public.admin_add_filter('f1')$$, 'an existing pattern is still accepted');
select tests.logout();

-- 9. cached stats ------------------------------------------------------------------------------
select is((select count(*)::int from private.stats_cache), 0, 'no cache row yet');
select private.refresh_stats();
select is(public.public_stats(), (select stats from private.stats_cache), 'public_stats returns the cached row');
update private.stats_cache set refreshed_at = now() - interval '3 minutes';
select tests.create_user('sr_late');
select is((public.public_stats() ->> 'users_total')::int, (select (stats ->> 'users_total')::int + 1 from private.stats_cache), 'a stale cache is computed live');
select is((select command from cron.job where jobname = 'cbreak-stats'), 'select private.refresh_stats()', 'cron refreshes the cache');

-- 12. no GitHub ids or logins in old invite rows (the migration strips them; none are logged today)
select is((select count(*)::int from public.mod_actions where details ?| array['github_id', 'github_login']), 0, 'no mod_actions row names a GitHub account');

-- 11. github_age_checked_at ------------------------------------------------------------------------
select has_column('public', 'profiles', 'github_age_checked_at', 'profiles.github_age_checked_at exists');

-- privileges ------------------------------------------------------------------------------------
select is(has_table_privilege('authenticated', 'private.account_memory', 'select'), false, 'account_memory not readable');
select is(has_table_privilege('authenticated', 'private.rate_limits', 'select'), false, 'rate_limits not readable');
select is(has_table_privilege('authenticated', 'private.stats_cache', 'select'), false, 'stats_cache not readable');
select is(has_function_privilege('authenticated', 'private.bump_limit(text, interval, int)', 'execute'), false, 'bump_limit not executable');
select is(has_function_privilege('authenticated', 'private.announce(text, int, text, uuid)', 'execute'), false, 'announce not executable');
select is(has_function_privilege('anon', 'private.refresh_stats()', 'execute'), false, 'refresh_stats not executable by anon');

select * from finish();
rollback;

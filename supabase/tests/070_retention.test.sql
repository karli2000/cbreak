begin;
\ir _helpers.psql
select plan(20);

select tests.create_user('u1') as u1 \gset
select tests.create_user('u2') as u2 \gset
select tests.create_user('adm', 'admin') as adm \gset

-- purge boundaries
insert into public.messages (room, instance, user_id, nickname, body, created_at) values
  ('lobby', 1, :'u1', 'u1', 'young', now() - interval '14 minutes'),
  ('lobby', 1, :'u1', 'u1', 'old',   now() - interval '16 minutes');
insert into public.occupancy (user_id, room, instance, last_seen) values
  (:'u1', 'lobby', 1, now() - interval '80 seconds'),
  (:'u2', 'lobby', 1, now() - interval '100 seconds');
insert into public.reports (reporter_id, target_id, reason, snapshot, status, handled_at) values
  (:'u1', :'u2', 'r89',  '{}', 'dismissed', now() - interval '89 days'),
  (:'u1', :'u2', 'r91',  '{}', 'dismissed', now() - interval '91 days'),
  (:'u1', :'u2', 'ropen', '{}', 'open', null);
update public.reports set created_at = now() - interval '200 days' where reason = 'ropen';
insert into public.mod_actions (actor_id, target_id, action, created_at) values
  (:'adm', :'u1', 'a364', now() - interval '364 days'),
  (:'adm', :'u1', 'a366', now() - interval '366 days');

select is(private.purge_expired(),
  '{"messages":1,"occupancy":1,"reports":1,"mod_actions":1}'::jsonb, 'purge returns counts');
select is((select body from public.messages), 'young', 'young message kept');
select is((select user_id from public.occupancy), :'u1'::uuid, 'fresh occupancy kept');
select is((select count(*)::int from public.reports where reason in ('r89','ropen')), 2, 'young resolved + open reports kept');
select is((select count(*)::int from public.reports where reason = 'r91'), 0, 'old resolved report purged');
select is((select action from public.mod_actions), 'a364', 'young mod_action kept');
select is(private.purge_expired(), '{"messages":0,"occupancy":0,"reports":0,"mod_actions":0}'::jsonb, 'second purge is a no-op');

-- cron job
select is((select schedule from cron.job where jobname = 'coffeebreak-purge'), '* * * * *', 'cron schedule');
select is((select command from cron.job where jobname = 'coffeebreak-purge'), 'select private.purge_expired()', 'cron command');

-- privileges
select is(has_function_privilege('authenticated', 'private.purge_expired()', 'execute'), false, 'purge not executable by authenticated');
select is(has_table_privilege('authenticated', 'public.banned_github_ids', 'select'), false, 'banned_github_ids not readable');
select is(has_table_privilege('anon', 'public.banned_github_ids', 'select'), false, 'banned_github_ids not readable by anon');

-- delete_my_account
select tests.logout();
select throws_ok($$select public.delete_my_account()$$, 'P0001', 'not_authenticated', 'delete requires auth');
select tests.login_as(:'u2');
select public.delete_my_account();
select tests.logout();
select is((select count(*)::int from public.profiles where id = :'u2'), 0, 'profile deleted');
select is((select count(*)::int from auth.users where id = :'u2'), 0, 'auth user deleted');
select is((select count(*)::int from public.banned_github_ids), 0, 'unbanned deletion stores no hash');

-- banned user deletes account, re-signs up with same github id
select tests.create_user('bad') as bad \gset
select tests.create_user('bad2') as bad2 \gset
select github_id as gh2 from public.profiles where id = :'bad2' \gset
select github_id as gh from public.profiles where id = :'bad' \gset
select tests.login_as(:'adm');
select public.mod_ban(:'bad', 'spam');
select tests.login_as(:'bad');
select public.delete_my_account();
select tests.logout();
select is((select github_id_hash from public.banned_github_ids),
  encode(sha256(convert_to(:'gh', 'UTF8')), 'hex'), 'ban hash stored');
select tests.create_auth_user(:gh) as again \gset
select tests.login_as(:'again');
select throws_ok($$select public.claim_nickname('freshstart')$$, 'P0001', 'banned', 'claim blocked for banned github id');

-- unban removes hash, claim works again
-- a still-existing banned user whose hash is also on file (e.g. re-signup after deletion)
select tests.logout();
insert into public.banned_github_ids (github_id_hash, banned_at)
  values (encode(sha256(convert_to(:'gh2', 'UTF8')), 'hex'), now());
select tests.login_as(:'adm');
select public.mod_ban(:'bad2', 'x');
select public.admin_unban(:'bad2', 'sorry');
select tests.logout();
select is((select count(*)::int from public.banned_github_ids
  where github_id_hash = encode(sha256(convert_to(:'gh2', 'UTF8')), 'hex')), 0, 'admin_unban removes hash');

-- other github ids unaffected
select tests.logout();
select tests.create_auth_user() as other \gset
select tests.login_as(:'other');
select is((public.claim_nickname('okaynick')).nickname::text, 'okaynick', 'unrelated github id can claim');

select * from finish();
rollback;

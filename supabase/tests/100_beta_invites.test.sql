begin;
\ir _helpers.psql
select plan(24);

select tests.create_user('adm', 'admin') as adm \gset
select tests.create_user('modx', 'moderator') as modx \gset

-- invite_only defaults to on
select is((select invite_only from public.beta_settings), true, 'invite_only defaults to true');

-- uninvited first claim refused, then invited
select tests.create_uninvited_auth_user(5001) as u1 \gset
select tests.login_as(:'u1');
select throws_ok($$select public.claim_nickname('friendone')$$, 'P0001', 'not_invited', 'uninvited first claim refused');
select tests.login_as(:'adm');
select lives_ok($$select public.admin_add_invite(5001, 'friend', null)$$, 'admin adds invite');
select tests.login_as(:'u1');
select is((public.claim_nickname('friendone')).nickname::text, 'friendone', 'invited claim succeeds');

-- existing profile keeps working after invite removal (rename is not a first claim)
select tests.login_as(:'adm');
select lives_ok($$select public.admin_remove_invite(5001)$$, 'admin removes invite');
select tests.login_as(:'u1');
select is((public.claim_nickname('friendtwo')).nickname::text, 'friendtwo', 'rename works without invite');

-- invite_only off lets anyone claim
select tests.logout();
select tests.create_uninvited_auth_user(5002) as u2 \gset
select tests.login_as(:'adm');
select lives_ok($$select public.admin_set_invite_only(false)$$, 'admin turns invite_only off');
select tests.login_as(:'u2');
select is((public.claim_nickname('opendoor')).nickname::text, 'opendoor', 'anyone claims while off');
select tests.login_as(:'adm');
select public.admin_set_invite_only(true);

-- email user without github id refused while invite_only
select tests.logout();
select gen_random_uuid() as eu \gset
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  values (:'eu', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'e@test.local', now(), now());
select tests.login_as(:'eu');
select throws_ok($$select public.claim_nickname('emailer')$$, 'P0001', 'not_invited', 'no github id refused');

-- banned hash wins over invite
select tests.logout();
select tests.create_auth_user(5003) as u3 \gset
insert into public.banned_github_ids (github_id_hash, banned_at)
  values (encode(sha256(convert_to('5003', 'UTF8')), 'hex'), now());
select tests.login_as(:'u3');
select throws_ok($$select public.claim_nickname('banneddude')$$, 'P0001', 'banned', 'banned hash wins over invite');

-- admin-only
select tests.login_as(:'modx');
select throws_ok($$select public.admin_add_invite(1, 'x', null)$$, 'P0001', 'forbidden', 'mod cannot add invite');
select throws_ok($$select public.admin_remove_invite(1)$$, 'P0001', 'forbidden', 'mod cannot remove invite');
select throws_ok($$select public.admin_set_invite_only(false)$$, 'P0001', 'forbidden', 'mod cannot toggle');

-- validation, not_found
select tests.login_as(:'adm');
select throws_ok($$select public.admin_add_invite(7, '   ', null)$$, 'P0001', 'invalid_login', 'empty login invalid');
select throws_ok($$select public.admin_add_invite(7, repeat('a', 40), null)$$, 'P0001', 'invalid_login', 'long login invalid');
select throws_ok($$select public.admin_remove_invite(999999)$$, 'P0001', 'not_found', 'remove absent not_found');

-- audit rows and admin reads
select public.admin_add_invite(8, 'eight', 'note');
select public.admin_add_invite(8, 'eight', 'note2');
select is((select count(*)::int from public.mod_actions where action = 'admin_add_invite'), 3, 'add logs one row per call (5001, 8, 8)');
select is((select count(*)::int from public.mod_actions where action = 'admin_remove_invite'), 1, 'remove logs exactly one row');
select is((select count(*)::int from public.mod_actions where action = 'admin_set_invite_only'), 2, 'set_invite_only logs one row per call');
select is((select count(*)::int from public.beta_invites where github_id = 8), 1, 'add is idempotent (upsert)');

select throws_ok($$select public.admin_add_invite(null, 'x', null)$$, 'P0001', 'invalid_login', 'null github_id invalid');

-- non-admins cannot read the tables
select tests.login_as(:'modx');
select is((select count(*)::int from public.beta_invites), 0, 'moderator sees no invites');
select is((select count(*)::int from public.beta_settings), 0, 'moderator sees no settings');

-- gate fails closed when the settings row is missing
select tests.logout();
delete from public.beta_settings;
select tests.create_uninvited_auth_user(5004) as u4 \gset
select tests.login_as(:'u4');
select throws_ok($$select public.claim_nickname('nosettings')$$, 'P0001', 'not_invited', 'missing settings row still gates');

select * from finish();
rollback;

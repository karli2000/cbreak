begin;
\ir _helpers.psql
select plan(24);

select tests.create_auth_user(4242) as u1 \gset
select tests.create_user('other') as u2 \gset

-- not authenticated
select throws_ok($$select public.claim_nickname('max')$$, 'P0001', 'not_authenticated', 'claim without JWT');
select throws_ok($$select public.my_profile()$$, 'P0001', 'not_authenticated', 'my_profile without JWT');

select tests.login_as(:'u1');
select throws_ok($$select public.my_profile()$$, 'P0001', 'no_profile', 'my_profile before claim');
select is(public.nickname_available('max'), true, 'max available');
select is(public.nickname_available('ma'), false, 'invalid not available');
select is(public.nickname_available('admin'), false, 'reserved not available');

-- invalid / reserved
select throws_ok($$select public.claim_nickname('ma')$$, 'P0001', 'nickname_invalid', 'too short');
select throws_ok($$select public.claim_nickname(E'mаx')$$, 'P0001', 'nickname_invalid', 'cyrillic look-alike');
select throws_ok($$select public.claim_nickname('a b c')$$, 'P0001', 'nickname_invalid', 'spaces');
select throws_ok($$select public.claim_nickname('admin')$$, 'P0001', 'nickname_reserved', 'reserved');
select throws_ok($$select public.claim_nickname('Admin')$$, 'P0001', 'nickname_reserved', 'reserved is case-insensitive');

-- first claim creates profile with github_id from identity
select is((public.claim_nickname('Max_K')).nickname::text, 'max_k', 'claim lowercases');
select tests.logout();
select is((select github_id from public.profiles where id = :'u1'), 4242::bigint, 'github_id copied from identity');
select is((select nickname_changed_at from public.profiles where id = :'u1'), null, 'first claim does not stamp nickname_changed_at');
select is((select rules_accepted_at from public.profiles where id = :'u1'), null, 'rules not accepted yet');

select tests.login_as(:'u1');
select is((public.my_profile()).nickname::text, 'max_k', 'my_profile returns profile');
select is(public.nickname_available('MAX_K'), false, 'taken, case-insensitive');

-- collisions from another user
select tests.logout();
select tests.login_as(:'u2');
select throws_ok($$select public.claim_nickname('MAX_K')$$, 'P0001', 'nickname_taken', 'case-insensitive collision');

-- first rename is free, second is too soon, then ok after 31 days
select tests.logout();
select tests.login_as(:'u1');
select is((public.claim_nickname('max_r')).nickname::text, 'max_r', 'first rename right after claim succeeds');
select throws_ok($$select public.claim_nickname('max')$$, 'P0001', 'nickname_change_too_soon', 'second rename within 30 days');
select tests.logout();
update public.profiles set nickname_changed_at = now() - interval '31 days' where id = :'u1';
select tests.login_as(:'u1');
select is((public.claim_nickname('max')).nickname::text, 'max', 'rename after 31 days');
select is(public.nickname_available('max_r'), true, 'old name freed');

-- accept_rules
select public.accept_rules();
select isnt((public.my_profile()).rules_accepted_at, null, 'accept_rules stamps rules_accepted_at');

-- banned caller
select tests.logout();
update public.profiles set banned_at = now() where id = :'u1';
select tests.login_as(:'u1');
select throws_ok($$select public.claim_nickname('whoever')$$, 'P0001', 'banned', 'banned caller');

select * from finish();
rollback;

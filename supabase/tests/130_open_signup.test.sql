-- Invite gate removed (migration 20261114000100): any GitHub account can claim a first nickname.
begin;
\ir _helpers.psql
select plan(9);

select hasnt_table('public', 'beta_invites', 'beta_invites is gone');
select hasnt_table('public', 'beta_settings', 'beta_settings is gone');
select hasnt_function('public', 'admin_add_invite', 'admin_add_invite is gone');
select hasnt_function('public', 'admin_remove_invite', 'admin_remove_invite is gone');
select hasnt_function('public', 'admin_set_invite_only', 'admin_set_invite_only is gone');

-- any GitHub account can create a profile
select tests.create_auth_user(424242) as gh \gset
insert into public.banned_github_ids (github_id_hash, banned_at, reason)
values (encode(sha256(convert_to('515151', 'UTF8')), 'hex'), now(), 'test');
select tests.create_auth_user(515151) as bn \gset
select tests.login_as(:'gh');
select is((public.claim_nickname('open_door')).nickname::text, 'open_door', 'a first claim needs no invite');

-- the banned-hash check still comes first
select tests.login_as(:'bn');
select throws_ok($$select public.claim_nickname('still_banned')$$, 'P0001', 'banned', 'a banned GitHub id is still refused');

-- delete_my_account still works and still keeps the ban hash
select tests.login_as(:'gh');
select lives_ok($$select public.delete_my_account()$$, 'delete_my_account works without invites');
select tests.logout();
select is((select count(*)::int from auth.users where id = :'gh'), 0, 'the account is gone');

select * from finish();
rollback;

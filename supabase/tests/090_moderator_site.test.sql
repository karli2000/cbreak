begin;
\ir _helpers.psql
select plan(15);

select tests.create_user('usr') as usr \gset
select tests.create_user('modx', 'moderator') as modx \gset
select tests.create_user('adm', 'admin') as adm \gset
select tests.create_user('bannedone') as b1 \gset
select tests.create_user('fine') as fine \gset
select tests.create_user('badmod', 'moderator') as badmod \gset
update public.profiles set banned_at = now(), ban_reason = 'spamming' where id = :'b1';
update public.profiles set banned_at = now() where id = :'badmod';

-- mod_list_banned
select tests.login_as(:'usr');
select throws_ok($$select * from public.mod_list_banned()$$, 'P0001', 'forbidden', 'user cannot list bans');
select tests.login_as(:'badmod');
select throws_ok($$select * from public.mod_list_banned()$$, 'P0001', 'banned', 'banned moderator refused');
select tests.login_as(:'modx');
select is((select ban_reason from public.mod_list_banned() where nickname = 'bannedone'), 'spamming', 'moderator sees banned user and reason');
select is((select count(*)::int from public.mod_list_banned() where nickname = 'fine'), 0, 'unbanned user not listed');

-- admin_list_staff
select throws_ok($$select * from public.admin_list_staff()$$, 'P0001', 'forbidden', 'moderator cannot list staff');
select tests.login_as(:'adm');
select is((select array_agg(nickname order by nickname) from public.admin_list_staff()),
  array['adm','badmod','modx'], 'admin sees staff only');
select is((select role::text from public.admin_list_staff() where nickname = 'modx'), 'moderator', 'role included');

-- admin_unban_github_id
select tests.login_as(:'modx');
select throws_ok($$select public.admin_unban_github_id(4242, 'x')$$, 'P0001', 'forbidden', 'moderator cannot unban github id');
select tests.logout();
insert into public.banned_github_ids (github_id_hash, banned_at)
  values (encode(sha256(convert_to('4242', 'UTF8')), 'hex'), now());
select tests.login_as(:'adm');
select lives_ok($$select public.admin_unban_github_id(4242, 'appeal ok')$$, 'admin unbans github id');
select tests.logout();
select is((select count(*)::int from public.banned_github_ids), 0, 'hash row gone');
select is((select count(*)::int from public.mod_actions where action = 'admin_unban_github_id'), 1, 'one audit row');
select is((select details->>'github_id_hash' from public.mod_actions where action = 'admin_unban_github_id'),
  encode(sha256(convert_to('4242', 'UTF8')), 'hex'), 'hash in details');
select is((select reason from public.mod_actions where action = 'admin_unban_github_id'), 'appeal ok', 'reason logged');
select tests.login_as(:'adm');
select throws_ok($$select public.admin_unban_github_id(4242, 'again')$$, 'P0001', 'not_found', 'second call not_found');
select tests.logout();
select tests.create_auth_user(4242) as fresh \gset
select tests.login_as(:'fresh');
select is((public.claim_nickname('freshstart')).nickname::text, 'freshstart', 'unbanned github id can claim');

select * from finish();
rollback;

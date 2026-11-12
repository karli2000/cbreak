begin;
\ir _helpers.psql
select plan(20);

select has_table('public', t, t || ' exists')
from unnest(array['profiles','rooms','occupancy','messages','reports','mod_actions','word_filter']) t;

select ok((select bool_and(relrowsecurity) from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('profiles','rooms','occupancy','messages','reports','mod_actions','word_filter')),
          'RLS enabled on all 7 tables');

select tests.create_user('alice');
select tests.create_user('bob');
select tests.create_user('modman', 'moderator');

-- fixtures (as superuser)
insert into public.messages (room, instance, user_id, nickname, body)
select 'lobby', 1, id, 'alice', 'hello' from public.profiles where nickname = 'alice';
insert into public.reports (reporter_id, target_id, reason, snapshot)
select a.id, b.id, 'spam', '[]'::jsonb
from public.profiles a, public.profiles b where a.nickname = 'alice' and b.nickname = 'bob';
insert into public.mod_actions (action) values ('x');
-- messages are readable only with a live occupancy row in the same instance (migration 000900)
insert into public.occupancy (user_id, room, instance)
select id, 'lobby', 1 from public.profiles where nickname = 'alice';
insert into public.word_filter (pattern) values ('badword');

select tests.login_as((select id from public.profiles where nickname = 'alice'));
select is((select count(*) from public.reports), 0::bigint, 'user sees no reports');
select is((select count(*) from public.mod_actions), 0::bigint, 'user sees no mod_actions');
select is((select count(*) from public.word_filter), 0::bigint, 'user sees no word_filter');
select is((select count(*) from public.profiles), 1::bigint, 'user sees only own full profile');
select is((select count(*) from public.public_profiles), 3::bigint, 'public_profiles lists all');
select is((select count(*) from public.messages), 1::bigint, 'user in the room reads messages');
select throws_ok($$insert into public.messages (room, instance, nickname, body) values ('lobby', 1, 'alice', 'x')$$,
  '42501', null, 'user cannot insert messages directly');
select throws_ok($$update public.profiles set role = 'admin'$$,
  '42501', null, 'user cannot update profiles directly');
select tests.logout();

select is((select count(*) from public.profiles), 3::bigint, 'superuser sees all profiles');

select tests.login_as((select id from public.profiles where nickname = 'modman'));
select is((select count(*) from public.reports), 1::bigint, 'moderator sees reports');
select is((select count(*) from public.mod_actions), 1::bigint, 'moderator sees mod_actions');
select tests.logout();

set local role anon;
select throws_ok($$select * from public.public_profiles$$, '42501', null, 'anon cannot read public_profiles');
reset role;

select * from finish();
rollback;

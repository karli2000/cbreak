begin;
\ir _helpers.psql
select plan(26);

insert into public.rooms (slug, title) values ('ms-room', 'Multi session');
select tests.create_user('ann') as a \gset
select tests.create_user('adm', 'admin') as adm \gset
select gen_random_uuid() as sa \gset
select gen_random_uuid() as sb \gset

-- two sessions share one row and instance
select tests.login_as(:'a');
select public.join_room('ms-room', :'sa'::uuid) as ja \gset
select public.join_room('ms-room', :'sb'::uuid) as jb \gset
select tests.logout();
select is((select count(*)::int from public.occupancy where user_id = :'a'), 1, 'one occupancy row');
select is((select count(*)::int from public.occupancy_sessions where user_id = :'a'), 2, 'two session rows');
select is(:'ja'::jsonb->>'topic', :'jb'::jsonb->>'topic', 'equal topics');

-- heartbeat with a session refreshes last_seen
update public.occupancy_sessions set last_seen = now() - interval '60 seconds' where user_id = :'a' and session_id = :'sa';
select tests.login_as(:'a');
select public.heartbeat(:'sa'::uuid);
select tests.logout();
select ok((select last_seen > now() - interval '5 seconds' from public.occupancy_sessions
           where user_id = :'a' and session_id = :'sa'), 'heartbeat refreshes the session row');

-- leave of one session keeps the row while another is live
select tests.login_as(:'a');
select public.leave_room(:'sa'::uuid);
select tests.logout();
select is((select count(*)::int from public.occupancy where user_id = :'a'), 1, 'occupancy kept');
select is((select count(*)::int from public.occupancy_sessions where user_id = :'a' and session_id = :'sb'), 1, 'B session kept');
select is((select count(*)::int from public.occupancy_sessions where user_id = :'a' and session_id = :'sa'), 0, 'A session gone');

-- leave of the last session deletes the row
select tests.login_as(:'a');
select public.leave_room(:'sb'::uuid);
select tests.logout();
select is((select count(*)::int from public.occupancy where user_id = :'a'), 0, 'occupancy deleted');
select is((select count(*)::int from public.occupancy_sessions where user_id = :'a'), 0, 'no session rows');

-- leave with only stale other sessions deletes the row
select tests.login_as(:'a');
select public.join_room('ms-room', :'sa'::uuid);
select public.join_room('ms-room', :'sb'::uuid);
select tests.logout();
update public.occupancy_sessions set last_seen = now() - interval '2 minutes' where user_id = :'a' and session_id = :'sb';
select tests.login_as(:'a');
select public.leave_room(:'sa'::uuid);
select tests.logout();
select is((select count(*)::int from public.occupancy where user_id = :'a'), 0, 'stale other session: row deleted');

-- a live caller keeps their instance on join
delete from public.occupancy;
insert into public.occupancy (user_id, room, instance)
select tests.create_user('x' || g), 'ms-room', 1 from generate_series(1, 5) g;
insert into public.occupancy (user_id, room, instance) values (:'a', 'ms-room', 2);
select tests.login_as(:'a');
select is((public.join_room('ms-room', :'sb'::uuid))->>'instance', '2', 'live caller keeps instance 2');
select tests.logout();

-- null session: old behaviour
delete from public.occupancy;
select tests.login_as(:'a');
select lives_ok($$select public.join_room('ms-room')$$, 'null-session join works');
select lives_ok($$select public.heartbeat()$$, 'null-session heartbeat works');
select tests.logout();
select is((select count(*)::int from public.occupancy_sessions where user_id = :'a'), 0, 'null session creates no session rows');
select tests.login_as(:'a');
select public.join_room('ms-room', :'sa'::uuid);
select public.leave_room();
select tests.logout();
select is((select count(*)::int from public.occupancy where user_id = :'a'), 0, 'null leave deletes occupancy');
select is((select count(*)::int from public.occupancy_sessions where user_id = :'a'), 0, 'null leave cascades sessions');

-- ban removes occupancy and sessions
select tests.login_as(:'a');
select public.join_room('ms-room', :'sa'::uuid);
select public.join_room('ms-room', :'sb'::uuid);
select tests.login_as(:'adm');
select public.mod_ban(:'a'::uuid, 'test');
select tests.logout();
select is((select count(*)::int from public.occupancy where user_id = :'a'), 0, 'ban: occupancy gone');
select is((select count(*)::int from public.occupancy_sessions where user_id = :'a'), 0, 'ban: sessions gone');

-- purge
select tests.create_user('bea') as b \gset
insert into public.occupancy (user_id, room, instance) values (:'b', 'ms-room', 1);
insert into public.occupancy_sessions (user_id, session_id, last_seen) values
  (:'b', :'sa', now()), (:'b', :'sb', now() - interval '2 minutes');
select is((select array_agg(k order by k) from jsonb_object_keys(private.purge_expired()) k),
  array['messages','mod_actions','occupancy','reports'], 'purge result keys');
select is((select array_agg(session_id) from public.occupancy_sessions where user_id = :'b'),
  array[:'sa'::uuid], 'purge removed only the stale session');

-- privileges
select table_privs_are('public', 'occupancy_sessions', 'authenticated', array[]::text[], 'authenticated: no privileges');
select table_privs_are('public', 'occupancy_sessions', 'anon', array[]::text[], 'anon: no privileges');

select hasnt_function('public', 'join_room', array['text'], 'old join_room(text) is gone');
select hasnt_function('public', 'heartbeat', array[]::text[], 'old heartbeat() is gone');
select hasnt_function('public', 'leave_room', array[]::text[], 'old leave_room() is gone');
select is(has_function_privilege('anon', 'public.join_room(text, uuid)', 'execute')
  or has_function_privilege('anon', 'public.heartbeat(uuid)', 'execute')
  or has_function_privilege('anon', 'public.leave_room(uuid)', 'execute'), false, 'anon cannot execute');

select * from finish();
rollback;

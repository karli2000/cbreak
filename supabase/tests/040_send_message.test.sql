begin;
\ir _helpers.psql
select plan(31);

select tests.create_user('alice') as a \gset
select tests.create_user('newbie', 'user', '5 days') as n \gset
select tests.create_user('nogh') as g \gset
update public.profiles set github_created_at = null where id = :'g';
select tests.create_user('muted_guy') as mu \gset
select tests.create_user('banned_guy') as bn \gset
select tests.create_user('lurker') as l \gset
select tests.create_user('exmute') as em \gset
select tests.create_user('stale') as st \gset
select tests.create_user('youngok', 'user', '5 days') as yo \gset
select tests.create_auth_user() as np \gset
update public.profiles set muted_until = now() - interval '1 minute' where id = :'em';
select tests.create_user('modmod', 'moderator') as md \gset
update public.profiles set muted_until = now() + interval '1 hour' where id = :'mu';
update public.profiles set banned_at = now() where id = :'bn';
insert into public.occupancy (user_id, room, instance)
  select u, 'lobby', 1 from unnest(array[:'em'::uuid, :'yo'::uuid, :'a'::uuid, :'n'::uuid, :'g'::uuid, :'mu'::uuid, :'bn'::uuid, :'md'::uuid]) u;
insert into public.word_filter (pattern) values ('b[a@]dword');
insert into public.occupancy (user_id, room, instance, last_seen) values (:'st', 'lobby', 1, now() - interval '5 minutes');

select throws_ok($$select public.send_message('x')$$, 'P0001', 'not_authenticated', 'no JWT');

-- error ordering / states
select tests.login_as(:'bn');
select throws_ok($$select public.send_message('hi')$$, 'P0001', 'banned', 'banned');
select tests.login_as(:'mu');
select throws_ok($$select public.send_message('hi')$$, 'P0001', 'muted', 'muted');
select tests.login_as(:'l');
select throws_ok($$select public.send_message('hi')$$, 'P0001', 'not_in_room', 'no occupancy row');

-- happy path
select tests.login_as(:'a');
select is((select nickname::text from public.send_message('hello there')), 'alice', 'nickname from profile');
select tests.logout();
select is((select count(*)::int from realtime.messages where topic = 'room:lobby:1' and event = 'message'), 1, 'broadcast stored');
select is((select payload->>'role' from realtime.messages where topic = 'room:lobby:1' and event = 'message'), 'user', 'payload role');
delete from public.messages;

-- control characters: ESC, CSI sequence, BEL, newline, C1 CSI (U+009B), DEL
select tests.login_as(:'a');
select is((select body from public.send_message(E'hi\x1b[2Jthere\n\x07')), 'hi[2Jthere', 'ESC/BEL/newline removed');
select tests.logout();
delete from public.messages;
select tests.login_as(:'a');
select is((select body from public.send_message(E'a\u009bb\u007fc\u0085d\u009fe f')), E'abcde f', 'C1 and DEL removed, NBSP kept');
select tests.logout();
delete from public.messages;

-- empty / length
select tests.login_as(:'a');
select throws_ok($$select public.send_message('   ')$$, 'P0001', 'empty', 'blank');
select throws_ok($$select public.send_message(repeat('x', 281))$$, 'P0001', 'too_long', '281 chars');
select lives_ok($$select public.send_message(repeat('x', 280))$$, '280 chars ok');
select tests.logout();
delete from public.messages;

-- 2 s rule
insert into public.messages (room, instance, user_id, nickname, body, created_at)
  values ('lobby', 1, :'a', 'alice', 'earlier', now() - interval '1 second');
select tests.login_as(:'a');
select throws_ok($$select public.send_message('next')$$, 'P0001', 'rate_limited', '1 s apart');
select tests.logout();
delete from public.messages;

-- burst: 5 in last 10 s, last one 2.1 s ago
insert into public.messages (room, instance, user_id, nickname, body, created_at)
  select 'lobby', 1, :'a', 'alice', 'm' || i, now() - make_interval(secs => s)
  from unnest(array[9, 7, 5, 3, 2.1]) with ordinality t(s, i);
select tests.login_as(:'a');
select throws_ok($$select public.send_message('sixth')$$, 'P0001', 'rate_limited', '6th in 10 s');
select tests.logout();
delete from public.messages;

-- duplicate within 60 s
insert into public.messages (room, instance, user_id, nickname, body, created_at)
  values ('lobby', 1, :'a', 'alice', 'same', now() - interval '30 seconds');
select tests.login_as(:'a');
select throws_ok($$select public.send_message(' same ')$$, 'P0001', 'duplicate', 'duplicate body');
select tests.logout();
delete from public.messages;

-- young / unknown-age accounts: 10 s gap
insert into public.messages (room, instance, user_id, nickname, body, created_at)
  select 'lobby', 1, u, 'x', 'earlier', now() - interval '5 seconds' from unnest(array[:'n'::uuid, :'g'::uuid]) u;
select tests.login_as(:'n');
select throws_ok($$select public.send_message('next')$$, 'P0001', 'rate_limited', 'young account 5 s');
select tests.login_as(:'g');
select throws_ok($$select public.send_message('next')$$, 'P0001', 'rate_limited', 'unknown age 5 s');
select tests.logout();

-- word filter
select tests.login_as(:'md');
select throws_ok($$select public.send_message('you BAdword')$$, 'P0001', 'filtered', 'filtered');

select tests.logout();
select throws_ok($$insert into public.word_filter (pattern) values ('b[a@d')$$, '23514', null, 'malformed regex rejected');
select tests.login_as(:'md');
select throws_ok($$select public.send_message('ok BADWORD')$$, 'P0001', 'filtered', 'valid pattern still works');
select lives_ok($$select public.send_message('clean message')$$, 'send works with filter present');
select tests.logout();
delete from public.messages;

-- bidi / separators stripped, whitespace-only blank, NBSP inside kept, 1121 chars
select tests.login_as(:'a');
select is((select body from public.send_message(E'a\u202eb\u2066c\u2029d\u2028e')), 'abcde', 'bidi and separators removed');
select tests.logout();
delete from public.messages;
select tests.login_as(:'a');
select throws_ok($$select public.send_message(E'\u00a0\u3000 \u00a0')$$, 'P0001', 'empty', 'NBSP/U+3000 only is empty');
select throws_ok($$select public.send_message(repeat('x', 1121))$$, 'P0001', 'too_long', '1121 chars too_long');
select is((select body from public.send_message(E'\u3000a\u00a0b\u00a0')), E'a\u00a0b', 'edge unicode space trimmed, inner NBSP kept');
select tests.logout();
delete from public.messages;

-- no_profile
select tests.login_as(:'np');
select throws_ok($$select public.send_message('hi')$$, 'P0001', 'no_profile', 'no profile');

-- expired mute allows sending
select tests.login_as(:'em');
select lives_ok($$select public.send_message('mute expired')$$, 'expired mute allows send');

-- stale occupancy: allowed and refreshed
select tests.login_as(:'st');
select lives_ok($$select public.send_message('stale but here')$$, 'stale occupancy row can send');
select tests.logout();
select ok((select last_seen > now() - interval '5 seconds' from public.occupancy where user_id = :'st'), 'last_seen refreshed');

-- positive controls
insert into public.messages (room, instance, user_id, nickname, body, created_at)
  values ('lobby', 1, :'a', 'alice', 'old1', now() - interval '5 seconds'),
         ('lobby', 1, :'yo', 'youngok', 'old2', now() - interval '11 seconds');
select tests.login_as(:'a');
select lives_ok($$select public.send_message('old account ok')$$, 'old account ok 5 s after last');
select tests.login_as(:'yo');
select lives_ok($$select public.send_message('young account ok')$$, 'young account ok 11 s after last');
select tests.logout();

select * from finish();
rollback;

-- Plan 6: emoji are converted in the mod; the server must store them byte for byte and count code points.
begin;
\ir _helpers.psql
select plan(4);

insert into public.rooms (slug, title) values ('emoji-room', 'Emoji');
select tests.create_user('emo_a') as a \gset
select tests.create_user('emo_b') as b \gset
select tests.create_user('emo_c') as c \gset
insert into public.occupancy (user_id, room, instance)
  select u, 'emoji-room', 1 from unnest(array[:'a'::uuid, :'b'::uuid, :'c'::uuid]) u;

-- ZWJ family, skin tone, flag, VS16 heart, plain coffee
select tests.login_as(:'a');
select is((public.send_message(E'👨‍👩‍👧 👍🏽 🇩🇪 ❤️ ☕')).body, E'👨‍👩‍👧 👍🏽 🇩🇪 ❤️ ☕',
  'emoji survive send_message unchanged (returned body)');
select is((select body from public.messages where user_id = :'a' order by id desc limit 1), E'👨‍👩‍👧 👍🏽 🇩🇪 ❤️ ☕',
  'emoji survive send_message unchanged (stored row)');

-- the 280 limit counts code points
select tests.login_as(:'b');
select lives_ok(format('select public.send_message(%L)', repeat(E'❤', 280)), '280 hearts are accepted');
select tests.login_as(:'c');
select throws_ok(format('select public.send_message(%L)', repeat(E'❤', 281)), 'P0001', 'too_long', '281 hearts are too long');

select * from finish();
rollback;

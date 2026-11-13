-- join_room(room_slug, session_id, prefer_instance): a caller who comes back for another break is put
-- back into the instance they were in, while it still has other live people and room to spare.
begin;
\ir _helpers.psql
select plan(11);

insert into public.rooms (slug, title) values ('st-room', 'Sticky');
select tests.create_user('stick') as me \gset
-- instance 1: three others (the fullest), instance 2: one other
insert into public.occupancy (user_id, room, instance)
  select tests.create_user('one_' || g), 'st-room', 1 from generate_series(1, 3) g;
insert into public.occupancy (user_id, room, instance)
  select tests.create_user('two_' || g), 'st-room', 2 from generate_series(1, 1) g;

select has_function('public', 'join_room', array['text', 'uuid', 'integer'], 'join_room takes prefer_instance');
select hasnt_function('public', 'join_room', array['text', 'uuid'], 'the old two-argument join_room is gone');

select tests.login_as(:'me');
select is((public.join_room('st-room'))->>'instance', '1', 'without a preference: the fullest instance');
select public.leave_room();
select is((public.join_room('st-room', null, 2))->>'instance', '2', 'the preferred instance with people and space');
select public.leave_room();
select is((public.join_room('st-room', null, 5))->>'instance', '1', 'an empty preferred instance is ignored');
select public.leave_room();
select is((public.join_room('st-room', null, 0))->>'instance', '1', 'instance 0 is ignored');
select public.leave_room();
select is((public.join_room('st-room', null, -3))->>'instance', '1', 'a negative instance is ignored');

-- a live caller keeps their instance whatever they prefer
select is((public.join_room('st-room', null, 2))->>'instance', '1', 'a live caller keeps their instance');
select public.leave_room();

-- a stale row of the caller in the preferred instance does not count as "other people"
select tests.logout();
delete from public.occupancy where room = 'st-room' and instance = 2;
insert into public.occupancy (user_id, room, instance, last_seen) values (:'me', 'st-room', 2, now() - interval '5 minutes');
select tests.login_as(:'me');
select is((public.join_room('st-room', null, 2))->>'instance', '1', 'the caller alone does not keep an instance');
select public.leave_room();

-- a full preferred instance is ignored
select tests.logout();
insert into public.occupancy (user_id, room, instance)
  select tests.create_user('full_' || g), 'st-room', 3 from generate_series(1, 50) g;
select tests.login_as(:'me');
select is((public.join_room('st-room', null, 3))->>'instance', '1', 'a full preferred instance is ignored');
select public.leave_room();

-- the session id still works next to the preference
select is((public.join_room('st-room', gen_random_uuid(), 1))->>'instance', '1', 'session id and preference together');

select * from finish();
rollback;

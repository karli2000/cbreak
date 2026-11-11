-- Reports + auto-mute

-- Shared text cleaner: strips C0, DEL, C1 (U+0000 cannot occur in text), U+2028/9 and bidi controls,
-- then trims any Unicode whitespace (incl. NBSP, U+3000).
create function private.clean_text(t text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(
    regexp_replace(coalesce(t, ''),
      '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]', '', 'g'),
    '^[[:space:]\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+|[[:space:]\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+$', '', 'g')
$$;
revoke execute on function private.clean_text(text) from public, anon, authenticated;

create or replace function public.send_message(body text) returns public.messages
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  o public.occupancy;
  clean text;
  last_at timestamptz;
  recent int;
  min_gap interval;
  m public.messages;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  perform pg_advisory_xact_lock(hashtext('send:' || uid::text));

  select * into p from public.profiles where id = uid;
  if not found then raise exception 'no_profile'; end if;
  if p.banned_at is not null then raise exception 'banned'; end if;
  if p.muted_until is not null and p.muted_until > now() then raise exception 'muted'; end if;

  select * into o from public.occupancy where user_id = uid;
  if not found then raise exception 'not_in_room'; end if;

  -- cheap length guard before any regex work
  if char_length(coalesce(body, '')) > 1120 then raise exception 'too_long'; end if;
  clean := private.clean_text(body);
  if clean = '' then raise exception 'empty'; end if;
  if char_length(clean) > 280 then raise exception 'too_long'; end if;

  min_gap := case
    when p.github_created_at is null or p.github_created_at > now() - interval '30 days'
      then interval '10 seconds'
    else interval '2 seconds' end;
  select max(x.created_at) into last_at from public.messages x where x.user_id = uid;
  if last_at is not null and last_at > now() - min_gap then raise exception 'rate_limited'; end if;
  select count(*) into recent from public.messages x
   where x.user_id = uid and x.created_at > now() - interval '10 seconds';
  if recent >= 5 then raise exception 'rate_limited'; end if;

  if exists (select 1 from public.messages d
             where d.user_id = uid and d.body = clean and d.created_at > now() - interval '60 seconds') then
    raise exception 'duplicate';
  end if;

  if exists (select 1 from public.word_filter w where clean ~* w.pattern) then
    raise exception 'filtered';
  end if;

  update public.occupancy set last_seen = now() where user_id = uid;

  insert into public.messages (room, instance, user_id, nickname, body)
  values (o.room, o.instance, uid, p.nickname, clean)
  returning * into m;

  perform private.broadcast('room:' || o.room || ':' || o.instance, 'message',
    jsonb_build_object('id', m.id, 'nickname', m.nickname, 'body', m.body,
                       'created_at', m.created_at, 'role', p.role));
  return m;
end $$;


create function public.report_user(target_nickname text, message_id bigint, reason text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  t public.profiles;
  m public.messages;
  clean text;
  o public.occupancy;
  v_room text;
  v_instance int;
  snap jsonb;
  ctx jsonb;
  rid bigint;
  reporters int;
  report_ids jsonb;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into p from public.profiles where id = uid;
  if not found then raise exception 'no_profile'; end if;
  if p.banned_at is not null then raise exception 'banned'; end if;

  if char_length(coalesce(reason, '')) > 2000 then raise exception 'too_long'; end if;
  clean := private.clean_text(reason);
  if clean = '' then raise exception 'empty'; end if;
  if char_length(clean) > 500 then raise exception 'too_long'; end if;

  select * into t from public.profiles
   where nickname = lower(coalesce(target_nickname, ''))::extensions.citext;
  if not found then raise exception 'not_found'; end if;
  if t.id = uid then raise exception 'cannot_report_self'; end if;

  -- serialize reports per target so concurrent third reports cannot miss the auto-mute
  perform pg_advisory_xact_lock(hashtext('report:' || t.id::text));

  if message_id is not null then
    select * into m from public.messages x where x.id = message_id and x.user_id = t.id;
    if not found then raise exception 'not_found'; end if;
    v_room := m.room;
    v_instance := m.instance;
  else
    select * into o from public.occupancy where user_id = t.id;
    if found then v_room := o.room; v_instance := o.instance; end if;
  end if;

  if exists (select 1 from public.reports r
              where r.reporter_id = uid and r.target_id = t.id
                and r.created_at > now() - interval '10 minutes') then
    raise exception 'already_reported';
  end if;

  if v_room is null then
    ctx := '[]'::jsonb;
  elsif m.id is not null then
    select coalesce(jsonb_agg(e.j order by e.created_at, e.id), '[]'::jsonb) into ctx from (
      select x.id, x.created_at, jsonb_strip_nulls(jsonb_build_object(
               'id', x.id, 'nickname', x.nickname, 'body', x.body, 'created_at', x.created_at,
               'deleted', case when x.deleted_at is not null then true end)) as j
        from public.messages x
       where x.room = v_room and x.instance = v_instance
         and x.created_at between m.created_at - interval '5 minutes' and m.created_at + interval '5 minutes'
       order by abs(extract(epoch from x.created_at - m.created_at)), x.id
       limit 10) e;
  else
    select coalesce(jsonb_agg(e.j order by e.created_at, e.id), '[]'::jsonb) into ctx from (
      select x.id, x.created_at, jsonb_strip_nulls(jsonb_build_object(
               'id', x.id, 'nickname', x.nickname, 'body', x.body, 'created_at', x.created_at,
               'deleted', case when x.deleted_at is not null then true end)) as j
        from public.messages x
       where x.room = v_room and x.instance = v_instance
       order by x.created_at desc, x.id desc
       limit 10) e;
  end if;

  snap := jsonb_build_object(
    'message', case when m.id is not null then jsonb_build_object(
      'id', m.id, 'nickname', m.nickname, 'body', m.body, 'created_at', m.created_at) end,
    'context', ctx);

  insert into public.reports (reporter_id, target_id, message_id, room, instance, reason, snapshot)
  values (uid, t.id, m.id, v_room, v_instance, clean, snap)
  returning id into rid;

  select count(distinct r.reporter_id), jsonb_agg(r.id order by r.id)
    into reporters, report_ids
    from public.reports r
   where r.target_id = t.id and r.created_at > now() - interval '10 minutes';

  if reporters >= 3
     and not (coalesce(t.muted_until, '-infinity') >= now() + interval '23 hours') then
    update public.profiles
       set muted_until = greatest(coalesce(muted_until, '-infinity'), now() + interval '24 hours')
     where id = t.id;
    insert into public.mod_actions (actor_id, target_id, action, reason, details)
    values (null, t.id, 'auto_mute', 'auto: 3 reports in 10 min',
            jsonb_build_object('report_ids', report_ids));
  end if;

  return rid;
end $$;
revoke execute on function public.report_user(text, bigint, text) from public, anon;
grant execute on function public.report_user(text, bigint, text) to authenticated;

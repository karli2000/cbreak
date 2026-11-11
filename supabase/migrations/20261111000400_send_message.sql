-- send_message: the only way chat messages enter the system

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.broadcast(topic text, event text, payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(payload, event, topic, true);
end $$;
revoke execute on function private.broadcast(text, text, jsonb) from public, anon, authenticated;

create function public.send_message(body text) returns public.messages
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

  -- strip C0, DEL and C1 control characters (U+0000 cannot occur in text), then trim
  clean := btrim(regexp_replace(coalesce(body, ''), '[\u0001-\u001f\u007f-\u009f]', '', 'g'));
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

revoke execute on function public.send_message(text) from public, anon;
grant execute on function public.send_message(text) to authenticated;

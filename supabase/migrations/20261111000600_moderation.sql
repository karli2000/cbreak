-- Moderation and admin RPCs. Role checks live in the functions; every mutation is audited in mod_actions.

-- Caller must have role >= min_role and strictly outrank target (target null = role check only).
create function private.require_rank_over(target uuid, min_role public.app_role) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  caller public.app_role;
  theirs public.app_role;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  caller := public.current_role_of(uid);
  if caller is null or caller < min_role then raise exception 'forbidden'; end if;
  if target is null then return; end if;
  if target = uid then raise exception 'forbidden'; end if;
  theirs := public.current_role_of(target);
  if theirs is null then raise exception 'not_found'; end if;
  if caller <= theirs then raise exception 'forbidden'; end if;
end $$;
revoke execute on function private.require_rank_over(uuid, public.app_role) from public, anon, authenticated;

create function private.log_action(target uuid, act text, why text, det jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.mod_actions (actor_id, target_id, action, reason, details)
  values (auth.uid(), target, act, left(nullif(private.clean_text(why), ''), 500), coalesce(det, '{}'));
$$;
revoke execute on function private.log_action(uuid, text, text, jsonb) from public, anon, authenticated;

create function public.mod_delete_message(message_id bigint, reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.messages;
begin
  perform private.require_rank_over(null, 'moderator');
  select * into m from public.messages x where x.id = message_id and x.deleted_at is null for update;
  if not found then raise exception 'not_found'; end if;
  perform private.require_rank_over(m.user_id, 'moderator');
  update public.messages set deleted_at = now(), deleted_by = auth.uid() where id = m.id;
  perform private.broadcast('room:' || m.room || ':' || m.instance, 'deleted',
    jsonb_build_object('id', m.id));
  perform private.log_action(m.user_id, 'mod_delete_message', reason,
    jsonb_build_object('message_id', m.id, 'room', m.room, 'instance', m.instance));
end $$;

create function public.mod_mute(target uuid, minutes int, reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_rank_over(target, 'moderator');
  if minutes is null or minutes not in (10, 60, 1440) then raise exception 'invalid_duration'; end if;
  update public.profiles set muted_until = now() + make_interval(mins => minutes) where id = target;
  perform private.log_action(target, 'mod_mute', reason, jsonb_build_object('minutes', minutes));
end $$;

create function public.mod_unmute(target uuid, reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_rank_over(target, 'moderator');
  update public.profiles set muted_until = null where id = target;
  perform private.log_action(target, 'mod_unmute', reason);
end $$;

create function public.mod_ban(target uuid, reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.occupancy; why text := left(nullif(private.clean_text(reason), ''), 500);
begin
  perform private.require_rank_over(target, 'moderator');
  update public.profiles set banned_at = now(), ban_reason = why where id = target;
  select * into o from public.occupancy where user_id = target;
  if found then
    perform private.broadcast('room:' || o.room || ':' || o.instance, 'kicked',
      jsonb_build_object('user_id', target, 'reason', why));
    delete from public.occupancy where user_id = target;
  end if;
  perform private.log_action(target, 'mod_ban', reason);
end $$;

create function public.mod_resolve_report(report_id bigint, status public.report_status) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.reports;
begin
  perform private.require_rank_over(null, 'moderator');
  if status is null or status = 'open' then raise exception 'forbidden'; end if;
  select * into r from public.reports x where x.id = report_id for update;
  if not found then raise exception 'not_found'; end if;
  update public.reports set status = mod_resolve_report.status, handled_by = auth.uid(), handled_at = now()
   where id = r.id;
  perform private.log_action(r.target_id, 'mod_resolve_report', null,
    jsonb_build_object('report_id', r.id, 'status', status));
end $$;

create function public.admin_unban(target uuid, reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_rank_over(target, 'admin');
  update public.profiles set banned_at = null, ban_reason = null where id = target;
  perform private.log_action(target, 'admin_unban', reason);
end $$;

create function public.admin_set_role(target uuid, new_role public.app_role) returns void
language plpgsql security definer set search_path = '' as $$
declare old_role public.app_role;
begin
  perform private.require_rank_over(target, 'admin');
  if new_role is null then raise exception 'forbidden'; end if;
  old_role := public.current_role_of(target);
  update public.profiles set role = new_role where id = target;
  perform private.log_action(target, 'admin_set_role', null,
    jsonb_build_object('from', old_role, 'to', new_role));
end $$;

create function public.admin_upsert_room(slug text, title text, kind text, lang text, is_open boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_rank_over(null, 'admin');
  insert into public.rooms as r (slug, title, kind, lang, is_open)
  values (slug, title, kind, lang, coalesce(is_open, true))
  on conflict on constraint rooms_pkey do update
    set title = excluded.title, kind = excluded.kind, lang = excluded.lang, is_open = excluded.is_open;
  perform private.log_action(null, 'admin_upsert_room', null,
    jsonb_build_object('slug', slug, 'title', title, 'kind', kind, 'lang', lang, 'is_open', is_open));
end $$;

create function public.admin_add_filter(pattern text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare fid bigint;
begin
  perform private.require_rank_over(null, 'admin');
  if pattern is null or pattern = '' or not private.is_valid_regex(pattern) then
    raise exception 'invalid_pattern';
  end if;
  begin
    insert into public.word_filter as w (pattern, created_by) values (pattern, auth.uid())
    on conflict on constraint word_filter_pattern_key do update set pattern = excluded.pattern
    returning w.id into fid;
  exception when check_violation then raise exception 'invalid_pattern';
  end;
  perform private.log_action(null, 'admin_add_filter', null,
    jsonb_build_object('filter_id', fid, 'pattern', pattern));
  return fid;
end $$;

create function public.admin_remove_filter(id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare w public.word_filter;
begin
  perform private.require_rank_over(null, 'admin');
  delete from public.word_filter x where x.id = admin_remove_filter.id returning * into w;
  if not found then raise exception 'not_found'; end if;
  perform private.log_action(null, 'admin_remove_filter', null,
    jsonb_build_object('filter_id', w.id, 'pattern', w.pattern));
end $$;

create function public.mod_lookup_user(nickname text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  perform private.require_rank_over(null, 'moderator');
  select * into p from public.profiles x
   where x.nickname = lower(btrim(coalesce(mod_lookup_user.nickname, '')))::extensions.citext;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object(
    'profile', jsonb_build_object('id', p.id, 'nickname', p.nickname, 'role', p.role,
      'github_created_at', p.github_created_at, 'created_at', p.created_at,
      'muted_until', p.muted_until, 'banned_at', p.banned_at, 'ban_reason', p.ban_reason),
    'reports_against', coalesce((select jsonb_agg(to_jsonb(t)) from (
      select r.id, r.reporter_id, r.message_id, r.reason, r.snapshot, r.status, r.handled_by, r.handled_at, r.created_at
        from public.reports r where r.target_id = p.id order by r.created_at desc, r.id desc limit 50) t), '[]'),
    'actions_against', coalesce((select jsonb_agg(to_jsonb(t)) from (
      select a.id, a.actor_id, a.action, a.reason, a.details, a.created_at
        from public.mod_actions a where a.target_id = p.id order by a.created_at desc, a.id desc limit 50) t), '[]'));
end $$;

revoke execute on function
  public.mod_delete_message(bigint, text), public.mod_mute(uuid, int, text), public.mod_unmute(uuid, text),
  public.mod_ban(uuid, text), public.mod_resolve_report(bigint, public.report_status),
  public.admin_unban(uuid, text), public.admin_set_role(uuid, public.app_role),
  public.admin_upsert_room(text, text, text, text, boolean), public.admin_add_filter(text),
  public.admin_remove_filter(bigint), public.mod_lookup_user(text)
  from public, anon;
grant execute on function
  public.mod_delete_message(bigint, text), public.mod_mute(uuid, int, text), public.mod_unmute(uuid, text),
  public.mod_ban(uuid, text), public.mod_resolve_report(bigint, public.report_status),
  public.admin_unban(uuid, text), public.admin_set_role(uuid, public.app_role),
  public.admin_upsert_room(text, text, text, text, boolean), public.admin_add_filter(text),
  public.admin_remove_filter(bigint), public.mod_lookup_user(text)
  to authenticated;

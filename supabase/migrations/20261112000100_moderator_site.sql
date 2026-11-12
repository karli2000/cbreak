-- RPCs for the static moderator site: ban list, staff list, lifting a GitHub-id ban.

create function public.mod_list_banned()
returns table(id uuid, nickname text, banned_at timestamptz, ban_reason text)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_rank_over(null, 'moderator');
  return query
    select p.id, p.nickname::text, p.banned_at, p.ban_reason
    from public.profiles p
    where p.banned_at is not null
    order by p.banned_at desc
    limit 500;
end $$;

create function public.admin_list_staff()
returns table(id uuid, nickname text, role public.app_role)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_rank_over(null, 'admin');
  return query
    select p.id, p.nickname::text, p.role
    from public.profiles p
    where p.role <> 'user'
    order by p.role desc, p.nickname;
end $$;

create function public.admin_unban_github_id(github_id bigint, reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare h text; n int;
begin
  perform private.require_rank_over(null, 'admin');
  h := encode(sha256(convert_to(github_id::text, 'UTF8')), 'hex');
  delete from public.banned_github_ids b where b.github_id_hash = h;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'not_found'; end if;
  perform private.log_action(null, 'admin_unban_github_id', reason,
    jsonb_build_object('github_id_hash', h));
end $$;

revoke execute on function
  public.mod_list_banned(), public.admin_list_staff(), public.admin_unban_github_id(bigint, text)
  from public, anon;
grant execute on function
  public.mod_list_banned(), public.admin_list_staff(), public.admin_unban_github_id(bigint, text)
  to authenticated;

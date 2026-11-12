-- Retention jobs, account deletion, persistent bans

create table public.banned_github_ids (
  github_id_hash text primary key,
  banned_at timestamptz not null default now(),
  reason text
);
alter table public.banned_github_ids enable row level security;
revoke all on public.banned_github_ids from anon, authenticated;

-- deferred minors: sequences + indexes
revoke all on all sequences in schema public from anon, authenticated;
create index reports_reporter_idx on public.reports (reporter_id);
create index reports_target_idx on public.reports (target_id);
create index occupancy_room_instance_last_seen_idx on public.occupancy (room, instance, last_seen);

create function private.purge_expired() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m int; o int; r int; a int;
begin
  delete from public.messages where created_at < now() - interval '15 minutes';
  get diagnostics m = row_count;
  delete from public.occupancy where last_seen < now() - interval '90 seconds';
  get diagnostics o = row_count;
  delete from public.reports
  where status <> 'open' and handled_at < now() - interval '90 days';
  get diagnostics r = row_count;
  delete from public.mod_actions where created_at < now() - interval '1 year';
  get diagnostics a = row_count;
  return jsonb_build_object('messages', m, 'occupancy', o, 'reports', r, 'mod_actions', a);
end $$;
revoke execute on function private.purge_expired() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'coffeebreak-purge') then
    perform cron.unschedule('coffeebreak-purge');
  end if;
  perform cron.schedule('coffeebreak-purge', '* * * * *', 'select private.purge_expired()');
end $$;

create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); p public.profiles;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into p from public.profiles where id = uid for update;
  if found and p.banned_at is not null and p.github_id is not null then
    insert into public.banned_github_ids (github_id_hash, banned_at, reason)
    values (encode(sha256(convert_to(p.github_id::text, 'UTF8')), 'hex'), p.banned_at, p.ban_reason)
    on conflict do nothing;
  end if;
  delete from auth.users where id = uid;
end $$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

create or replace function public.claim_nickname(nick text) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  n text := lower(coalesce(nick, ''));
  p public.profiles;
  gh bigint;
  cname text;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  select * into p from public.profiles where id = uid for update;
  if found and p.banned_at is not null then raise exception 'banned'; end if;

  if n !~ '^[a-z0-9_-]{3,20}$' then raise exception 'nickname_invalid'; end if;
  if n = any (array['admin','administrator','mod','moderator','claude','anthropic',
                    'system','coffee','coffeebreak','root','support','staff']) then
    raise exception 'nickname_reserved';
  end if;

  -- unchanged name: no-op
  if found and p.nickname is not null and p.nickname = n::extensions.citext then
    return p;
  end if;

  if found and p.nickname is not null
     and p.nickname_changed_at is not null
     and p.nickname_changed_at > now() - interval '30 days' then
    raise exception 'nickname_change_too_soon';
  end if;

  if exists (select 1 from public.profiles where nickname = n::extensions.citext and id <> uid) then
    raise exception 'nickname_taken';
  end if;

  begin
    if found then
      update public.profiles set nickname = n, nickname_changed_at = now()
      where id = uid returning * into p;
    else
      select i.provider_id::bigint into gh
      from auth.identities i where i.user_id = uid and i.provider = 'github' limit 1;
      if gh is not null and exists (
        select 1 from public.banned_github_ids b
        where b.github_id_hash = encode(sha256(convert_to(gh::text, 'UTF8')), 'hex')
      ) then
        raise exception 'banned';
      end if;
      insert into public.profiles (id, github_id, nickname)
      values (uid, gh, n) returning * into p;
    end if;
  exception when unique_violation then
    get stacked diagnostics cname = constraint_name;
    if cname = 'profiles_nickname_key' then
      raise exception 'nickname_taken';
    end if;
    raise;
  end;
  return p;
end $$;

create or replace function public.admin_unban(target uuid, reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_rank_over(target, 'admin');
  update public.profiles set banned_at = null, ban_reason = null where id = target;
  delete from public.banned_github_ids b
  where b.github_id_hash = (
    select encode(sha256(convert_to(p.github_id::text, 'UTF8')), 'hex')
    from public.profiles p where p.id = target and p.github_id is not null);
  perform private.log_action(target, 'admin_unban', reason);
end $$;

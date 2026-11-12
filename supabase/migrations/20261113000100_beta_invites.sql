-- Friends beta: invite allowlist. A first claim_nickname needs the caller's GitHub id on the list
-- while beta_settings.invite_only is on. Existing profiles are never affected.
create table public.beta_settings (
  id boolean primary key default true check (id),
  invite_only boolean not null default true
);
insert into public.beta_settings (id, invite_only) values (true, true);

create table public.beta_invites (
  github_id bigint primary key,
  github_login text not null,
  note text,
  invited_by uuid,
  created_at timestamptz not null default now()
);

alter table public.beta_settings enable row level security;
alter table public.beta_invites enable row level security;
create policy beta_settings_select on public.beta_settings for select to authenticated
  using ((select public.is_admin()));
create policy beta_invites_select on public.beta_invites for select to authenticated
  using ((select public.is_admin()));
grant select on public.beta_settings, public.beta_invites to authenticated;
-- service_role bypasses RLS but still needs table privileges (integration tests toggle invite_only)
grant select, insert, update, delete on public.beta_invites to service_role;
grant select, update on public.beta_settings to service_role;

create function public.admin_add_invite(github_id bigint, github_login text, note text) returns void
language plpgsql security definer set search_path = '' as $$
declare lg text := private.clean_text(github_login); nt text := nullif(private.clean_text(note), '');
begin
  perform private.require_rank_over(null, 'admin');
  if github_id is null or lg is null or char_length(lg) < 1 or char_length(lg) > 39 then raise exception 'invalid_login'; end if;
  insert into public.beta_invites as b (github_id, github_login, note, invited_by)
  values (admin_add_invite.github_id, lg, nt, auth.uid())
  on conflict on constraint beta_invites_pkey do update set github_login = excluded.github_login, note = excluded.note;
  perform private.log_action(null, 'admin_add_invite', null,
    jsonb_build_object('github_id', admin_add_invite.github_id, 'github_login', lg));
end $$;

create function public.admin_remove_invite(github_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_rank_over(null, 'admin');
  delete from public.beta_invites b where b.github_id = admin_remove_invite.github_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'not_found'; end if;
  perform private.log_action(null, 'admin_remove_invite', null, jsonb_build_object('github_id', admin_remove_invite.github_id));
end $$;

create function public.admin_set_invite_only(enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_rank_over(null, 'admin');
  if enabled is null then raise exception 'invalid_value'; end if;
  update public.beta_settings set invite_only = enabled where id;
  perform private.log_action(null, 'admin_set_invite_only', null, jsonb_build_object('enabled', enabled));
end $$;

revoke execute on function public.admin_add_invite(bigint, text, text),
  public.admin_remove_invite(bigint), public.admin_set_invite_only(boolean) from public, anon;
grant execute on function public.admin_add_invite(bigint, text, text),
  public.admin_remove_invite(bigint), public.admin_set_invite_only(boolean) to authenticated;

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
      if coalesce((select s.invite_only from public.beta_settings s), true)
         and (gh is null or not exists (select 1 from public.beta_invites v where v.github_id = gh)) then
        raise exception 'not_invited';
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

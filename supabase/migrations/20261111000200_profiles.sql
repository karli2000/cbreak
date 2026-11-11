-- Profile and nickname RPCs

create function public.nickname_available(nick text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare n text := lower(coalesce(nick, ''));
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if n !~ '^[a-z0-9_-]{3,20}$' then return false; end if;
  if n = any (array['admin','administrator','mod','moderator','claude','anthropic',
                    'system','coffee','coffeebreak','root','support','staff']) then
    return false;
  end if;
  return not exists (
    select 1 from public.profiles where nickname = n::extensions.citext
  );
end $$;

create function public.claim_nickname(nick text) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  n text := lower(coalesce(nick, ''));
  p public.profiles;
  gh bigint;
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
      insert into public.profiles (id, github_id, nickname, nickname_changed_at)
      values (uid, gh, n, now()) returning * into p;
    end if;
  exception when unique_violation then
    raise exception 'nickname_taken';
  end;
  return p;
end $$;

create function public.accept_rules() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  update public.profiles set rules_accepted_at = coalesce(rules_accepted_at, now())
  where id = uid;
  if not found then raise exception 'no_profile'; end if;
end $$;

create function public.my_profile() returns public.profiles
language plpgsql stable security definer set search_path = '' as $$
declare p public.profiles;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into p from public.profiles where id = auth.uid();
  if not found then raise exception 'no_profile'; end if;
  return p;
end $$;

revoke execute on function public.nickname_available(text), public.claim_nickname(text),
  public.accept_rules(), public.my_profile() from public, anon;
grant execute on function public.nickname_available(text), public.claim_nickname(text),
  public.accept_rules(), public.my_profile() to authenticated;

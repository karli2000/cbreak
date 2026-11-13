-- Coffee Break is now cbreak (plugin 0.3.0): `cbreak` joins the reserved nicknames.
-- claim_nickname body from 20261114000100, only the reserved list changes.

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
                    'system','coffee','coffeebreak','cbreak','root','support','staff']) then
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

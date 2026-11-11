-- Fixes: banned staff lose all powers; mod_resolve_report enforces rank over the report's target.

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.role in ('moderator', 'admin') and p.banned_at is null
                     from public.profiles p where p.id = auth.uid()), false)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.role = 'admin' and p.banned_at is null
                     from public.profiles p where p.id = auth.uid()), false)
$$;

create or replace function private.require_rank_over(target uuid, min_role public.app_role) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  me public.profiles;
  theirs public.app_role;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into me from public.profiles where id = uid;
  if not found then raise exception 'forbidden'; end if;
  if me.banned_at is not null then raise exception 'banned'; end if;
  if me.role < min_role then raise exception 'forbidden'; end if;
  if target is null then return; end if;
  if target = uid then raise exception 'forbidden'; end if;
  theirs := public.current_role_of(target);
  if theirs is null then raise exception 'not_found'; end if;
  if me.role <= theirs then raise exception 'forbidden'; end if;
end $$;

create or replace function public.mod_resolve_report(report_id bigint, status public.report_status) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.reports;
begin
  perform private.require_rank_over(null, 'moderator');
  if status is null or status = 'open' then raise exception 'forbidden'; end if;
  select * into r from public.reports x where x.id = report_id for update;
  if not found then raise exception 'not_found'; end if;
  if r.target_id is not null then perform private.require_rank_over(r.target_id, 'moderator'); end if;
  update public.reports set status = mod_resolve_report.status, handled_by = auth.uid(), handled_at = now()
   where id = r.id;
  perform private.log_action(r.target_id, 'mod_resolve_report', null,
    jsonb_build_object('report_id', r.id, 'status', status));
end $$;

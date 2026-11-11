-- Coffee Break: base schema, roles, RLS. All writes go through security-definer RPCs (later tasks).
create extension if not exists citext with schema extensions;
create extension if not exists pg_cron;

create type public.app_role as enum ('user', 'moderator', 'admin');
create type public.report_status as enum ('open', 'dismissed', 'actioned');

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  github_id bigint unique,
  nickname extensions.citext unique,
  role public.app_role not null default 'user',
  github_created_at timestamptz,
  rules_accepted_at timestamptz,
  muted_until timestamptz,
  banned_at timestamptz,
  ban_reason text,
  nickname_changed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.rooms (
  slug text primary key check (slug ~ '^[a-z0-9-]{2,32}$'),
  title text not null,
  kind text not null default 'public',
  lang text,
  is_open boolean not null default true
);

create table public.occupancy (
  user_id uuid primary key references public.profiles on delete cascade,
  room text not null references public.rooms,
  instance int not null check (instance >= 1),
  last_seen timestamptz not null default now()
);

create table public.messages (
  id bigint generated always as identity primary key,
  room text not null,
  instance int not null,
  user_id uuid references public.profiles on delete set null,
  nickname extensions.citext not null,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid
);
create index messages_room_instance_created_idx on public.messages (room, instance, created_at);
create index messages_user_created_idx on public.messages (user_id, created_at desc);

create table public.reports (
  id bigint generated always as identity primary key,
  reporter_id uuid references public.profiles on delete set null,
  target_id uuid references public.profiles on delete set null,
  message_id bigint,
  room text,
  instance int,
  reason text not null check (char_length(reason) between 1 and 500),
  snapshot jsonb not null,
  status public.report_status not null default 'open',
  handled_by uuid,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.mod_actions (
  id bigint generated always as identity primary key,
  actor_id uuid,
  target_id uuid,
  action text not null,
  reason text,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Each pattern is a case-insensitive POSIX regex.
create table public.word_filter (
  id bigint generated always as identity primary key,
  pattern text not null unique,
  created_by uuid,
  created_at timestamptz not null default now()
);

insert into public.rooms (slug, title) values ('lobby', 'Lobby');

-- Role helpers (security definer so policies can use them without recursing into profiles RLS)
create function public.current_role_of(uid uuid) returns public.app_role
language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = uid
$$;

create function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.current_role_of(auth.uid()) in ('moderator', 'admin'), false)
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.current_role_of(auth.uid()) = 'admin', false)
$$;

revoke execute on function public.current_role_of(uuid), public.is_staff(), public.is_admin()
  from public, anon;
grant execute on function public.current_role_of(uuid), public.is_staff(), public.is_admin()
  to authenticated;

-- RLS
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.occupancy enable row level security;
alter table public.messages enable row level security;
alter table public.reports enable row level security;
alter table public.mod_actions enable row level security;
alter table public.word_filter enable row level security;

revoke all on public.profiles, public.rooms, public.occupancy, public.messages,
  public.reports, public.mod_actions, public.word_filter from anon, authenticated;
grant select on public.profiles, public.rooms, public.occupancy, public.messages,
  public.reports, public.mod_actions, public.word_filter to authenticated;

create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy rooms_select on public.rooms for select to authenticated using (true);
create policy messages_select on public.messages for select to authenticated
  using (deleted_at is null);
create policy reports_select_staff on public.reports for select to authenticated
  using ((select public.is_staff()));
create policy mod_actions_select_staff on public.mod_actions for select to authenticated
  using ((select public.is_staff()));
create policy word_filter_select_staff on public.word_filter for select to authenticated
  using ((select public.is_staff()));
create policy occupancy_select on public.occupancy for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_staff()));

-- Other users' profiles: only id, nickname, role (view runs as owner, bypassing profiles RLS)
create view public.public_profiles with (security_invoker = false) as
  select id, nickname, role from public.profiles;
revoke all on public.public_profiles from public, anon, authenticated;
grant select on public.public_profiles to authenticated;

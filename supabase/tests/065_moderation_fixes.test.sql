begin;
\ir _helpers.psql
select plan(13);

select tests.create_user('usr') as u \gset
select tests.create_user('pm1', 'moderator') as pm \gset
select tests.create_user('mod1', 'moderator') as m \gset
select tests.create_user('mod2', 'moderator') as m2 \gset
select tests.create_user('adm', 'admin') as a \gset
insert into public.reports (reporter_id, target_id, reason, snapshot) values
  (:'u', :'m', 'against m', '{}'), (:'u', :'m2', 'against m2', '{}'), (:'u', :'a', 'against a', '{}');
select id as r_m from public.reports where reason = 'against m' \gset
select id as r_m2 from public.reports where reason = 'against m2' \gset
select id as r_a from public.reports where reason = 'against a' \gset

-- banned staff lose powers
select tests.login_as(:'a');
select public.mod_ban(:'pm', 'rogue');
select tests.login_as(:'pm');
select throws_ok(format($$select public.mod_mute('%s', 10, 'x')$$, :'u'), 'P0001', 'banned', 'banned mod: mute');
select throws_ok(format($$select public.mod_resolve_report(%s, 'dismissed')$$, :'r_m'), 'P0001', 'banned', 'banned mod: resolve');
select throws_ok($$select public.mod_lookup_user('usr')$$, 'P0001', 'banned', 'banned mod: lookup');
select is((select count(*)::int from public.reports), 0, 'banned mod sees no reports');
select is(public.is_staff(), false, 'is_staff false when banned');
select is(public.is_admin(), false, 'is_admin false when banned (mod)');
select tests.login_as(:'m');
select is(public.is_staff(), true, 'is_staff true for healthy mod');

-- rank rule on report resolution
select throws_ok(format($$select public.mod_resolve_report(%s, 'dismissed')$$, :'r_m'), 'P0001', 'forbidden', 'mod: own report');
select throws_ok(format($$select public.mod_resolve_report(%s, 'dismissed')$$, :'r_m2'), 'P0001', 'forbidden', 'mod: peer report');
select tests.login_as(:'a');
select public.mod_resolve_report(:'r_m', 'dismissed');
select is((select status::text from public.reports where id = :'r_m'), 'dismissed', 'admin resolves report against mod');
select throws_ok(format($$select public.mod_resolve_report(%s, 'dismissed')$$, :'r_a'), 'P0001', 'forbidden', 'admin: own report');

-- admin_remove_filter
select public.admin_add_filter('zzz') as fid \gset
select public.admin_remove_filter(:fid);
select throws_ok($$select public.admin_remove_filter(999999999)$$, 'P0001', 'not_found', 'unknown filter');
select tests.logout();
select is((select count(*)::int from public.mod_actions where action = 'admin_remove_filter') + (select count(*)::int from public.word_filter where pattern = 'zzz'), 1, 'filter removed, one audit row');

select * from finish();
rollback;

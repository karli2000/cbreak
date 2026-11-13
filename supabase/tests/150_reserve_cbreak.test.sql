-- The rename to cbreak (0.3.0): the new product name is a reserved nickname like the old ones.
begin;
\ir _helpers.psql
select plan(3);

select tests.create_auth_user(616161) as u \gset
select tests.login_as(:'u');
select throws_ok($$select public.claim_nickname('cbreak')$$, 'P0001', 'nickname_reserved', 'cbreak is reserved');
select throws_ok($$select public.claim_nickname('CBreak')$$, 'P0001', 'nickname_reserved', 'any case');
select throws_ok($$select public.claim_nickname('coffeebreak')$$, 'P0001', 'nickname_reserved', 'the old name stays reserved');

select * from finish();
rollback;

begin;
select plan(2);
select has_extension('pgtap');
select ok(1 = 1, 'select 1 = 1');
select * from finish();
rollback;

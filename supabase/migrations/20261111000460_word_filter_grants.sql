-- CHECK constraints run with the inserting role's privileges: service_role needs
-- access to the validator. Nothing is granted to public/anon/authenticated.
grant usage on schema private to service_role;
grant execute on function private.is_valid_regex(text) to service_role;

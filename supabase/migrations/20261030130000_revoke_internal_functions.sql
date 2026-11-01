-- ZEYD BARBER — hide internal helper functions from the API
-- Supabase grants EXECUTE on new functions to anon and authenticated explicitly, so the
-- "revoke ... from public" of the previous migration was not enough: anonymous visitors could
-- call /rest/v1/rpc/reset_policies (it then failed on permissions, but it must not be reachable).
-- Re-running this file is harmless.

begin;

revoke execute on function public.reset_policies(regclass) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

commit;

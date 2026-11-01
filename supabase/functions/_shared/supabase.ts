// Minimal Supabase access for the Edge Functions (plain fetch, no SDK).
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase itself.

export type Env = (name: string) => string | undefined;

// Calls a database function with the service_role key (server only: never sent to a browser).
export function serviceRpc(env: Env, fetchImpl: typeof fetch = fetch) {
    const url = env('SUPABASE_URL');
    const key = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('supabase_not_configured');
    return async (name: string, args: Record<string, unknown>): Promise<unknown> => {
        const response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
            method: 'POST',
            headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(args),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
            // The database raises short codes (e.g. 'already_paid') as message
            throw new Error((body as { message?: string } | null)?.message ?? `rpc_${response.status}`);
        }
        return body;
    };
}

// The signed-in user behind a request, checked by Supabase Auth (never trusted from the body).
export async function getUser(
    env: Env,
    authorization: string | null,
    fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; email?: string } | null> {
    if (!authorization?.startsWith('Bearer ')) return null;
    const response = await fetchImpl(`${env('SUPABASE_URL')}/auth/v1/user`, {
        headers: { apikey: env('SUPABASE_ANON_KEY') ?? '', Authorization: authorization },
    });
    if (!response.ok) return null;
    const user = (await response.json()) as { id?: string; email?: string };
    return user?.id ? { id: user.id, email: user.email } : null;
}

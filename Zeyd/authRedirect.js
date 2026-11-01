// Return from a Supabase Auth email link (sign-up confirmation).
// Supabase redirects to the site with the result in the URL:
//   success: #access_token=...&refresh_token=...&type=signup
//   failure: #error=access_denied&error_code=otp_expired&error_description=...
// (the error can also arrive in the query string). This module only reads the URL; the session itself is
// restored by supabase-js (detectSessionInUrl).

// Error codes that mean "this link can no longer be used" (expired, already used, or altered)
const EXPIRED_CODES = ['otp_expired', 'otp_disabled', 'flow_state_expired', 'flow_state_not_found'];

export function parseAuthRedirect(hash = '', search = '') {
    const fromHash = new URLSearchParams(String(hash).replace(/^#/, ''));
    const fromQuery = new URLSearchParams(String(search).replace(/^\?/, ''));
    const get = (name) => fromHash.get(name) ?? fromQuery.get(name);

    const error = get('error_code') ?? get('error');
    if (error) return { kind: 'error', reason: EXPIRED_CODES.includes(error) ? 'link_expired' : 'link_failed' };
    if (fromHash.has('access_token') || fromQuery.has('code'))
        return { kind: 'session', type: get('type') ?? 'signup' };
    return null;
}

// Address of the page without the auth parameters, to put back in the address bar
export function cleanAuthUrl(pathname, search = '') {
    const params = new URLSearchParams(String(search).replace(/^\?/, ''));
    for (const name of ['error', 'error_code', 'error_description', 'code', 'type', 'sb']) params.delete(name);
    const rest = params.toString();
    return `${pathname}${rest ? `?${rest}` : ''}`;
}

import { BACKEND } from './config.js';

// Exact version so a new release can never change the site without a commit.
const SUPABASE_JS_URL = 'https://esm.sh/@supabase/supabase-js@2.49.4';

let clientPromise = null;

// Returns the Supabase client, or null when no backend is configured.
// The library is only downloaded when a backend is actually used.
export function getSupabase() {
    if (!BACKEND) return Promise.resolve(null);
    clientPromise ??= import(SUPABASE_JS_URL).then(({ createClient }) =>
        createClient(BACKEND.url, BACKEND.publishableKey),
    );
    return clientPromise;
}

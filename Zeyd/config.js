// Which Supabase project the site talks to.
// null = no backend: the site uses the built-in content of data.js (current behaviour).
//
// Only the project URL and the *publishable* key belong here: both are public by design and
// protected by Row Level Security. Never put a secret / service_role key in the website.
//
// Example once the dev project exists (see docs/SUPABASE_SETUP.md):
// export const BACKEND = { url: 'https://<project-ref>.supabase.co', publishableKey: 'sb_publishable_…' };
export const BACKEND = null;

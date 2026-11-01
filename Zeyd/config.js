// Which Supabase project the site talks to.
// null = no backend: the site uses the built-in content of data.js (current behaviour).
//
// Only the project URL and the *publishable* key belong here: both are public by design and
// protected by Row Level Security. Never put a secret / service_role key in the website.
//
// Projects (see docs/SUPABASE_SETUP.md). Development uses zeyd-dev-1 only; production is switched on
// in Phase 7, after its migration and a backup.
const DEV = {
    url: 'https://eyqlptbocufkxcpblpxu.supabase.co',
    publishableKey: 'sb_publishable_0goG073hRyJKLJ-N9_JJLA_ceKuiBi_',
};

export const BACKEND = DEV;

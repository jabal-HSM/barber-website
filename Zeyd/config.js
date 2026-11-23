// Which Supabase project the site talks to.
// null = no backend: the site uses the built-in content of data.js (current behaviour).
//
// Only the project URL and the *publishable* key belong here: both are public by design and
// protected by Row Level Security. Never put a secret / service_role key in the website.
//
// Projects (see docs/SUPABASE_SETUP.md). zeyd-dev-1 (eyqlptbocufkxcpblpxu) was deleted on 2026-11-22; the
// demo now uses the new project iqkcfaznnxurgwudutao. Production is switched on in Phase 7.
const DEV = {
    url: 'https://iqkcfaznnxurgwudutao.supabase.co',
    publishableKey: 'sb_publishable_je86a1nlRzUAQtjADzjQWg_uBDs9Ydc',
};

export const BACKEND = DEV;

// The salon's own contact links, filled in for each salon. An empty value hides every button that uses it
// (and the « Nous trouver » block when none is set): the site never shows a link that leads nowhere.
//   whatsapp: 'https://wa.me/33612345678'   instagram: 'https://www.instagram.com/votre_salon'
//   maps: 'https://maps.google.com/?q=…'    address: written address, used in the Google Calendar event
export const SALON_CONTACT = {
    whatsapp: '',
    instagram: '',
    maps: '',
    address: '',
};

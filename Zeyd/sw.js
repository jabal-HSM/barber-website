// Service worker of the installed app. Network first: online, every page and script comes fresh from the
// server (so a new version never mixes with an old cached module); the copy kept here is only used when the
// phone is offline. Requests to other sites (Supabase, fonts, CDNs) are never touched.
const CACHE = 'zeyd-pages-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response.ok && response.type === 'basic') {
                    const copy = response.clone();
                    caches.open(CACHE).then((cache) => cache.put(request, copy));
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(request);
                if (cached) return cached;
                if (request.mode === 'navigate') return (await caches.match('/')) ?? Response.error();
                return Response.error();
            }),
    );
});

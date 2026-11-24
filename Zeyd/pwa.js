// Installable app: service worker + the « Installer l'application » banner.
// Android / Chrome / Edge: the browser's own install prompt, opened by our button.
// iPhone / iPad (Safari has no prompt): the banner explains « Partager → Sur l'écran d'accueil ».
// Never shown once installed (opened from the home screen) or for 14 days after the visitor closes it.
const DISMISS_KEY = 'installDismissedAt';
const DISMISS_DAYS = 14;
const SHOW_DELAY_MS = 15000;

const $ = (id) => document.getElementById(id);

export function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

// iPhone, iPod, and iPad (which reports itself as a Mac with a touch screen)
export function isIos(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints) {
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

export function recentlyDismissed(value, now = Date.now()) {
    const at = Number(value);
    return Number.isFinite(at) && at > 0 && now - at < DISMISS_DAYS * 24 * 3600e3;
}

function readDismissed() {
    try {
        return localStorage.getItem(DISMISS_KEY);
    } catch {
        return null;
    }
}

function writeDismissed() {
    try {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
        // Storage blocked: the banner simply comes back on the next visit
    }
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('sw.js').catch(() => {
        // No offline copy, the site works the same
    });
}

export function initInstall({ translate }) {
    registerServiceWorker();
    const banner = $('installBanner');
    if (!banner || isStandalone() || recentlyDismissed(readDismissed())) return;

    const hint = $('installHint');
    const button = $('installBtn');
    let deferredPrompt = null;

    const show = (mode) => {
        // mode 'prompt' (button) or 'ios' (instructions, no button)
        const key = mode === 'ios' ? 'install.ios' : 'install.text';
        hint.dataset.i18n = key;
        hint.textContent = translate(key);
        button.hidden = mode === 'ios';
        setTimeout(() => {
            if (!isStandalone()) banner.hidden = false;
        }, SHOW_DELAY_MS);
    };
    const hide = () => {
        banner.hidden = true;
    };

    const offer = (event) => {
        deferredPrompt = event;
        window.__installPrompt = null;
        show('prompt');
    };
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault(); // keep it for our button instead of the browser's mini bar
        offer(event);
    });
    // Offer that arrived before this module ran (kept by the small script in the page's <head>)
    if (window.__installPrompt) offer(window.__installPrompt);
    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        hide();
    });

    button.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        const prompt = deferredPrompt;
        deferredPrompt = null;
        prompt.prompt();
        const { outcome } = await prompt.userChoice;
        hide();
        if (outcome !== 'accepted') writeDismissed();
    });
    $('installClose').addEventListener('click', () => {
        hide();
        writeDismissed();
    });

    // Safari on iOS never fires beforeinstallprompt
    if (isIos()) show('ios');
}

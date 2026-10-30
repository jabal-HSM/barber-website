// Interface sounds (Web Audio). The three files are short cuts of the two recordings in sounds-src/:
//   theme-switch.wav  snd2 6.280–6.530 s (press + release)  → theme toggle only
//   scroll-tick.wav   snd1 6.329–6.374 s (one bright tick)  → scrolling
//   tap.wav           snd1 6.266–6.421 s (one full unit)    → links, menu, section navigation
// Nothing is downloaded before the first tap/key press, and only when sounds are on. Any failure (no Web
// Audio, blocked, file missing) leaves the site silent and working.
import { canPlay, createScrollTicker, DEFAULT_SOUND_PREFS, normalizeSoundPrefs } from './soundCore.js';

const STORAGE_KEY = 'soundPrefs';
const FILES = { theme: 'sounds/theme-switch.wav', scroll: 'sounds/scroll-tick.wav', tap: 'sounds/tap.wav' };
// Quiet on purpose: these are feedback, not music
const GAIN = { theme: 0.32, tap: 0.22, scroll: 0.16, scrollFast: 0.11 };
const MAX_SCROLL_VOICES = 2;
// After a click on an in-page link the page scrolls by itself: no ticks for that movement
const PROGRAMMATIC_SCROLL_MS = 1200;

let prefs = readPrefs();
const listeners = new Set();
let ctx = null;
// Promise of the download + decoding, started once by the first gesture
let loading = null;
let buffers = null;
let initialized = false;
const scrollVoices = [];
const ticker = createScrollTicker();
let frame = 0;
let quietUntil = 0;
let lastTheme = 0;

function readPrefs() {
    try {
        return normalizeSoundPrefs(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
    } catch {
        return { ...DEFAULT_SOUND_PREFS };
    }
}

function writePrefs() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
        // Private mode: the choice lasts for this visit only
    }
}

export function getSoundPrefs() {
    return { ...prefs };
}

// change = one or more of { enabled, scroll, theme }, chosen by the person
export function setSoundPrefs(change) {
    prefs = normalizeSoundPrefs({ ...prefs, ...change, updatedAt: Date.now() });
    applyPrefs('local');
}

// Preferences coming from the account (already merged with the local ones by the caller)
export function adoptSoundPrefs(next) {
    prefs = normalizeSoundPrefs(next);
    applyPrefs('account');
}

export function onSoundPrefsChange(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}

function applyPrefs(source) {
    writePrefs();
    if (!prefs.enabled || !prefs.scroll) stopScrollVoices();
    if (!prefs.enabled) ctx?.suspend().catch(() => {});
    else if (ctx?.state === 'suspended' && !document.hidden) ctx.resume().catch(() => {});
    renderSettings();
    for (const callback of listeners) callback(getSoundPrefs(), source);
}

// --- Audio engine ---
function ensureAudio() {
    if (!prefs.enabled) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    try {
        ctx ??= new AudioCtx();
    } catch {
        return;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    // Downloaded and decoded once per page
    if (loading) return;
    loading = Promise.all(
        Object.entries(FILES).map(async ([name, url]) => {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`sound ${name}`);
            return [name, await ctx.decodeAudioData(await response.arrayBuffer())];
        }),
    )
        .then((entries) => {
            buffers = Object.fromEntries(entries);
        })
        .catch(() => {
            buffers = null;
        });
}

function play(name, gainValue, rate = 1) {
    if (!buffers?.[name] || !ctx || ctx.state !== 'running') return null;
    try {
        const source = ctx.createBufferSource();
        source.buffer = buffers[name];
        source.playbackRate.value = rate;
        const gain = ctx.createGain();
        gain.gain.value = gainValue;
        source.connect(gain).connect(ctx.destination);
        source.start();
        return source;
    } catch {
        return null;
    }
}

function stopScrollVoices() {
    for (const voice of scrollVoices.splice(0)) {
        try {
            voice.stop();
        } catch {
            // already finished
        }
    }
}

// The very first action of a visit can come before the files are decoded (they start loading on that same
// gesture): play as soon as they are ready, but only if that is still within FIRST_SOUND_MAX_DELAY_MS, so a
// late sound never plays out of step with the action. Never blocks the action itself.
const FIRST_SOUND_MAX_DELAY_MS = 300;

function playSoon(name, gainValue) {
    if (play(name, gainValue) || !loading) return;
    const asked = performance.now();
    Promise.all([loading, ctx?.state === 'running' ? null : ctx?.resume()])
        .then(() => {
            if (performance.now() - asked <= FIRST_SOUND_MAX_DELAY_MS) play(name, gainValue);
        })
        .catch(() => {});
}

export function playThemeSound() {
    if (!canPlay(prefs, 'theme')) return;
    const now = performance.now();
    if (now - lastTheme < 150) return; // one toggle = one sound
    lastTheme = now;
    ensureAudio();
    playSoon('theme', GAIN.theme);
}

function playTap() {
    if (!canPlay(prefs, 'tap')) return;
    playSoon('tap', GAIN.tap);
}

// --- Scroll ---
function onScroll() {
    if (frame || !canPlay(prefs, 'scroll') || !buffers) return;
    frame = requestAnimationFrame(() => {
        frame = 0;
        const now = performance.now();
        const tick = ticker.update(window.scrollY, now);
        if (!tick || now < quietUntil) return;
        const gain = tick.interval < 140 ? GAIN.scrollFast : GAIN.scroll;
        // ±4 % pitch so a fast scroll does not sound like a machine gun
        const voice = play('scroll', gain, 0.96 + Math.random() * 0.08);
        if (!voice) return;
        scrollVoices.push(voice);
        voice.onended = () => {
            const index = scrollVoices.indexOf(voice);
            if (index >= 0) scrollVoices.splice(index, 1);
        };
        while (scrollVoices.length > MAX_SCROLL_VOICES) {
            try {
                scrollVoices.shift().stop();
            } catch {
                // already finished
            }
        }
    });
}

// Deliberate actions that get the short "tap": external links (Maps, WhatsApp, Instagram), section links,
// menu button. The theme button has its own sound; form fields and typing never make a sound.
const TAP_SELECTOR = [
    'a[href^="http"]',
    'a[href^="#"]',
    '#menuToggleBtn',
    '[data-open-account]',
    '.lang-btn',
    '.auth-btn',
    '.auth-link',
].join(',');

function onClick(event) {
    const target = event.target.closest?.(TAP_SELECTOR);
    if (!target || target.id === 'themeToggleBtn') return;
    if (target.matches('a[href^="#"]')) quietUntil = performance.now() + PROGRAMMATIC_SCROLL_MS;
    playTap();
}

// --- Settings (switches in the account dialog and in the footer) ---
function renderSettings() {
    for (const input of document.querySelectorAll('[data-sound-pref]')) {
        const key = input.dataset.soundPref;
        input.checked = Boolean(prefs[key]);
        input.disabled = key !== 'enabled' && !prefs.enabled;
    }
}

function onSettingChange(event) {
    const input = event.target.closest?.('[data-sound-pref]');
    if (!input) return;
    setSoundPrefs({ [input.dataset.soundPref]: input.checked });
    if (input.checked) ensureAudio();
}

export function initSound() {
    if (initialized) return;
    initialized = true;
    renderSettings();
    // Browsers only allow audio after a gesture: the engine starts on the first one
    const unlock = () => ensureAudio();
    for (const type of ['pointerdown', 'keydown', 'touchend']) {
        document.addEventListener(type, unlock, { capture: true, passive: true });
    }
    document.addEventListener('click', onClick, { capture: true, passive: true });
    document.addEventListener('change', onSettingChange);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopScrollVoices();
            ticker.reset();
            ctx?.suspend().catch(() => {});
        } else if (prefs.enabled && ctx) {
            ctx.resume().catch(() => {});
        }
    });
    // Another tab changed the preferences
    window.addEventListener('storage', (e) => {
        if (e.key !== STORAGE_KEY) return;
        prefs = readPrefs();
        applyPrefs('storage');
    });
}

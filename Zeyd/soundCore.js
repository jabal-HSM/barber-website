// Sound logic without the browser: preferences and the scroll "tick" timing (tested in tests/sound.test.mjs).
// Playback itself is in sound.js.

// enabled = all interface sounds (off = muted); scroll and theme can be turned off on their own.
// volume = 0…1, applied to every sound.
// updatedAt = when the person last changed them (0 = never, i.e. the defaults).
export const DEFAULT_SOUND_PREFS = Object.freeze({ enabled: true, scroll: true, theme: true, volume: 1, updatedAt: 0 });

export function normalizeSoundPrefs(raw) {
    const prefs = raw && typeof raw === 'object' ? raw : {};
    const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
    const updatedAt = Number(prefs.updatedAt);
    const volume = Number(prefs.volume);
    return {
        enabled: flag(prefs.enabled, DEFAULT_SOUND_PREFS.enabled),
        scroll: flag(prefs.scroll, DEFAULT_SOUND_PREFS.scroll),
        theme: flag(prefs.theme, DEFAULT_SOUND_PREFS.theme),
        volume: Number.isFinite(volume) ? Math.min(Math.max(volume, 0), 1) : DEFAULT_SOUND_PREFS.volume,
        updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
    };
}

// Choices saved in this browser vs. in the account: the most recent explicit choice wins.
// Same moment (or both never changed): a sound turned off anywhere stays off.
export function mergeSoundPrefs(local, remote) {
    const a = normalizeSoundPrefs(local);
    if (!remote) return a;
    const b = normalizeSoundPrefs(remote);
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
    return {
        enabled: a.enabled && b.enabled,
        scroll: a.scroll && b.scroll,
        theme: a.theme && b.theme,
        volume: Math.min(a.volume, b.volume),
        updatedAt: a.updatedAt,
    };
}

export function samePrefs(a, b) {
    const x = normalizeSoundPrefs(a);
    const y = normalizeSoundPrefs(b);
    return (
        x.enabled === y.enabled &&
        x.scroll === y.scroll &&
        x.theme === y.theme &&
        x.volume === y.volume &&
        x.updatedAt === y.updatedAt
    );
}

export function canPlay(prefs, kind) {
    const p = normalizeSoundPrefs(prefs);
    if (!p.enabled || p.volume === 0) return false;
    if (kind === 'scroll') return p.scroll;
    if (kind === 'theme') return p.theme;
    return true;
}

// Scroll ticks follow the distance actually travelled: one tick every `stepPx`, so a slow scroll gives
// sparse ticks and a fast one denser ticks, never closer than `minIntervalMs`.
// A pause longer than `idleMs` starts a new movement (no tick owed from the previous one);
// a jump bigger than `jumpPx` between two frames (restored position, jump to a section) is not a movement.
export function createScrollTicker({ stepPx = 90, minIntervalMs = 70, idleMs = 160, jumpPx = 1500 } = {}) {
    let lastY = null;
    let lastTime = 0;
    let travelled = 0;
    let lastTick = -Infinity;

    return {
        // Returns null (no sound) or { interval } = ms since the previous tick, to adapt the volume
        update(y, now) {
            if (lastY === null) {
                lastY = y;
                lastTime = now;
                return null;
            }
            // After a pause the movement starts again from zero, but this first step still counts
            // (a mouse wheel without smooth scrolling moves in single jumps of ~100 px)
            if (now - lastTime > idleMs) travelled = 0;
            const delta = Math.abs(y - lastY);
            lastY = y;
            lastTime = now;
            if (delta > jumpPx) {
                travelled = 0;
                return null;
            }
            travelled += delta;
            if (travelled < stepPx || now - lastTick < minIntervalMs) return null;
            // Keep the remainder (bounded) so the rhythm stays tied to the distance
            travelled = Math.min(travelled - stepPx, stepPx);
            const interval = now - lastTick;
            lastTick = now;
            return { interval };
        },
        reset() {
            lastY = null;
            travelled = 0;
        },
    };
}

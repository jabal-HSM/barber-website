// Sound preferences and scroll-tick timing (Zeyd/soundCore.js). Playback itself needs a browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    canPlay,
    createScrollTicker,
    DEFAULT_SOUND_PREFS,
    mergeSoundPrefs,
    normalizeSoundPrefs,
} from '../Zeyd/soundCore.js';

test('missing or broken preferences fall back to the defaults', () => {
    assert.deepEqual(normalizeSoundPrefs(null), { ...DEFAULT_SOUND_PREFS });
    assert.deepEqual(normalizeSoundPrefs('x'), { ...DEFAULT_SOUND_PREFS });
    assert.deepEqual(normalizeSoundPrefs({ enabled: 'no', scroll: false, updatedAt: 'soon' }), {
        enabled: true,
        scroll: false,
        theme: true,
        volume: 1,
        updatedAt: 0,
    });
});

test('volume: from 0 to 1, out-of-range values are brought back, 0 plays nothing', () => {
    assert.equal(normalizeSoundPrefs({ volume: 0.4 }).volume, 0.4);
    assert.equal(normalizeSoundPrefs({ volume: 7 }).volume, 1);
    assert.equal(normalizeSoundPrefs({ volume: -1 }).volume, 0);
    assert.equal(normalizeSoundPrefs({ volume: 'loud' }).volume, 1);
    assert.equal(canPlay({ enabled: true, volume: 0 }, 'tap'), false);
    assert.equal(canPlay({ enabled: true, volume: 0.05 }, 'tap'), true);
    const tie = mergeSoundPrefs({ volume: 0.3, updatedAt: 9 }, { volume: 0.8, updatedAt: 9 });
    assert.equal(tie.volume, 0.3, 'on a tie the quieter level wins');
});

test('turning interface sounds off silences every kind; each kind can also be off alone', () => {
    const off = { enabled: false, scroll: true, theme: true };
    assert.equal(canPlay(off, 'scroll'), false);
    assert.equal(canPlay(off, 'theme'), false);
    assert.equal(canPlay(off, 'tap'), false);
    const noScroll = { enabled: true, scroll: false, theme: true };
    assert.equal(canPlay(noScroll, 'scroll'), false);
    assert.equal(canPlay(noScroll, 'theme'), true);
    assert.equal(canPlay(noScroll, 'tap'), true, 'disabling the scroll sound does not disable the others');
    const noTheme = { enabled: true, scroll: true, theme: false };
    assert.equal(canPlay(noTheme, 'theme'), false);
    assert.equal(canPlay(noTheme, 'scroll'), true);
});

test('the most recent explicit choice wins between this browser and the account', () => {
    const localOff = { enabled: false, scroll: true, theme: true, updatedAt: 2000 };
    const accountOn = { enabled: true, scroll: true, theme: true, updatedAt: 1000 };
    assert.equal(mergeSoundPrefs(localOff, accountOn).enabled, false, 'an older "on" never re-enables');
    assert.equal(mergeSoundPrefs({ ...localOff, updatedAt: 500 }, accountOn).enabled, true);
});

test('defaults never override a choice, and on a tie a sound turned off stays off', () => {
    const choice = { enabled: true, scroll: false, theme: true, volume: 1, updatedAt: 1000 };
    assert.deepEqual(mergeSoundPrefs(DEFAULT_SOUND_PREFS, choice), choice);
    assert.deepEqual(mergeSoundPrefs(choice, DEFAULT_SOUND_PREFS), choice);
    assert.deepEqual(mergeSoundPrefs(choice, null), choice);
    const tie = mergeSoundPrefs(
        { enabled: true, scroll: false, theme: true, updatedAt: 7 },
        { enabled: true, scroll: true, theme: false, updatedAt: 7 },
    );
    assert.deepEqual(tie, { enabled: true, scroll: false, theme: false, volume: 1, updatedAt: 7 });
});

// Simulates a scroll at `speed` px/s, one frame every 16 ms, for `ms` milliseconds
function simulate(ticker, { speed, ms, start = 0, from = 0 }) {
    const ticks = [];
    let y = from;
    for (let t = start; t <= start + ms; t += 16) {
        const tick = ticker.update(y, t);
        if (tick) ticks.push(t);
        y += (speed * 16) / 1000;
    }
    return { ticks, y, end: start + ms };
}

test('slow scrolling gives sparse ticks, fast scrolling denser ones, within a limit', () => {
    const slow = simulate(createScrollTicker(), { speed: 300, ms: 2000 });
    const fast = simulate(createScrollTicker(), { speed: 1500, ms: 2000 });
    const fling = simulate(createScrollTicker(), { speed: 8000, ms: 2000 });
    assert.ok(slow.ticks.length >= 5 && slow.ticks.length <= 8, `slow: ${slow.ticks.length}`);
    assert.ok(fast.ticks.length > slow.ticks.length * 3, `fast: ${fast.ticks.length}`);
    // Never more than one tick per 70 ms (≈ 14 per second), however fast the fling
    assert.ok(fling.ticks.length <= 2000 / 70 + 1, `fling: ${fling.ticks.length}`);
    for (let i = 1; i < fling.ticks.length; i += 1) assert.ok(fling.ticks[i] - fling.ticks[i - 1] >= 70);
});

test('ticks follow the distance: none while the page is still, none after scrolling stops', () => {
    const ticker = createScrollTicker();
    const moving = simulate(ticker, { speed: 1000, ms: 1000 });
    assert.ok(moving.ticks.length > 0);
    // Page still for 3 s: same position every frame
    const still = simulate(ticker, { speed: 0, ms: 3000, start: moving.end + 16, from: moving.y });
    assert.equal(still.ticks.length, 0);
});

test('a jump (restored position, jump to a section) is not a movement', () => {
    const ticker = createScrollTicker();
    assert.equal(ticker.update(0, 0), null);
    assert.equal(ticker.update(4000, 16), null);
    assert.equal(ticker.update(4010, 32), null);
});

test('single wheel notches without smooth scrolling each give a tick', () => {
    const ticker = createScrollTicker();
    ticker.update(0, 0);
    assert.ok(ticker.update(100, 1000), 'one notch of 100 px after a pause');
    assert.ok(ticker.update(200, 1600), 'next notch');
    assert.equal(ticker.update(240, 2400), null, 'a 40 px nudge is below one step');
});

test('after a pause the new movement starts fresh (no tick owed from before)', () => {
    const ticker = createScrollTicker();
    ticker.update(0, 0);
    ticker.update(80, 16); // 80 px: just under one step
    assert.equal(ticker.update(85, 1000), null, 'long pause: restart');
    assert.equal(ticker.update(95, 1016), null, '10 px after the restart is not enough for a tick');
});

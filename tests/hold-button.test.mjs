// Timing logic of the "hold to confirm" button (Zeyd/holdButton.js). The DOM part needs a browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHoldController } from '../Zeyd/holdButton.js';

function track(duration = 1000) {
    const events = { progress: [], completed: 0 };
    const c = createHoldController({
        duration,
        onProgress: (p) => events.progress.push(p),
        onComplete: () => {
            events.completed += 1;
        },
    });
    return { c, events };
}

test('nothing happens before the full duration', () => {
    const { c, events } = track(1000);
    c.start(0);
    assert.equal(c.tick(400), 0.4);
    assert.equal(c.tick(999), 0.999);
    assert.equal(events.completed, 0);
});

test('holding for the full duration confirms exactly once', () => {
    const { c, events } = track(1000);
    c.start(0);
    c.tick(1000);
    c.tick(1500);
    c.tick(3000);
    assert.equal(events.completed, 1);
    assert.equal(c.done, true);
    assert.equal(c.start(4000), false, 'cannot start again after confirming');
});

test('releasing early cancels and the progress returns to zero', () => {
    const { c, events } = track(1000);
    c.start(0);
    c.tick(700);
    assert.equal(c.cancel(), true);
    assert.equal(events.progress.at(-1), 0);
    assert.equal(c.tick(2000), 0, 'no progress after release');
    assert.equal(events.completed, 0);
});

test('a new hold starts from zero, never from the previous progress', () => {
    const { c, events } = track(1000);
    c.start(0);
    c.tick(900);
    c.cancel();
    c.start(5000);
    assert.equal(c.tick(5500), 0.5);
    assert.equal(events.completed, 0);
});

test('a second start while holding (two fingers, key repeat) is ignored', () => {
    const { c } = track(1000);
    assert.equal(c.start(0), true);
    assert.equal(c.start(300), false);
    assert.equal(c.tick(1000), 1);
});

test('after a failed action reset() allows holding again', () => {
    const { c, events } = track(1000);
    c.start(0);
    c.tick(1000);
    c.reset();
    assert.equal(c.done, false);
    assert.equal(c.start(2000), true);
    c.tick(3000);
    assert.equal(events.completed, 2);
});

// Installable app: which phones get the iPhone instructions, how long « Fermer » keeps the banner away,
// and that the manifest and icons the browser needs are there.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isIos, recentlyDismissed } from '../Zeyd/pwa.js';

const ZEYD = join(import.meta.dirname, '..', 'Zeyd');
const DAY = 24 * 3600e3;

test('iPhone and iPad get the « Partager » instructions, Android and computers do not', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
    assert.equal(isIos(iphone, 5), true);
    assert.equal(isIos(ipad, 5), true, 'iPad reports itself as a Mac with a touch screen');
    assert.equal(isIos(ipad, 0), false, 'a real Mac has no touch points');
    assert.equal(isIos(android, 5), false);
});

test('« Fermer » hides the banner for 14 days, then it may come back', () => {
    const now = Date.UTC(2026, 10, 22);
    assert.equal(recentlyDismissed(String(now - 2 * DAY), now), true);
    assert.equal(recentlyDismissed(String(now - 13.9 * DAY), now), true);
    assert.equal(recentlyDismissed(String(now - 14 * DAY), now), false);
    assert.equal(recentlyDismissed(null, now), false);
    assert.equal(recentlyDismissed('n’importe quoi', now), false);
});

test('manifest: installable name, start page, standalone display and the three icons exist', () => {
    const manifest = JSON.parse(readFileSync(join(ZEYD, 'manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.name, 'Votre salon'); // placeholder: each salon puts its own name
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.display, 'standalone');
    const sizes = manifest.icons.map((i) => `${i.sizes} ${i.purpose}`);
    assert.deepEqual(sizes, ['192x192 any', '512x512 any', '512x512 maskable']);
    for (const icon of manifest.icons) assert.ok(existsSync(join(ZEYD, icon.src)), icon.src);
    for (const file of ['apple-touch-icon.png', 'favicon-48.png']) assert.ok(existsSync(join(ZEYD, 'icons', file)));
    // PNG size from the file header (bytes 16-23)
    const png = readFileSync(join(ZEYD, 'icons', 'icon-512.png'));
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [512, 512]);
});

test('the service worker never answers for other sites (Supabase, fonts, CDNs)', () => {
    const sw = readFileSync(join(ZEYD, 'sw.js'), 'utf8');
    assert.match(sw, /origin !== self\.location\.origin\) return;/);
    assert.match(sw, /request\.method !== 'GET'/);
});

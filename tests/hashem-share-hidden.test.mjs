// The Hashem share setting is not shown in any page or language, and the dashboard never sends it, so its
// database value (payment_settings.hashem_share_cents) and the payment split stay as they are.
// Static check of the site files; the split itself is tested in allocations.test.mjs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const siteDir = new URL('../Zeyd/', import.meta.url);
const siteFiles = readdirSync(siteDir).filter((name) => /\.(html|js)$/.test(name));

test('the Hashem share text appears in no page and no translation', () => {
    for (const name of siteFiles) {
        const text = readFileSync(new URL(name, siteDir), 'utf8');
        for (const needle of ['حصة هاشم', 'Part de Hashem', 'settings.hashemShare', 'setHashemShare']) {
            assert.ok(!text.includes(needle), `${name} still contains « ${needle} »`);
        }
    }
});

test('no page writes hashem_share_cents', () => {
    for (const name of siteFiles) {
        const text = readFileSync(new URL(name, siteDir), 'utf8');
        assert.ok(!text.includes('hashem_share_cents'), `${name} still uses hashem_share_cents`);
    }
});

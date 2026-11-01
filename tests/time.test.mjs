// Paris time conversions used by the custom-request form and the booking labels.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDateOf, formatDay, formatTime, parisLocalToIso } from '../Zeyd/time.js';

test('Paris wall-clock time converts to UTC in winter and summer', () => {
    assert.equal(parisLocalToIso('2026-11-02T18:45'), '2026-11-02T17:45:00.000Z'); // UTC+1
    assert.equal(parisLocalToIso('2027-06-05T09:00'), '2027-06-05T07:00:00.000Z'); // UTC+2
});

test('conversion is right on both sides of a daylight saving change', () => {
    assert.equal(parisLocalToIso('2027-03-27T10:00'), '2027-03-27T09:00:00.000Z'); // Saturday before
    assert.equal(parisLocalToIso('2027-03-29T10:00'), '2027-03-29T08:00:00.000Z'); // Monday after
});

test('invalid input gives null', () => {
    for (const bad of ['', null, '2026-11-02', '18:45', '2026-11-02 18:45']) assert.equal(parisLocalToIso(bad), null);
});

test('times and days are shown in Paris time with Latin digits in both languages', () => {
    assert.equal(formatTime('2026-11-02T08:00:00Z'), '09:00');
    assert.match(formatDay('2026-11-02', 'fr'), /lun.*2.*nov/);
    assert.match(formatDay('2026-11-02', 'ar'), /2/);
    assert.doesNotMatch(formatDay('2026-11-02', 'ar'), /[٠-٩]/);
    // 23:30 UTC on Sunday 1 Nov is already Monday in Paris
    assert.match(formatDateOf('2026-11-01T23:30:00Z', 'fr'), /lundi 2 novembre/);
});

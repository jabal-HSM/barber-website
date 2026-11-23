// "Ajouter à Google Calendar": the link must carry the exact booking times (UTC), the Paris time zone,
// the service and the salon, and give no link at all when the times cannot be trusted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleCalendarUrl, SALON_LOCATION, toCalendarUtc } from '../Zeyd/calendarLink.js';

const ADDRESS = '12 rue de l’Exemple, 75001 Paris';

import { parisLocalToIso } from '../Zeyd/time.js';

const read = (url) => {
    const u = new URL(url);
    return { origin: `${u.origin}${u.pathname}`, ...Object.fromEntries(u.searchParams) };
};
const link = (startParis, endParis, extra = {}) =>
    read(
        googleCalendarUrl({
            title: 'ZEYD BARBER · Dégradé bas',
            startsAt: parisLocalToIso(startParis),
            endsAt: parisLocalToIso(endParis),
            ...extra,
        }),
    );

test('the official template link with title, UTC dates and the Paris time zone', () => {
    const p = link('2026-11-02T09:00', '2026-11-02T09:35', {
        details: 'Rendez-vous chez ZEYD BARBER',
        location: ADDRESS,
    });
    assert.equal(p.origin, 'https://calendar.google.com/calendar/render');
    assert.equal(p.action, 'TEMPLATE');
    assert.equal(p.text, 'ZEYD BARBER · Dégradé bas');
    assert.equal(p.dates, '20261102T080000Z/20261102T083500Z'); // 09:00 Paris in winter = 08:00 UTC
    assert.equal(p.ctz, 'Europe/Paris');
    assert.equal(p.details, 'Rendez-vous chez ZEYD BARBER');
    assert.equal(p.location, ADDRESS);
});

test('summer time, winter time and the days of the clock change', () => {
    assert.equal(link('2027-06-05T14:00', '2027-06-05T14:35').dates, '20270605T120000Z/20270605T123500Z');
    // Last Saturday before the spring change (UTC+1) and the Monday after it (UTC+2)
    assert.equal(link('2027-03-27T18:00', '2027-03-27T18:35').dates, '20270327T170000Z/20270327T173500Z');
    assert.equal(link('2027-03-29T09:00', '2027-03-29T09:35').dates, '20270329T070000Z/20270329T073500Z');
    // Autumn change: Saturday 2026-10-24 (UTC+2), Monday 2026-10-26 (UTC+1)
    assert.equal(link('2026-10-24T09:00', '2026-10-24T09:35').dates, '20261024T070000Z/20261024T073500Z');
    assert.equal(link('2026-10-26T09:00', '2026-10-26T09:35').dates, '20261026T080000Z/20261026T083500Z');
});

test('month and year boundaries keep the right day', () => {
    assert.equal(link('2026-11-30T18:30', '2026-11-30T19:05').dates, '20261130T173000Z/20261130T180500Z');
    assert.equal(link('2027-01-01T09:00', '2027-01-01T09:35').dates, '20270101T080000Z/20270101T083500Z');
    // 00:30 Paris on 1 January is still 31 December in UTC: the UTC form says so, Google shows it in Paris time
    assert.equal(link('2027-01-01T00:30', '2027-01-01T01:00').dates, '20261231T233000Z/20270101T000000Z');
    assert.equal(link('2028-02-29T10:00', '2028-02-29T10:35').dates, '20280229T090000Z/20280229T093500Z');
});

test('the duration is the one of the booking (end time from the database)', () => {
    assert.equal(link('2026-11-06T14:00', '2026-11-06T14:30').dates, '20261106T130000Z/20261106T133000Z');
    assert.equal(link('2026-11-06T11:20', '2026-11-06T12:00').dates, '20261106T102000Z/20261106T110000Z');
});

test('Arabic text and special characters survive the link', () => {
    const p = link('2026-11-02T09:00', '2026-11-02T09:35', {
        title: 'ZEYD BARBER · تدرّج منخفض',
        details: 'موعد & ملاحظة #1 ? = +',
    });
    assert.equal(p.text, 'ZEYD BARBER · تدرّج منخفض');
    assert.equal(p.details, 'موعد & ملاحظة #1 ? = +');
});

test('no salon address configured: the event simply has no location', () => {
    assert.equal(SALON_LOCATION, '');
    const p = link('2026-11-02T09:00', '2026-11-02T09:35', { location: SALON_LOCATION });
    assert.equal(p.location, undefined);
});

test('no link when the times are missing, invalid or reversed', () => {
    const start = '2026-11-02T08:00:00.000Z';
    assert.equal(googleCalendarUrl({ title: 'x', startsAt: start, endsAt: null }), null);
    assert.equal(googleCalendarUrl({ title: 'x', startsAt: 'pas une date', endsAt: start }), null);
    assert.equal(googleCalendarUrl({ title: 'x', startsAt: start, endsAt: start }), null);
    assert.equal(googleCalendarUrl({ title: 'x', startsAt: start, endsAt: '2026-11-02T07:00:00.000Z' }), null);
    assert.equal(toCalendarUtc(undefined), null);
});

test('times with an offset from the database are read correctly', () => {
    assert.equal(toCalendarUtc('2026-11-02T09:00:00+01:00'), '20261102T080000Z');
    assert.equal(toCalendarUtc('2027-06-05T14:00:00+02:00'), '20270605T120000Z');
});

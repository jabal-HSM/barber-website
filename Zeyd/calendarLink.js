// "Ajouter à Google Calendar": the public event-template link of Google Calendar (no API, no sign-in on
// our side). The times are sent in UTC (…Z), so the event lands at the right hour whatever the phone's time
// zone; ctz only makes Google show it in Paris time.
import { SALON_TIME_ZONE } from './time.js';

const TEMPLATE_URL = 'https://calendar.google.com/calendar/render';
// Same point as the Google Maps links in index.html (the salon has no written address on the site yet)
export const SALON_LOCATION = '46.2074029,5.225510799999999';

// 2026-11-02T17:45:00.000Z -> 20261102T174500Z; null when the date is missing or invalid
export function toCalendarUtc(ts) {
    const date = new Date(ts);
    if (!ts || Number.isNaN(date.getTime())) return null;
    return date
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');
}

// Returns the link, or null when the times cannot be used (then no button is shown)
export function googleCalendarUrl({ title, startsAt, endsAt, details = '', location = '' }) {
    const start = toCalendarUtc(startsAt);
    const end = toCalendarUtc(endsAt);
    if (!start || !end || new Date(endsAt) <= new Date(startsAt)) return null;
    const params = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${start}/${end}` });
    if (details) params.set('details', details);
    if (location) params.set('location', location);
    params.set('ctz', SALON_TIME_ZONE);
    return `${TEMPLATE_URL}?${params}`;
}

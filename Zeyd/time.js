// Salon time helpers. The salon works in Paris time whatever the visitor's own time zone.
export const SALON_TIME_ZONE = 'Europe/Paris';

// Arabic keeps Latin digits for dates and times, like the rest of the site.
const LOCALES = { fr: 'fr-FR', ar: 'ar-u-nu-latn' };

// Offset (ms) between Paris wall-clock time and UTC at instant `ts`.
function parisOffsetMs(ts) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', {
            timeZone: SALON_TIME_ZONE,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        })
            .formatToParts(new Date(ts))
            .map((p) => [p.type, p.value]),
    );
    const wallClockAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return wallClockAsUtc - ts;
}

// '2026-11-02T18:45' read as Paris time -> ISO string in UTC. Returns null for invalid input.
export function parisLocalToIso(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value ?? '');
    if (!match) return null;
    const [, y, mo, d, h, mi] = match.map(Number);
    const wallClock = Date.UTC(y, mo - 1, d, h, mi);
    let ts = wallClock;
    // Twice: the offset at the guessed instant can differ from the final one around a DST change.
    for (let i = 0; i < 2; i += 1) ts = wallClock - parisOffsetMs(ts);
    return new Date(ts).toISOString();
}

// 'HH:MM' in Paris time
export function formatTime(ts) {
    return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: SALON_TIME_ZONE }).format(
        new Date(ts),
    );
}

// A calendar day 'YYYY-MM-DD' (no time zone) as a label, e.g. 'lun. 2 nov.'
export function formatDay(isoDay, lang, style = 'short') {
    const options =
        style === 'long'
            ? { weekday: 'long', day: 'numeric', month: 'long' }
            : { weekday: 'short', day: 'numeric', month: 'short' };
    return new Intl.DateTimeFormat(LOCALES[lang] ?? LOCALES.fr, { ...options, timeZone: 'UTC' }).format(
        new Date(`${isoDay}T12:00:00Z`),
    );
}

// The Paris calendar day of an instant, as a long label
export function formatDateOf(ts, lang) {
    return new Intl.DateTimeFormat(LOCALES[lang] ?? LOCALES.fr, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: SALON_TIME_ZONE,
    }).format(new Date(ts));
}

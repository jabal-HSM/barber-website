// Every start time of a day for one service, free or taken, so a taken time is shown greyed out
// (« Réservé ») instead of disappearing. Built from the public opening hours and step, and from the free
// times returned by available_slots(): a start that is not free is taken. A taken entry carries only a
// time, never who booked it. The database stays the only judge: book_appointment() refuses a taken or
// overlapping time whatever this list says.

const minutesOf = (time) => {
    const [h, m] = String(time).split(':').map(Number);
    return h * 60 + m;
};
const hhmm = (minutes) =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// ISO weekday (1 = Monday … 7 = Sunday) of a 'YYYY-MM-DD' day
export function isoWeekday(day) {
    return ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

// Same starts as available_slots(): from each opening time, every `stepMinutes`, while the service still
// ends before closing, and not earlier than the notice period. `toIso` turns 'YYYY-MM-DDTHH:MM' (Paris)
// into an ISO timestamp.
export function buildSlotGrid({ day, hours, stepMinutes, durationMinutes, minNoticeMinutes, now, freeSlots, toIso }) {
    const free = new Map(freeSlots.map((slot) => [Date.parse(slot.starts_at), slot]));
    const grid = new Map();
    if (stepMinutes > 0 && durationMinutes > 0) {
        const earliest = now + minNoticeMinutes * 60_000;
        const weekday = isoWeekday(day);
        for (const row of hours.filter((h) => h.weekday === weekday)) {
            const last = minutesOf(row.closes_at) - durationMinutes;
            for (let m = minutesOf(row.opens_at); m <= last; m += stepMinutes) {
                const iso = toIso(`${day}T${hhmm(m)}`);
                const ts = Date.parse(iso);
                if (!iso || ts < earliest) continue;
                const slot = free.get(ts);
                grid.set(ts, slot ? { ...slot, taken: false } : { starts_at: iso, taken: true });
            }
        }
    }
    // A free time the hours above do not explain is still offered (the database said it is free)
    for (const [ts, slot] of free) if (!grid.has(ts)) grid.set(ts, { ...slot, taken: false });
    return [...grid.entries()].sort((a, b) => a[0] - b[0]).map(([, slot]) => slot);
}

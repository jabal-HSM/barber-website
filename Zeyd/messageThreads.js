// Messages with the salon grouped by booking, and the state of each conversation, for both sides:
//   viewer 'customer' (« Profil » page) or 'staff' (dashboard). « Mine » = written by the viewer's side.
//   new      — the last message comes from the other side and is not opened yet
//   answered — the last message comes from the other side and was opened (the other side has answered)
//   read     — the last message is mine and the other side opened it
//   sent     — the last message is mine and is not opened yet
// Used by messagesCenter.js and admin.js; tested in tests/message-threads.test.mjs.

export function groupThreads(messages, viewer) {
    const mineIsStaff = viewer === 'staff';
    const byBooking = new Map();
    for (const m of [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
        if (!byBooking.has(m.booking_id)) byBooking.set(m.booking_id, []);
        byBooking.get(m.booking_id).push(m);
    }
    const threads = [...byBooking.entries()].map(([bookingId, list]) => {
        const last = list.at(-1);
        const lastIsMine = last.from_staff === mineIsStaff;
        const unread = list.filter((m) => m.from_staff !== mineIsStaff && !m.read_at).length;
        let status;
        if (lastIsMine) status = last.read_at ? 'read' : 'sent';
        else status = unread ? 'new' : 'answered';
        return { bookingId, messages: list, last, status, unread };
    });
    // Conversations with something new first, then the most recent
    return threads.sort(
        (a, b) => (b.unread > 0) - (a.unread > 0) || Date.parse(b.last.created_at) - Date.parse(a.last.created_at),
    );
}

export const unreadCount = (messages, viewer) =>
    messages.filter((m) => m.from_staff !== (viewer === 'staff') && !m.read_at).length;

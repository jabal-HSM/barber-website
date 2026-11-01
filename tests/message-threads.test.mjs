// Conversation states shown to the customer and to the salon (Zeyd/messageThreads.js). Pure logic, no database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupThreads, unreadCount } from '../Zeyd/messageThreads.js';

const msg = (booking_id, from_staff, minute, read = false) => ({
    id: `${booking_id}-${minute}`,
    booking_id,
    from_staff,
    body: 'x',
    created_at: new Date(Date.UTC(2026, 10, 2, 9, minute)).toISOString(),
    read_at: read ? new Date(Date.UTC(2026, 10, 2, 10, 0)).toISOString() : null,
});

test('customer side: sent, read, new, answered', () => {
    const threads = groupThreads(
        [
            msg('a', false, 1), // my message, not opened by the salon
            msg('b', false, 2, true), // my message, opened by the salon
            msg('c', false, 3, true),
            msg('c', true, 4), // the salon answered, I have not opened it
            msg('d', false, 5, true),
            msg('d', true, 6, true), // the salon answered, opened
        ],
        'customer',
    );
    const status = Object.fromEntries(threads.map((t) => [t.bookingId, t.status]));
    assert.deepEqual(status, { a: 'sent', b: 'read', c: 'new', d: 'answered' });
    assert.equal(threads[0].bookingId, 'c', 'the conversation with something new comes first');
    assert.equal(threads.find((t) => t.bookingId === 'c').unread, 1);
});

test('salon side: the same messages seen from the other end', () => {
    const messages = [msg('a', false, 1), msg('b', false, 2, true), msg('c', true, 3)];
    const status = Object.fromEntries(groupThreads(messages, 'staff').map((t) => [t.bookingId, t.status]));
    assert.deepEqual(status, { a: 'new', b: 'answered', c: 'sent' });
});

test('unread count: only the messages from the other side that are not opened', () => {
    const messages = [msg('a', false, 1), msg('a', true, 2), msg('b', true, 3, true), msg('b', true, 4)];
    assert.equal(unreadCount(messages, 'customer'), 2);
    assert.equal(unreadCount(messages, 'staff'), 1);
    assert.equal(unreadCount([], 'customer'), 0);
});

test('messages are put back in time order inside a conversation', () => {
    const [thread] = groupThreads([msg('a', true, 9), msg('a', false, 1, true)], 'customer');
    assert.deepEqual(
        thread.messages.map((m) => m.from_staff),
        [false, true],
    );
    assert.equal(thread.status, 'new');
});

// « Messages avec Zeyd » in « Profil »: the customer writes about one of their bookings and reads the salon's
// answers. Data: booking_messages (RLS: own messages only), written through customer_send_message. A red dot
// on « Profil » (and on « Mon compte » on wide screens) shows only while a salon message is unread; opening
// « Profil » marks them read. Until the migration is applied, the card says the messaging is not available yet.
import { fetchMyMessages, fetchMyRecentBookings, isMissingTable, markMyMessagesRead, sendMyMessage } from './api.js';
import { groupThreads, unreadCount } from './messageThreads.js';
import { formatDateOf, formatTime } from './time.js';

const POLL_MS = 60_000;
const $ = (id) => document.getElementById(id);

let ctx = null; // { getUser, getLang, t, setMessage }
let messages = [];
let bookings = [];
let available = true;
let loaded = false;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function setDots(count) {
    for (const dot of document.querySelectorAll('.unread-dot, .account-dot')) dot.hidden = count === 0;
}

const bookingLabel = (booking, lang) => {
    if (!booking?.starts_at) return '';
    const service = (lang === 'ar' && booking.services?.name_ar) || booking.services?.name_fr || '';
    return [formatDateOf(booking.starts_at, lang), formatTime(booking.starts_at), service].filter(Boolean).join(' · ');
};

function renderForm() {
    const select = $('messageBooking');
    const form = $('messageForm');
    if (!select || !form) return;
    const lang = ctx.getLang();
    form.hidden = !available;
    select.replaceChildren(
        ...bookings.map((b) => {
            const option = el('option', '', bookingLabel(b, lang));
            option.value = b.id;
            return option;
        }),
    );
    const none = available && !bookings.length;
    select.disabled = none;
    $('messageBody').disabled = none;
    $('messageSend').disabled = none;
}

function renderThreads() {
    const box = $('messageThreads');
    if (!box) return;
    const lang = ctx.getLang();
    if (!available) {
        box.replaceChildren(el('p', 'field-hint', ctx.t('messages.unavailable')));
        return;
    }
    if (!loaded) {
        box.replaceChildren(el('p', 'field-hint', ctx.t('booking.loading')));
        return;
    }
    const threads = groupThreads(messages, 'customer');
    if (!threads.length) {
        const hint = bookings.length ? 'messages.empty' : 'messages.noBookings';
        box.replaceChildren(el('p', 'field-hint', ctx.t(hint)));
        return;
    }
    box.replaceChildren(
        ...threads.map((thread) => {
            const card = el('article', 'message-thread');
            const head = el('header', 'message-thread-head');
            head.append(
                el('p', 'message-thread-title', bookingLabel(thread.last.bookings, lang)),
                el('span', `message-status is-${thread.status}`, ctx.t(`messages.status.${thread.status}`)),
            );
            const list = el('ul', 'message-list');
            for (const m of thread.messages) {
                const item = el('li', `message ${m.from_staff ? 'is-theirs' : 'is-mine'}`);
                const body = el('p', 'message-body', m.body);
                body.dir = 'auto';
                item.append(
                    body,
                    el(
                        'p',
                        'message-meta',
                        `${ctx.t(m.from_staff ? 'messages.fromSalon' : 'messages.fromMe')} · ${formatDateOf(m.created_at, lang)} ${formatTime(m.created_at)}`,
                    ),
                );
                list.append(item);
            }
            card.append(head, list);
            return card;
        }),
    );
}

export function renderMessages() {
    if (!ctx) return;
    renderForm();
    renderThreads();
}

// markRead: « Profil » is open, so the salon's messages are now seen (the statuses shown keep « new » this time)
export async function refreshMessages({ markRead = false } = {}) {
    if (!ctx) return;
    if (!ctx.getUser()) {
        messages = [];
        loaded = false;
        setDots(0);
        return;
    }
    const { data, error } = await fetchMyMessages();
    loaded = true;
    if (error) {
        available = !isMissingTable(error);
        messages = [];
    } else {
        available = true;
        messages = data ?? [];
    }
    renderThreads();
    const unread = unreadCount(messages, 'customer');
    if (markRead && unread) {
        const { error: markError } = await markMyMessagesRead();
        if (!markError) {
            const now = new Date().toISOString();
            messages = messages.map((m) => (m.from_staff && !m.read_at ? { ...m, read_at: now } : m));
        }
        setDots(markError ? unread : 0);
        return;
    }
    setDots(unread);
}

export async function openMessages() {
    const user = ctx?.getUser();
    if (!user) return;
    bookings = await fetchMyRecentBookings(user.id);
    renderForm();
    await refreshMessages({ markRead: true });
}

function messageErrorKey(error) {
    const key = `messages.error.${error?.message ?? ''}`;
    return ctx.t(key) === key ? 'messages.error.other' : key;
}

export function initMessagesCenter(helpers) {
    ctx = helpers;
    const form = $('messageForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const bookingId = $('messageBooking').value;
        const body = $('messageBody').value.trim();
        if (!bookingId || !body) {
            ctx.setMessage('messagesMessage', 'error', 'messages.error.message_empty');
            return;
        }
        $('messageSend').disabled = true;
        const { error } = await sendMyMessage(bookingId, body);
        $('messageSend').disabled = false;
        if (error) {
            ctx.setMessage('messagesMessage', 'error', messageErrorKey(error));
            return;
        }
        $('messageBody').value = '';
        ctx.setMessage('messagesMessage', 'success', 'messages.sent');
        await refreshMessages();
    });
    // The red dot stays up to date while the site is open
    setInterval(() => {
        if (!document.hidden && ctx.getUser()) refreshMessages();
    }, POLL_MS);
}

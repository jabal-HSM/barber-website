// Barber / admin dashboard. Every action is checked by the database (RLS policies and functions
// that verify the role): this page only shows what the signed-in account is allowed to do.
import { at } from './admin-i18n.js';
import { getSupabase } from './supabaseClient.js';
import { formatDateOf, formatTime, parisLocalToIso, SALON_TIME_ZONE } from './time.js';

const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
const MAX_PHOTO_SIDE = 1600;
const root = document.documentElement;
const $ = (id) => document.getElementById(id);
const euros = new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
});

const state = {
    lang: 'fr',
    supabase: null,
    user: null,
    isAdmin: false,
    panel: 'home',
    loyaltyCode: null,
    scanStream: null,
    scanTimer: null,
    customers: [],
    messages: {},
};

// --- Preferences (same keys as the site) ---
function readPref(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writePref(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Only for this visit
    }
}

// --- Small DOM helpers ---
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label, className, onClick) {
    const b = el('button', className, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
}

function input(type, value, attrs = {}) {
    const i = el('input', 'field');
    i.type = type;
    i.value = value ?? '';
    for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
    return i;
}

function labelled(text, control) {
    const wrapper = el('label', 'admin-field');
    wrapper.append(el('span', 'field-label', text), control);
    return wrapper;
}

const todayInParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: SALON_TIME_ZONE }).format(new Date());

function nextDay(isoDay) {
    const d = new Date(`${isoDay}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

// --- Messages (icon + text) ---
function setMessage(id, kind, key, params = {}) {
    state.messages[id] = kind ? { kind, key, params } : null;
    renderMessage(id);
}

function renderMessage(id) {
    const box = $(id);
    const message = state.messages[id];
    if (!box) return;
    box.hidden = !message;
    if (!message) return;
    box.className = `admin-message form-message ${message.kind === 'success' ? 'is-success' : 'is-error'}`;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', message.kind === 'success' ? '#i-check' : '#i-alert');
    icon.append(use);
    box.replaceChildren(icon, el('p', 'form-message-text', at(state.lang, message.key, message.params)));
}

function errorKey(error) {
    if (/violates check constraint/i.test(error?.message ?? '')) return 'error.validation';
    if (error?.code === '23503') return 'error.in_use';
    const code = String(error?.message ?? '');
    const key = `error.${code}`;
    return at(state.lang, key) === key ? 'common.error' : key;
}

// --- Language and theme ---
function applyLanguage(lang) {
    state.lang = lang;
    root.lang = lang;
    root.dir = lang === 'ar' ? 'rtl' : 'ltr';
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = at(lang, node.dataset.i18n);
    for (const node of document.querySelectorAll('[data-i18n-attr]')) {
        for (const pair of node.dataset.i18nAttr.split(';')) {
            const [attr, key] = pair.split(':').map((p) => p.trim());
            if (attr && key) node.setAttribute(attr, at(lang, key));
        }
    }
    document.title = at(lang, 'meta.title');
    for (const b of document.querySelectorAll('[data-lang]'))
        b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    for (const id of Object.keys(state.messages)) renderMessage(id);
    if (state.user) openPanel(state.panel);
}

function initTheme() {
    const setTheme = (theme) => {
        root.dataset.theme = theme;
        $('themeToggleBtn').setAttribute('aria-pressed', String(theme === 'dark'));
    };
    setTheme(readPref('theme') === 'dark' ? 'dark' : 'light');
    $('themeToggleBtn').addEventListener('click', () => {
        root.classList.add('is-theme-switching');
        setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
        getComputedStyle(root).color;
        root.classList.remove('is-theme-switching');
        writePref('theme', root.dataset.theme);
    });
}

// --- Access gate ---
function gate(key, withLink = false) {
    $('gateText').textContent = at(state.lang, key);
    $('gateText').dataset.i18n = key;
    $('gateLink').hidden = !withLink;
}

async function init() {
    applyLanguage(readPref('lang') === 'ar' ? 'ar' : 'fr');
    initTheme();
    for (const b of document.querySelectorAll('[data-lang]')) {
        b.addEventListener('click', () => {
            applyLanguage(b.dataset.lang);
            writePref('lang', b.dataset.lang);
        });
    }

    const supabase = await getSupabase();
    if (!supabase) return gate('gate.offline');
    state.supabase = supabase;
    const {
        data: { session },
    } = await supabase.auth.getSession();
    if (!session) return gate('gate.signIn', true);
    state.user = session.user;

    const [{ data: staff }, { data: admin }] = await Promise.all([supabase.rpc('is_staff'), supabase.rpc('is_admin')]);
    if (!staff) {
        state.user = null;
        return gate('gate.forbidden');
    }
    state.isAdmin = Boolean(admin);

    $('adminGate').hidden = true;
    $('adminTabs').hidden = false;
    $('adminSignOut').hidden = false;
    $('adminSignOut').addEventListener('click', async () => {
        await supabase.auth.signOut();
        location.href = 'index.html';
    });
    for (const tab of document.querySelectorAll('.admin-tab')) {
        tab.addEventListener('click', () => openPanel(tab.dataset.panel));
    }
    initBookings();
    initLoyalty();
    initServices();
    initHours();
    initGallery();
    initCustomers();
    initSettings();
    openPanel(location.hash.slice(1) || 'home');
}

const loaders = {};

function openPanel(name) {
    if (!loaders[name]) name = 'home';
    state.panel = name;
    for (const panel of document.querySelectorAll('.admin-panel')) panel.hidden = panel.dataset.panel !== name;
    for (const tab of document.querySelectorAll('.admin-tab')) {
        if (tab.dataset.panel === name) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
    }
    history.replaceState(null, '', `#${name}`);
    if (name !== 'loyalty') stopScan();
    loaders[name]();
}

/// --- Bookings: shared query and card (home, day and week views) ---
const BOOKING_COLUMNS =
    'id, customer_id, starts_at, ends_at, status, is_custom_request, customer_note, cancel_reason, cancelled_at, cancelled_by, created_at, updated_at, profiles:customer_id (full_name, email), services (name_fr, name_ar, price, duration_minutes)';
// Added by 20261101090000_phase6_cancellations.sql: until it is applied the dashboard uses the columns above
const BOOKING_COLUMNS_PHASE6 = ', cancel_reason_code, cancel_details, rescheduled_from';

const missingColumn = (error) => error?.code === '42703' || /column .* does not exist/i.test(error?.message ?? '');

async function fetchBookingsBetween(fromDay, toDayExclusive) {
    const query = (columns) =>
        state.supabase
            .from('bookings')
            .select(columns)
            .gte('starts_at', parisLocalToIso(`${fromDay}T00:00`))
            .lt('starts_at', parisLocalToIso(`${toDayExclusive}T00:00`))
            .order('starts_at');
    const result = await query(BOOKING_COLUMNS + BOOKING_COLUMNS_PHASE6);
    return missingColumn(result.error) ? query(BOOKING_COLUMNS) : result;
}

function addDays(isoDay, days) {
    const d = new Date(`${isoDay}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

// Monday of the week of `isoDay`
const weekStart = (isoDay) => addDays(isoDay, -((new Date(`${isoDay}T12:00:00Z`).getUTCDay() + 6) % 7));
const serviceName = (b) => (state.lang === 'ar' && b.services?.name_ar) || b.services?.name_fr || '';
const cancelledByCustomer = (b) => Boolean(b.cancelled_by) && b.cancelled_by === b.customer_id;

function cancellationInfo(b) {
    const box = el('div', 'cancel-info');
    const when = b.cancelled_at
        ? { date: formatDateOf(b.cancelled_at, state.lang), time: formatTime(b.cancelled_at) }
        : null;
    const by = cancelledByCustomer(b) ? 'bookings.cancelledByCustomer' : 'bookings.cancelledBySalon';
    box.append(el('p', 'admin-item-meta', when ? at(state.lang, by, when) : at(state.lang, 'status.cancelled')));
    if (b.cancel_reason_code) {
        box.append(
            el(
                'p',
                'cancel-reason',
                at(state.lang, 'bookings.reasonLabel', { reason: at(state.lang, `reason.${b.cancel_reason_code}`) }),
            ),
        );
    }
    const details = b.cancel_details || b.cancel_reason;
    if (details) box.append(el('p', 'admin-item-meta', at(state.lang, 'bookings.details', { details })));
    return box;
}

function bookingItem(b, { compact = false } = {}) {
    const item = el('li', `admin-item booking-item is-${b.status}`);
    const info = el('div', 'admin-item-body');
    const when = el(
        'p',
        'admin-item-title',
        `${formatTime(b.starts_at)}${b.ends_at ? ` – ${formatTime(b.ends_at)}` : ''}`,
    );
    when.dir = 'ltr';
    info.append(when, el('p', '', `${b.profiles?.full_name || '—'} · ${serviceName(b)}`));
    if (!compact) {
        if (b.profiles?.email) {
            const mail = el('a', 'admin-item-meta', b.profiles.email);
            mail.href = `mailto:${String(b.profiles.email).replace(/[^\w.+@-]/g, '')}`;
            mail.dir = 'ltr';
            info.append(mail);
        }
        const facts = [];
        if (b.services?.price != null) facts.push(euros.format(Number(b.services.price)));
        if (b.ends_at)
            facts.push(
                at(state.lang, 'bookings.minutes', {
                    count: Math.round((new Date(b.ends_at) - new Date(b.starts_at)) / 60000),
                }),
            );
        if (facts.length) info.append(el('p', 'admin-item-meta', facts.join(' · ')));
    }
    const badges = el('p');
    badges.append(el('span', `status-badge is-${b.status}`, at(state.lang, `status.${b.status}`)));
    if (b.is_custom_request)
        badges.append(' ', el('span', 'status-badge is-requested', at(state.lang, 'bookings.custom')));
    if (b.rescheduled_from) badges.append(' ', el('span', 'status-badge', at(state.lang, 'bookings.rescheduled')));
    info.append(badges);
    if (b.customer_note)
        info.append(el('p', 'admin-item-meta', at(state.lang, 'bookings.note', { note: b.customer_note })));
    if (b.status === 'cancelled') info.append(cancellationInfo(b));
    item.append(info);
    if (!compact) item.append(bookingActions(b));
    return item;
}

function bookingActions(b) {
    const actions = el('div', 'admin-row admin-actions');
    const setStatus = (status) => async () => {
        const { error } = await state.supabase.rpc('set_booking_status', { p_booking_id: b.id, p_status: status });
        if (error) setMessage('bookingsMessage', 'error', errorKey(error));
        loaders.bookings();
    };
    if (b.status === 'requested')
        actions.append(button(at(state.lang, 'bookings.confirm'), 'btn btn-primary btn-sm', setStatus('confirmed')));
    if (b.status === 'confirmed' && new Date(b.starts_at) <= new Date()) {
        actions.append(
            button(at(state.lang, 'bookings.done'), 'btn btn-primary btn-sm', setStatus('completed')),
            button(at(state.lang, 'bookings.noShow'), 'btn btn-ghost btn-sm', setStatus('no_show')),
        );
    }
    if (b.status === 'confirmed' || b.status === 'requested') {
        actions.append(
            button(at(state.lang, 'bookings.cancel'), 'btn btn-ghost btn-sm', () =>
                actions.replaceWith(cancelForm(b, actions)),
            ),
        );
    }
    if (b.status === 'confirmed' || b.status === 'completed') {
        actions.append(
            button(at(state.lang, 'payments.record'), 'btn btn-ghost btn-sm', () =>
                actions.replaceWith(paymentForm(b, actions)),
            ),
        );
    }
    actions.append(
        button(at(state.lang, 'bookings.history'), 'btn btn-ghost btn-sm', (e) => toggleHistory(b, e.currentTarget)),
    );
    return actions;
}

// A payment received outside Stripe. Bank transfer: only after checking it in the bank's own app.
function paymentForm(b, actions) {
    const form = el('form', 'admin-cancel-form');
    const method = el('select', 'field');
    for (const m of ['cash', 'card_terminal', 'bank_transfer']) {
        const option = el('option', '', at(state.lang, `method.${m}`));
        option.value = m;
        method.append(option);
    }
    const amount = input('number', b.services?.price ?? '', {
        min: '0.5',
        max: '500',
        step: '0.5',
        inputmode: 'decimal',
    });
    const reference = input('text', '', { maxlength: '100' });
    const hint = el('p', 'field-hint', at(state.lang, 'payments.recordHint'));
    const refresh = () => {
        hint.textContent = at(
            state.lang,
            method.value === 'bank_transfer' ? 'payments.transferHint' : 'payments.recordHint',
        );
    };
    method.addEventListener('change', refresh);
    const confirm = el('button', 'btn btn-primary btn-sm', at(state.lang, 'payments.confirmRecord'));
    confirm.type = 'submit';
    const row = el('div', 'admin-row');
    row.append(
        confirm,
        button(at(state.lang, 'bookings.keep'), 'btn btn-ghost btn-sm', () => form.replaceWith(actions)),
    );
    form.append(
        el('p', 'admin-item-title', at(state.lang, 'payments.recordTitle')),
        labelled(at(state.lang, 'payments.method'), method),
        labelled(at(state.lang, 'payments.amount'), amount),
        labelled(at(state.lang, 'payments.reference'), reference),
        hint,
        row,
    );
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (confirm.disabled) return;
        const cents = Math.round(Number(amount.value) * 100);
        if (!Number.isInteger(cents) || cents <= 0) {
            setMessage('bookingsMessage', 'error', 'error.validation');
            return;
        }
        confirm.disabled = true;
        const { data, error } = await state.supabase.rpc('staff_record_payment', {
            p_booking_id: b.id,
            p_amount_cents: cents,
            p_method: method.value,
            p_reference: reference.value.trim() || null,
        });
        if (error) {
            confirm.disabled = false;
            setMessage('bookingsMessage', 'error', errorKey(error));
            return;
        }
        const r = data?.[0];
        setMessage(
            'bookingsMessage',
            'success',
            r?.allocation_status === 'recorded' ? 'payments.recorded' : 'payments.recordedReview',
            { zeyd: euros.format((r?.zeyd_cents ?? 0) / 100), mother: euros.format((r?.mother_cents ?? 0) / 100) },
        );
        form.replaceWith(actions);
    });
    return form;
}

// Who created, confirmed, cancelled or moved this booking, when and why (booking_events, staff only)
async function toggleHistory(b, trigger) {
    const item = trigger.closest('.admin-item');
    const existing = item.querySelector('.booking-history');
    if (existing) {
        existing.remove();
        return;
    }
    const box = el('ol', 'booking-history');
    box.append(el('li', 'admin-item-meta', at(state.lang, 'common.loading')));
    item.append(box);
    const { data, error } = await state.supabase
        .from('booking_events')
        .select('action, by_customer, reason_code, details, created_at')
        .eq('booking_id', b.id)
        .order('created_at');
    if (error || !data?.length) {
        box.replaceChildren(
            el(
                'li',
                'admin-item-meta',
                at(state.lang, error ? 'bookings.historyUnavailable' : 'bookings.historyEmpty'),
            ),
        );
        return;
    }
    box.replaceChildren(
        ...data.map((e) => {
            const who = at(state.lang, e.by_customer ? 'history.byCustomer' : 'history.bySalon');
            const line = el(
                'li',
                '',
                `${formatDateOf(e.created_at, state.lang)} ${formatTime(e.created_at)} · ${at(state.lang, `history.${e.action}`)} · ${who}`,
            );
            if (e.reason_code && e.action === 'cancelled')
                line.append(` · ${at(state.lang, `reason.${e.reason_code}`)}`);
            return line;
        }),
    );
}

// --- Home: earnings, today, next appointment, notifications, loyalty to validate, recent activity ---
loaders.home = async () => {
    const sb = state.supabase;
    const today = todayInParis();
    const loading = () => el('li', 'admin-empty', at(state.lang, 'common.loading'));
    $('todayList').replaceChildren(loading());
    $('activityList').replaceChildren(loading());
    $('loyaltyTodoList').replaceChildren(loading());

    const [
        { data: earnings },
        todays,
        { data: nextRows },
        { data: recent, error: recentError },
        { data: visits },
        summary,
    ] = await Promise.all([
        sb.rpc('barber_earnings'),
        fetchBookingsBetween(today, nextDay(today)),
        sb
            .from('bookings')
            .select('starts_at, profiles:customer_id (full_name), services (name_fr, name_ar)')
            .eq('status', 'confirmed')
            .gte('starts_at', new Date().toISOString())
            .order('starts_at')
            .limit(1),
        sb
            .from('bookings')
            .select(
                'id, status, starts_at, created_at, updated_at, cancelled_by, customer_id, profiles:customer_id (full_name)',
            )
            .order('updated_at', { ascending: false })
            .limit(8),
        sb.from('loyalty_visits').select('customer_id').eq('visit_date', today),
        sb.rpc('allocation_summary'),
    ]);

    renderEarnings(earnings, summary.error ? null : summary.data);

    const day = todays.data ?? [];
    const count = (status) => day.filter((b) => b.status === status).length;
    $('kpiConfirmed').textContent = todays.error ? '–' : String(count('confirmed') + count('completed'));
    $('kpiRequested').textContent = todays.error ? '–' : String(count('requested'));
    $('kpiCancelled').textContent = todays.error ? '–' : String(count('cancelled'));

    const next = nextRows?.[0];
    const nextBox = $('nextBooking');
    nextBox.replaceChildren(el('p', 'next-label', at(state.lang, 'home.nextTitle')));
    if (next) {
        const time = el(
            'p',
            'next-time',
            `${formatDateOf(next.starts_at, state.lang)} · ${formatTime(next.starts_at)}`,
        );
        nextBox.append(time, el('p', 'next-who', `${next.profiles?.full_name || '—'} · ${serviceName(next)}`));
    } else {
        nextBox.append(el('p', 'admin-item-meta', at(state.lang, 'home.noNext')));
    }

    const active = day.filter((b) => b.status !== 'cancelled');
    if (todays.error) $('todayList').replaceChildren(el('li', 'admin-empty', at(state.lang, 'common.error')));
    else if (!active.length) $('todayList').replaceChildren(el('li', 'admin-empty', at(state.lang, 'home.todayEmpty')));
    else $('todayList').replaceChildren(...active.map((b) => bookingItem(b, { compact: true })));

    // Past bookings of today whose customer has no loyalty visit yet
    const counted = new Set((visits ?? []).map((v) => v.customer_id));
    const todo = day.filter(
        (b) =>
            ['confirmed', 'completed'].includes(b.status) &&
            new Date(b.starts_at) <= new Date() &&
            !counted.has(b.customer_id),
    );
    $('loyaltyTodoList').replaceChildren(
        ...(todo.length
            ? todo.map((b) => {
                  const item = el('li', 'admin-item');
                  item.append(
                      el('p', '', `${formatTime(b.starts_at)} · ${b.profiles?.full_name || '—'}`),
                      button(at(state.lang, 'home.openLoyalty'), 'btn btn-ghost btn-sm', () => openPanel('loyalty')),
                  );
                  return item;
              })
            : [el('li', 'admin-empty', at(state.lang, 'home.loyaltyTodoEmpty'))]),
    );

    if (recentError || !recent?.length) {
        $('activityList').replaceChildren(
            el('li', 'admin-empty', at(state.lang, recentError ? 'common.error' : 'home.activityEmpty')),
        );
    } else {
        $('activityList').replaceChildren(
            ...recent.map((b) => {
                let key = `activity.${b.status}`;
                if (b.status === 'cancelled')
                    key = cancelledByCustomer(b) ? 'activity.cancelledByCustomer' : 'activity.cancelledBySalon';
                const item = el('li', 'admin-item');
                const body = el('div', 'admin-item-body');
                body.append(
                    el('p', 'admin-item-title', at(state.lang, key, { name: b.profiles?.full_name || '—' })),
                    el(
                        'p',
                        'admin-item-meta',
                        at(state.lang, 'activity.for', {
                            date: formatDateOf(b.starts_at, state.lang),
                            time: formatTime(b.starts_at),
                        }),
                    ),
                );
                item.append(body);
                return item;
            }),
        );
    }

    await renderNotifications();
};

function renderEarnings(earnings, summary) {
    if (summary?.length) {
        const live = summary.find((row) => row.livemode);
        const test = summary.find((row) => !row.livemode);
        $('earningsAmount').textContent = cents(live?.zeyd_cents ?? 0);
        const meta = [at(state.lang, 'home.payments', { count: live?.payments_count ?? 0 })];
        if (test)
            meta.push(at(state.lang, 'home.test', { amount: cents(test.zeyd_cents), count: test.payments_count }));
        $('earningsMeta').textContent = meta.join(' · ');
        return;
    }
    const live = earnings?.find((row) => row.livemode) ?? { payments_count: 0, barber_share_cents: 0 };
    const test = earnings?.find((row) => !row.livemode);
    $('earningsAmount').textContent = euros.format(Number(live.barber_share_cents ?? 0) / 100);
    const meta = [at(state.lang, 'home.payments', { count: live.payments_count ?? 0 })];
    if (test) {
        meta.push(
            at(state.lang, 'home.test', {
                amount: euros.format(Number(test.barber_share_cents) / 100),
                count: test.payments_count,
            }),
        );
    }
    $('earningsMeta').textContent = meta.join(' · ');
}

const NOTIFICATION_COLUMNS = 'id, kind, amount_cents, livemode, created_at, read_at';
// Added by 20261101090000_phase6_cancellations.sql
const NOTIFICATION_COLUMNS_PHASE6 = ', booking_id, data, telegram_status, telegram_error';

async function renderNotifications() {
    const query = (columns) =>
        state.supabase.from('staff_notifications').select(columns).order('created_at', { ascending: false }).limit(20);
    let result = await query(NOTIFICATION_COLUMNS + NOTIFICATION_COLUMNS_PHASE6);
    if (missingColumn(result.error)) result = await query(NOTIFICATION_COLUMNS);
    const notifications = result.data;
    const list = $('notificationList');
    if (result.error) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'common.error')));
        return;
    }
    if (!notifications?.length) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'home.noNotifications')));
        return;
    }
    list.replaceChildren(...notifications.map(notificationItem));
}

function notificationItem(n) {
    const item = el('li', `admin-item notification${n.read_at ? '' : ' is-unread'}`);
    const text = el('div', 'admin-item-body');
    const d = n.data ?? {};
    let title;
    if (n.kind === 'cancellation' || n.kind === 'reschedule') {
        title = el('p', 'admin-item-title', at(state.lang, `notify.${n.kind}`, { name: d.customer_name || '—' }));
        text.append(title);
        if (d.starts_at) {
            text.append(
                el(
                    'p',
                    'admin-item-meta',
                    at(state.lang, 'notify.slot', {
                        date: formatDateOf(d.starts_at, state.lang),
                        time: formatTime(d.starts_at),
                    }),
                ),
            );
        }
        if (n.kind === 'reschedule' && d.new_starts_at) {
            text.append(
                el(
                    'p',
                    'admin-item-meta',
                    at(state.lang, 'notify.newSlot', {
                        date: formatDateOf(d.new_starts_at, state.lang),
                        time: formatTime(d.new_starts_at),
                    }),
                ),
            );
        }
        if (n.kind === 'cancellation') {
            const reason = d.reason_code
                ? at(state.lang, `reason.${d.reason_code}`)
                : at(state.lang, 'notify.noReason');
            text.append(el('p', 'cancel-reason', at(state.lang, 'bookings.reasonLabel', { reason })));
        }
        if (d.details)
            text.append(el('p', 'admin-item-meta', at(state.lang, 'bookings.details', { details: d.details })));
    } else if (n.kind === 'payment_issue') {
        title = el('p', 'admin-item-title', at(state.lang, 'notify.paymentIssue', { amount: cents(n.amount_cents) }));
        text.append(title, el('p', 'cancel-reason', at(state.lang, `paystatus.${d.status ?? 'failed'}`)));
    } else if (n.kind === 'reward') {
        title = el('p', 'admin-item-title', at(state.lang, 'notify.reward', { name: d.customer_name || '—' }));
        text.append(title);
    } else {
        title = el(
            'p',
            'admin-item-title',
            at(state.lang, 'home.paymentReceived', { amount: euros.format((n.amount_cents ?? 0) / 100) }),
        );
        if (!n.livemode) title.append(' ', el('span', 'status-badge is-requested', at(state.lang, 'home.testBadge')));
        text.append(title);
    }
    text.append(el('p', 'admin-item-meta', `${formatDateOf(n.created_at, state.lang)} · ${formatTime(n.created_at)}`));
    if (n.telegram_status) {
        const badge = el(
            'span',
            `status-badge is-telegram-${n.telegram_status}`,
            at(state.lang, `telegram.${n.telegram_status}`),
        );
        if (n.telegram_error) badge.title = n.telegram_error;
        const line = el('p');
        line.append(badge);
        text.append(line);
    }
    item.append(text);
    const actions = el('div', 'admin-row');
    // Pending (function not reached), failed or not configured: Zeyd can ask the server to send it again
    if (['pending', 'failed', 'not_configured'].includes(n.telegram_status)) {
        actions.append(
            button(at(state.lang, 'telegram.retry'), 'btn btn-ghost btn-sm', async (e) => {
                e.currentTarget.disabled = true;
                const { data, error } = await state.supabase.functions.invoke('notify-staff', {
                    body: { notification_id: n.id, retry: true },
                });
                setMessage(
                    'homeMessage',
                    error ? 'error' : 'success',
                    error ? 'telegram.unreachable' : `telegram.result.${data?.status ?? 'nothing_to_send'}`,
                );
                renderNotifications();
            }),
        );
    }
    if (!n.read_at) actions.append(markReadButton(n));
    if (actions.childElementCount) item.append(actions);
    return item;
}

function markReadButton(n) {
    return button(at(state.lang, 'home.markRead'), 'btn btn-ghost btn-sm', async () => {
        await state.supabase.from('staff_notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id);
        renderNotifications();
    });
}

// --- Calendar: one day or one week ---
function initBookings() {
    state.calendarView = 'day';
    $('bookingsDay').value = todayInParis();
    $('bookingsDay').addEventListener('change', () => loaders.bookings());
    for (const b of document.querySelectorAll('[data-view]')) {
        b.addEventListener('click', () => {
            state.calendarView = b.dataset.view;
            loaders.bookings();
        });
    }
    const move = (sign) => () => {
        const step = state.calendarView === 'week' ? 7 : 1;
        $('bookingsDay').value = addDays($('bookingsDay').value || todayInParis(), sign * step);
        loaders.bookings();
    };
    $('calPrev').addEventListener('click', move(-1));
    $('calNext').addEventListener('click', move(1));
    $('calToday').addEventListener('click', () => {
        $('bookingsDay').value = todayInParis();
        loaders.bookings();
    });
    for (const link of document.querySelectorAll('[data-goto]')) {
        link.addEventListener('click', () => openPanel(link.dataset.goto));
    }
}

function cancellationEmail(info, reason) {
    const lang = info.customer_lang === 'ar' ? 'ar' : 'fr';
    const day = formatDateOf(info.starts_at, lang);
    const values = {
        name: info.customer_name || at(lang, 'email.defaultName'),
        day,
        time: formatTime(info.starts_at),
        reason: reason ? at(lang, 'email.reason', { reason }) : '',
    };
    const email = String(info.customer_email ?? '').replace(/[^\w.+@-]/g, '');
    const subject = encodeURIComponent(at(lang, 'email.subject', values));
    const body = encodeURIComponent(at(lang, 'email.body', values));
    return `mailto:${email}?subject=${subject}&body=${body}`;
}

function cancelForm(booking, actions) {
    const form = el('form', 'admin-cancel-form');
    const reason = el('textarea', 'field');
    reason.rows = 2;
    reason.maxLength = 500;
    reason.placeholder = at(state.lang, 'bookings.reasonPlaceholder');
    form.append(
        el('p', 'admin-item-title', at(state.lang, 'bookings.cancelTitle')),
        el('p', 'field-hint', at(state.lang, 'bookings.cancelWarning')),
        labelled(at(state.lang, 'bookings.reason'), reason),
    );
    const row = el('div', 'admin-row');
    const confirm = el('button', 'btn btn-primary btn-sm', at(state.lang, 'bookings.confirmCancel'));
    confirm.type = 'submit';
    row.append(
        confirm,
        button(at(state.lang, 'bookings.keep'), 'btn btn-ghost btn-sm', () => form.replaceWith(actions)),
    );
    form.append(row);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (confirm.disabled) return; // one request per click, even if pressed twice
        confirm.disabled = true;
        const { data, error } = await state.supabase.rpc('staff_cancel_booking', {
            p_booking_id: booking.id,
            p_reason: reason.value.trim() || null,
        });
        if (error) {
            confirm.disabled = false;
            setMessage('bookingsMessage', 'error', errorKey(error));
            return;
        }
        // The database confirmed the cancellation: the slot is free again for everybody
        setMessage('bookingsMessage', 'success', 'bookings.cancelled');
        const info = data?.[0];
        const done = el('div', 'admin-email');
        if (info?.customer_email) {
            const link = el('a', 'btn btn-primary btn-sm');
            link.href = cancellationEmail(info, reason.value.trim());
            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('class', 'icon');
            icon.setAttribute('aria-hidden', 'true');
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', '#i-mail');
            icon.append(use);
            link.append(icon, el('span', '', at(state.lang, 'bookings.emailCustomer')));
            done.append(link, el('p', 'field-hint', at(state.lang, 'bookings.emailHint')));
        }
        form.closest('.admin-item').querySelector('.status-badge').textContent = at(state.lang, 'status.cancelled');
        form.replaceWith(done);
    });
    return form;
}

loaders.bookings = async () => {
    const view = state.calendarView ?? 'day';
    for (const b of document.querySelectorAll('[data-view]'))
        b.setAttribute('aria-pressed', String(b.dataset.view === view));
    const day = $('bookingsDay').value || todayInParis();
    const from = view === 'week' ? weekStart(day) : day;
    const to = addDays(from, view === 'week' ? 7 : 1);
    $('calRange').textContent =
        view === 'week'
            ? at(state.lang, 'bookings.weekRange', {
                  from: formatDateOf(parisLocalToIso(`${from}T12:00`), state.lang),
                  to: formatDateOf(parisLocalToIso(`${addDays(to, -1)}T12:00`), state.lang),
              })
            : formatDateOf(parisLocalToIso(`${day}T12:00`), state.lang);

    const list = $('bookingsList');
    list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'common.loading')));
    const { data, error } = await fetchBookingsBetween(from, to);
    if (error) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'common.error')));
        return;
    }
    if (view === 'day') {
        list.replaceChildren(
            ...(data.length
                ? data.map((b) => bookingItem(b))
                : [el('li', 'admin-empty', at(state.lang, 'bookings.empty'))]),
        );
        return;
    }
    // Week: every day of the week, with its bookings (empty days stay visible)
    const items = [];
    for (let i = 0; i < 7; i += 1) {
        const d = addDays(from, i);
        const ofDay = data.filter(
            (b) => new Intl.DateTimeFormat('en-CA', { timeZone: SALON_TIME_ZONE }).format(new Date(b.starts_at)) === d,
        );
        const active = ofDay.filter((b) => b.status !== 'cancelled').length;
        const head = el('li', `calendar-day${d === todayInParis() ? ' is-today' : ''}`);
        head.append(
            el('span', 'calendar-day-name', formatDateOf(parisLocalToIso(`${d}T12:00`), state.lang)),
            el('span', 'calendar-day-count', at(state.lang, 'bookings.dayCount', { count: active })),
        );
        items.push(head, ...ofDay.map((b) => bookingItem(b)));
    }
    list.replaceChildren(...items);
};

// --- Loyalty: scan a customer's QR code, confirm the visit ---
function initLoyalty() {
    $('scanBtn').addEventListener('click', () => (state.scanStream ? stopScan() : startScan()));
    $('codeForm').addEventListener('submit', (e) => {
        e.preventDefault();
        lookup($('codeInput').value);
    });
    $('loyaltySearchForm').addEventListener('submit', (e) => {
        e.preventDefault();
        searchCustomers($('loyaltySearchInput').value);
    });
}

let jsqrPromise = null;
function loadJsQr() {
    jsqrPromise ??= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = JSQR_URL;
        script.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsqr')));
        script.onerror = () => reject(new Error('jsqr'));
        document.head.append(script);
    });
    return jsqrPromise;
}

async function startScan() {
    setMessage('loyaltyMessage', null);
    try {
        state.scanStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false,
        });
    } catch {
        setMessage('loyaltyMessage', 'error', 'loyalty.cameraError');
        return;
    }
    const video = $('scannerVideo');
    video.srcObject = state.scanStream;
    await video.play();
    $('scanner').hidden = false;
    $('scanBtnText').textContent = at(state.lang, 'loyalty.stopScan');

    // Native detector when the phone has one (Android Chrome), otherwise the small jsQR library
    let detect;
    if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        detect = async () => (await detector.detect(video))[0]?.rawValue ?? null;
    } else {
        let jsQR;
        try {
            jsQR = await loadJsQr();
        } catch {
            stopScan();
            setMessage('loyaltyMessage', 'error', 'loyalty.cameraError');
            return;
        }
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        detect = async () => {
            if (!video.videoWidth) return null;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0);
            const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
            return jsQR(image.data, image.width, image.height)?.data ?? null;
        };
    }
    const tick = async () => {
        if (!state.scanStream) return;
        const value = await detect().catch(() => null);
        if (value) {
            stopScan();
            lookup(value);
            return;
        }
        state.scanTimer = setTimeout(tick, 250);
    };
    tick();
}

function stopScan() {
    clearTimeout(state.scanTimer);
    for (const track of state.scanStream?.getTracks() ?? []) track.stop();
    state.scanStream = null;
    if ($('scanner')) {
        $('scanner').hidden = true;
        $('scanBtnText').textContent = at(state.lang, 'loyalty.scan');
    }
}

async function lookup(rawCode) {
    const code = String(rawCode ?? '').trim();
    if (!code) return;
    state.loyaltyCode = code;
    const { data, error } = await state.supabase.rpc('loyalty_lookup', { p_code: code });
    const result = $('loyaltyResult');
    if (error || !data?.[0]) {
        result.hidden = true;
        setMessage('loyaltyMessage', 'error', errorKey(error ?? { message: 'invalid_code' }));
        return;
    }
    renderCustomerCard(data[0]);
}

// Manual fallback: name, e-mail or code → the customer is chosen from the list, then checked on the card
async function searchCustomers(query) {
    const list = $('loyaltySearchResults');
    list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'common.loading')));
    const { data, error } = await state.supabase.rpc('loyalty_search', { p_query: query });
    if (error) {
        list.replaceChildren();
        setMessage('loyaltyMessage', 'error', errorKey(error));
        return;
    }
    setMessage('loyaltyMessage', null);
    if (!data.length) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'loyalty.noMatch')));
        return;
    }
    list.replaceChildren(
        ...data.map((c) => {
            const item = el('li', 'admin-item');
            const body = el('div', 'admin-item-body');
            body.append(el('p', 'admin-item-title', c.full_name || '—'), el('p', 'admin-item-meta', c.email ?? ''));
            item.append(
                body,
                button(at(state.lang, 'loyalty.open'), 'btn btn-ghost btn-sm', () => {
                    list.replaceChildren();
                    lookup(c.short_code);
                }),
            );
            return item;
        }),
    );
}

function renderCustomerCard(card) {
    const result = $('loyaltyResult');
    const progress =
        card.stamps_total % 10 === 0 && card.stamps_total > 0 && card.available_rewards > 0
            ? 10
            : card.stamps_total % 10;
    const dots = el('ol', 'admin-dots');
    for (let n = 1; n <= 10; n += 1)
        dots.append(el('li', `admin-dot${n <= progress ? ' is-filled' : ''}${n === 10 ? ' is-reward' : ''}`));

    const body = el('div', 'loyalty-result-body');
    // Before confirming, Zeyd checks that the person in front of him is this customer
    body.append(
        el('p', 'field-hint', at(state.lang, 'loyalty.checkIdentity')),
        el('p', 'admin-item-title', card.full_name || '—'),
        el('p', 'admin-item-meta', card.email ?? ''),
        dots,
        el('p', '', at(state.lang, 'loyalty.stamps', { count: progress, total: card.stamps_total })),
        el('p', '', at(state.lang, 'loyalty.rewards', { count: card.available_rewards })),
    );
    if (card.last_visit)
        body.append(el('p', 'admin-item-meta', at(state.lang, 'loyalty.lastVisit', { date: card.last_visit })));
    if (card.visited_today) body.append(el('p', 'field-hint', at(state.lang, 'loyalty.visitedToday')));

    const actions = el('div', 'admin-row');
    const confirm = button(at(state.lang, 'loyalty.confirmVisit'), 'btn btn-primary', async () => {
        confirm.disabled = true;
        const { data, error } = await state.supabase.rpc('loyalty_confirm_visit', { p_code: state.loyaltyCode });
        if (error) setMessage('loyaltyMessage', 'error', errorKey(error));
        else if (data?.[0]?.reward_earned) setMessage('loyaltyMessage', 'success', 'loyalty.rewardEarned');
        else
            setMessage('loyaltyMessage', 'success', 'loyalty.visitConfirmed', {
                count: data?.[0]?.stamps_total % 10 || 10,
            });
        lookup(state.loyaltyCode);
    });
    confirm.disabled = card.visited_today;
    actions.append(confirm);
    if (card.available_rewards > 0) {
        const reward = button(at(state.lang, 'loyalty.useReward'), 'btn btn-reward', async () => {
            reward.disabled = true;
            const { error } = await state.supabase.rpc('loyalty_redeem_reward', { p_code: state.loyaltyCode });
            if (error) setMessage('loyaltyMessage', 'error', errorKey(error));
            else setMessage('loyaltyMessage', 'success', 'loyalty.rewardUsed');
            lookup(state.loyaltyCode);
        });
        reward.disabled = card.visited_today;
        actions.append(reward);
    }
    body.append(actions);
    const history = el('details', 'loyalty-history');
    history.append(el('summary', '', at(state.lang, 'loyalty.history')));
    history.addEventListener('toggle', () => {
        if (history.open && !history.dataset.loaded) loadLoyaltyHistory(history);
    });
    body.append(history);
    result.replaceChildren(body);
    result.hidden = false;
}

async function loadLoyaltyHistory(box) {
    box.dataset.loaded = '1';
    const list = el('ol', 'booking-history');
    list.append(el('li', '', at(state.lang, 'common.loading')));
    box.append(list);
    const { data, error } = await state.supabase.rpc('loyalty_history', { p_code: state.loyaltyCode });
    if (error || !data?.length) {
        list.replaceChildren(
            el('li', '', at(state.lang, error ? 'loyalty.historyUnavailable' : 'loyalty.historyEmpty')),
        );
        return;
    }
    list.replaceChildren(
        ...data.map((h) => {
            const when = `${formatDateOf(h.happened_at, state.lang)} ${formatTime(h.happened_at)}`;
            const what = at(state.lang, `loyalty.event.${h.event}`, { cycle: h.cycle ?? '' });
            const who = h.staff_name ? ` · ${at(state.lang, 'loyalty.by', { name: h.staff_name })}` : '';
            return el('li', '', `${when} · ${what}${who}`);
        }),
    );
}

loaders.loyalty = () => {
    // The scanner starts only on demand (camera permission)
};

// --- Payments: received, allocated, really transferred ---
const cents = (value) => euros.format(Number(value ?? 0) / 100);

loaders.payments = async () => {
    const sb = state.supabase;
    const list = $('paymentsList');
    list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'common.loading')));
    const [summary, records] = await Promise.all([
        sb.rpc('allocation_summary'),
        sb.rpc('payment_records', { p_limit: 100 }),
    ]);
    if (records.error) {
        $('allocationSummary').replaceChildren();
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'payments.unavailable')));
        return;
    }
    $('allocationSummary').replaceChildren(
        ...(summary.data ?? []).map((s) => {
            const box = el('div', `allocation-box${s.livemode ? '' : ' is-test'}`);
            box.append(
                el('p', 'next-label', at(state.lang, s.livemode ? 'payments.real' : 'payments.test')),
                el(
                    'p',
                    '',
                    at(state.lang, 'payments.received', { amount: cents(s.amount_cents), count: s.payments_count }),
                ),
                el('p', '', at(state.lang, 'payments.zeydTotal', { amount: cents(s.zeyd_cents) })),
                el('p', '', at(state.lang, 'payments.motherTotal', { amount: cents(s.mother_cents) })),
                el(
                    'p',
                    'admin-item-title',
                    at(state.lang, 'payments.toTransfer', { amount: cents(s.mother_to_transfer_cents) }),
                ),
            );
            if (s.needs_review_count)
                box.append(
                    el('p', 'cancel-reason', at(state.lang, 'payments.needsReview', { count: s.needs_review_count })),
                );
            return box;
        }),
    );
    if (!records.data.length) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'payments.empty')));
        return;
    }
    list.replaceChildren(...records.data.map(paymentItem));
};

function paymentItem(p) {
    const item = el('li', `admin-item payment-item is-${p.status}`);
    const body = el('div', 'admin-item-body');
    const service = (state.lang === 'ar' && p.service_name_ar) || p.service_name_fr || '';
    const title = el('p', 'admin-item-title', `${cents(p.amount_cents)} · ${p.customer_name || '—'}`);
    if (!p.livemode) title.append(' ', el('span', 'status-badge is-requested', at(state.lang, 'home.testBadge')));
    body.append(title);
    if (p.booking_starts_at) {
        body.append(
            el(
                'p',
                'admin-item-meta',
                `${service} · ${formatDateOf(p.booking_starts_at, state.lang)} ${formatTime(p.booking_starts_at)}`,
            ),
        );
    }
    const when = p.paid_at ?? p.created_at;
    body.append(
        el(
            'p',
            'admin-item-meta',
            `${at(state.lang, `method.${p.method}`)} · ${formatDateOf(when, state.lang)} ${formatTime(when)}${p.reference ? ` · ${p.reference}` : ''}`,
        ),
    );
    const badges = el('p');
    badges.append(el('span', `status-badge is-payment-${p.status}`, at(state.lang, `paystatus.${p.status}`)));
    if (p.allocation_status === 'recorded') {
        badges.append(
            ' ',
            el(
                'span',
                'status-badge',
                at(state.lang, 'payments.split', { zeyd: cents(p.zeyd_cents), mother: cents(p.mother_cents) }),
            ),
        );
        if (p.mother_transfer !== 'not_due') {
            badges.append(
                ' ',
                el(
                    'span',
                    `status-badge is-transfer-${p.mother_transfer}`,
                    at(state.lang, `transfer.${p.mother_transfer}`),
                ),
            );
        }
    } else if (p.allocation_status === 'needs_review') {
        badges.append(' ', el('span', 'status-badge is-payment-mismatch', at(state.lang, 'payments.reviewBadge')));
    }
    body.append(badges);
    item.append(body);
    // Recorded by hand once the 5 € have really been sent to the mother (admin only, also checked by the database)
    if (state.isAdmin && p.mother_transfer === 'to_transfer') {
        item.append(
            button(at(state.lang, 'payments.markTransferred'), 'btn btn-ghost btn-sm', async (e) => {
                const reference = window.prompt(at(state.lang, 'payments.transferPrompt'));
                if (reference === null) return;
                e.currentTarget.disabled = true;
                const { error } = await state.supabase.rpc('staff_mark_mother_transfer', {
                    p_payment_id: p.payment_id,
                    p_reference: reference.trim() || null,
                });
                setMessage(
                    'paymentsMessage',
                    error ? 'error' : 'success',
                    error ? errorKey(error) : 'payments.transferred',
                );
                loaders.payments();
            }),
        );
    }
    return item;
}

// --- Services and prices ---
function initServices() {
    $('addServiceBtn').addEventListener('click', async () => {
        const { data: last } = await state.supabase
            .from('services')
            .select('sort_order')
            .order('sort_order', { ascending: false })
            .limit(1);
        const { error } = await state.supabase.from('services').insert({
            name_fr: at('fr', 'services.newName'),
            name_ar: at('ar', 'services.newName'),
            price: 15,
            duration_minutes: 35,
            is_active: false,
            sort_order: (last?.[0]?.sort_order ?? 0) + 10,
        });
        if (error) setMessage('servicesMessage', 'error', errorKey(error));
        loaders.services();
    });
}

loaders.services = async () => {
    const { data, error } = await state.supabase
        .from('services')
        .select('id, name_fr, name_ar, description_fr, description_ar, price, duration_minutes, is_active')
        .order('sort_order');
    const list = $('servicesList');
    if (error) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'common.error')));
        return;
    }
    list.replaceChildren(
        ...data.map((s) => {
            const item = el('li', 'admin-item admin-service');
            const nameFr = input('text', s.name_fr, { maxlength: '60', required: '' });
            const nameAr = input('text', s.name_ar, { maxlength: '60', dir: 'rtl', required: '' });
            const descFr = el('textarea', 'field');
            descFr.rows = 2;
            descFr.maxLength = 300;
            descFr.value = s.description_fr ?? '';
            const descAr = el('textarea', 'field');
            descAr.rows = 2;
            descAr.maxLength = 300;
            descAr.dir = 'rtl';
            descAr.value = s.description_ar ?? '';
            const price = input('number', s.price, { min: '0', max: '500', step: '0.5', inputmode: 'decimal' });
            const duration = input('number', s.duration_minutes ?? '', {
                min: '5',
                max: '240',
                step: '5',
                inputmode: 'numeric',
            });
            const active = input('checkbox', '');
            active.className = '';
            active.checked = s.is_active;
            const activeLabel = el('label', 'admin-check');
            activeLabel.append(active, ' ', el('span', '', at(state.lang, 'services.active')));
            const save = button(at(state.lang, 'services.save'), 'btn btn-primary btn-sm', async () => {
                const priceValue = Number(price.value);
                const durationValue = duration.value === '' ? null : Number(duration.value);
                if (
                    !nameFr.value.trim() ||
                    !nameAr.value.trim() ||
                    !Number.isFinite(priceValue) ||
                    priceValue < 0 ||
                    priceValue > 500 ||
                    (durationValue !== null &&
                        !(
                            Number.isInteger(durationValue) &&
                            durationValue >= 5 &&
                            durationValue <= 240 &&
                            durationValue % 5 === 0
                        ))
                ) {
                    setMessage('servicesMessage', 'error', 'error.validation');
                    return;
                }
                const { error: err } = await state.supabase
                    .from('services')
                    .update({
                        name_fr: nameFr.value.trim(),
                        name_ar: nameAr.value.trim(),
                        description_fr: descFr.value.trim() || null,
                        description_ar: descAr.value.trim() || null,
                        price: priceValue,
                        duration_minutes: durationValue,
                        is_active: active.checked,
                    })
                    .eq('id', s.id);
                setMessage('servicesMessage', err ? 'error' : 'success', err ? errorKey(err) : 'services.saved');
            });
            const grid = el('div', 'admin-service-grid');
            grid.append(
                labelled(at(state.lang, 'services.name'), nameFr),
                labelled(at(state.lang, 'services.nameAr'), nameAr),
                labelled(at(state.lang, 'services.price'), price),
                labelled(at(state.lang, 'services.duration'), duration),
                labelled(at(state.lang, 'services.descFr'), descFr),
                labelled(at(state.lang, 'services.descAr'), descAr),
            );
            const row = el('div', 'admin-row');
            row.append(activeLabel, save);
            item.append(grid, row);
            return item;
        }),
    );
};

// --- Opening hours and closures ---
function initHours() {
    $('closureForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const from = $('closureFrom').value;
        const to = $('closureTo').value || from;
        if (!from || to < from) {
            setMessage('closuresMessage', 'error', 'error.validation');
            return;
        }
        const { error } = await state.supabase
            .from('closures')
            .insert({ starts_on: from, ends_on: to, reason: $('closureReason').value.trim() || null });
        setMessage('closuresMessage', error ? 'error' : 'success', error ? errorKey(error) : 'hours.saved');
        if (!error) $('closureForm').reset();
        loaders.hours();
    });
}

loaders.hours = async () => {
    const sb = state.supabase;
    const [{ data: hours }, { data: closures }] = await Promise.all([
        sb.from('business_hours').select('id, weekday, opens_at, closes_at').order('weekday').order('opens_at'),
        sb.from('closures').select('id, starts_on, ends_on, reason').gte('ends_on', todayInParis()).order('starts_on'),
    ]);

    const container = $('hoursList');
    const days = [];
    for (let weekday = 1; weekday <= 7; weekday += 1) {
        const day = el('div', 'admin-day');
        day.append(el('p', 'admin-item-title', at(state.lang, `day.${weekday}`)));
        const segments = (hours ?? []).filter((h) => h.weekday === weekday);
        if (!segments.length) day.append(el('p', 'admin-item-meta', at(state.lang, 'hours.closed')));
        for (const h of segments) {
            const opens = input('time', h.opens_at.slice(0, 5), { step: '900' });
            const closes = input('time', h.closes_at.slice(0, 5), { step: '900' });
            const row = el('div', 'admin-row admin-segment');
            row.dir = 'ltr';
            row.append(
                opens,
                el('span', '', '–'),
                closes,
                button(at(state.lang, 'common.save'), 'btn btn-primary btn-sm', async () => {
                    if (!opens.value || !closes.value || opens.value >= closes.value) {
                        setMessage('hoursMessage', 'error', 'error.validation');
                        return;
                    }
                    const { error } = await sb
                        .from('business_hours')
                        .update({ opens_at: opens.value, closes_at: closes.value })
                        .eq('id', h.id);
                    setMessage('hoursMessage', error ? 'error' : 'success', error ? errorKey(error) : 'hours.saved');
                    renderScheduleWarning();
                }),
                button(at(state.lang, 'hours.remove'), 'btn btn-ghost btn-sm', async () => {
                    if (!window.confirm(at(state.lang, 'hours.removeConfirm'))) return;
                    const { error } = await sb.from('business_hours').delete().eq('id', h.id);
                    if (error) setMessage('hoursMessage', 'error', errorKey(error));
                    loaders.hours();
                }),
            );
            day.append(row);
        }
        day.append(
            button(at(state.lang, 'hours.add'), 'btn btn-ghost btn-sm', async () => {
                const used = segments.map((s) => s.opens_at.slice(0, 5));
                const [opensAt, closesAt] = used.includes('09:00') ? ['14:00', '19:00'] : ['09:00', '12:00'];
                const { error } = await sb
                    .from('business_hours')
                    .insert({ weekday, opens_at: opensAt, closes_at: closesAt });
                if (error) setMessage('hoursMessage', 'error', errorKey(error));
                loaders.hours();
            }),
        );
        days.push(day);
    }
    container.replaceChildren(...days);
    renderScheduleWarning();

    const list = $('closuresList');
    if (!closures?.length) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'hours.noClosures')));
        return;
    }
    list.replaceChildren(
        ...closures.map((c) => {
            const item = el('li', 'admin-item');
            const text = el('div');
            const range = el(
                'p',
                'admin-item-title',
                c.starts_on === c.ends_on ? c.starts_on : `${c.starts_on} → ${c.ends_on}`,
            );
            range.dir = 'ltr';
            text.append(range);
            if (c.reason) text.append(el('p', 'admin-item-meta', c.reason));
            item.append(
                text,
                button(at(state.lang, 'hours.remove'), 'btn btn-ghost btn-sm', async () => {
                    if (!window.confirm(at(state.lang, 'hours.removeClosureConfirm'))) return;
                    const { error } = await sb.from('closures').delete().eq('id', c.id);
                    if (error) setMessage('closuresMessage', 'error', errorKey(error));
                    loaders.hours();
                }),
            );
            return item;
        }),
    );
};

// Bookings still on the calendar but outside the new hours or on a closure: Zeyd decides what to do with them
async function renderScheduleWarning() {
    const box = $('scheduleWarning');
    const { data, error } = await state.supabase.rpc('bookings_outside_schedule');
    if (error || !data?.length) {
        box.hidden = true;
        return;
    }
    const list = el('ul', 'admin-list');
    list.append(
        ...data.map((b) => {
            const name = (state.lang === 'ar' && b.service_name_ar) || b.service_name_fr || '';
            return el(
                'li',
                '',
                `${formatDateOf(b.starts_at, state.lang)} ${formatTime(b.starts_at)} · ${b.customer_name || '—'} · ${name}`,
            );
        }),
    );
    box.replaceChildren(
        el('p', 'admin-item-title', at(state.lang, 'hours.outsideTitle', { count: data.length })),
        el('p', 'field-hint', at(state.lang, 'hours.outsideHint')),
        list,
    );
    box.hidden = false;
}

// --- Gallery: photos are resized in the browser before upload (fast pages on phones) ---
const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024;
async function resizeImage(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('upload'))), 'image/jpeg', 0.82),
    );
}

function initGallery() {
    $('galleryForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const file = $('galleryFile').files?.[0];
        if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) {
            setMessage('galleryMessage', 'error', 'error.fileType');
            return;
        }
        if (file.size > MAX_ORIGINAL_BYTES) {
            setMessage('galleryMessage', 'error', 'error.fileTooLarge');
            return;
        }
        const send = e.submitter ?? $('galleryForm').querySelector('[type="submit"]');
        if (send) send.disabled = true;
        setMessage('galleryMessage', 'success', 'gallery.uploading');
        try {
            const blob = await resizeImage(file);
            const path = `${crypto.randomUUID()}.jpg`;
            const storage = state.supabase.storage.from('gallery');
            const { error: uploadError } = await storage.upload(path, blob, {
                contentType: 'image/jpeg',
                upsert: false,
            });
            if (uploadError) throw uploadError;
            const { error } = await state.supabase.from('haircuts').insert({
                image_url: storage.getPublicUrl(path).data.publicUrl,
                title_fr: $('galleryTitleFr').value.trim() || null,
                title_ar: $('galleryTitleAr').value.trim() || null,
                category: $('galleryCategory').value.trim() || null,
                is_published: false,
            });
            if (error) throw error;
            setMessage('galleryMessage', 'success', 'gallery.uploaded');
            $('galleryForm').reset();
            loaders.gallery();
        } catch (error) {
            setMessage('galleryMessage', 'error', error?.message === 'upload' ? 'error.upload' : errorKey(error));
        } finally {
            if (send) send.disabled = false;
        }
    });
}

loaders.gallery = async () => {
    const { data } = await state.supabase
        .from('haircuts')
        .select('id, image_url, title_fr, title_ar, is_published')
        .order('created_at', { ascending: false });
    const list = $('galleryList');
    if (!data?.length) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'gallery.empty')));
        return;
    }
    list.replaceChildren(
        ...data.map((photo) => {
            const item = el('li', 'admin-photo');
            const img = el('img');
            img.src = photo.image_url;
            img.alt = photo.title_fr ?? '';
            img.loading = 'lazy';
            const caption = el('div', 'admin-photo-body');
            const titleFr = input('text', photo.title_fr ?? '', { maxlength: '80' });
            const titleAr = input('text', photo.title_ar ?? '', { maxlength: '80', dir: 'rtl' });
            caption.append(
                labelled(at(state.lang, 'gallery.titleFr'), titleFr),
                labelled(at(state.lang, 'gallery.titleAr'), titleAr),
                button(at(state.lang, 'gallery.saveCaption'), 'btn btn-ghost btn-sm', async () => {
                    const { error } = await state.supabase
                        .from('haircuts')
                        .update({ title_fr: titleFr.value.trim() || null, title_ar: titleAr.value.trim() || null })
                        .eq('id', photo.id);
                    setMessage(
                        'galleryMessage',
                        error ? 'error' : 'success',
                        error ? errorKey(error) : 'gallery.captionSaved',
                    );
                }),
            );
            if (photo.is_published)
                caption.append(el('span', 'status-badge is-confirmed', at(state.lang, 'gallery.published')));
            const row = el('div', 'admin-row');
            row.append(
                button(
                    at(state.lang, photo.is_published ? 'gallery.unpublish' : 'gallery.publish'),
                    'btn btn-primary btn-sm',
                    async () => {
                        await state.supabase
                            .from('haircuts')
                            .update({ is_published: !photo.is_published })
                            .eq('id', photo.id);
                        loaders.gallery();
                    },
                ),
                button(at(state.lang, 'gallery.delete'), 'btn btn-ghost btn-sm', async () => {
                    if (!window.confirm(at(state.lang, 'gallery.deleteConfirm'))) return;
                    await state.supabase.from('haircuts').delete().eq('id', photo.id);
                    const path = photo.image_url.split('/gallery/')[1];
                    if (path) await state.supabase.storage.from('gallery').remove([decodeURIComponent(path)]);
                    loaders.gallery();
                }),
            );
            caption.append(row);
            item.append(img, caption);
            return item;
        }),
    );
};

// --- Customers and roles ---
function initCustomers() {
    $('customerSearch').addEventListener('input', renderCustomers);
}

loaders.customers = async () => {
    const { data } = await state.supabase
        .from('profiles')
        .select('id, full_name, email, role, created_at, loyalty_cards (stamps_total)')
        .order('created_at', { ascending: false });
    state.customers = data ?? [];
    renderCustomers();
};

function renderCustomers() {
    const query = $('customerSearch').value.trim().toLowerCase();
    const list = $('customersList');
    const rows = state.customers.filter(
        (c) => !query || `${c.full_name ?? ''} ${c.email ?? ''}`.toLowerCase().includes(query),
    );
    list.replaceChildren(
        ...rows.map((c) => {
            const item = el('li', 'admin-item');
            const info = el('div', 'admin-item-body');
            const card = Array.isArray(c.loyalty_cards) ? c.loyalty_cards[0] : c.loyalty_cards;
            info.append(
                el('p', 'admin-item-title', c.full_name || '—'),
                el('p', 'admin-item-meta', c.email ?? ''),
                el(
                    'p',
                    'admin-item-meta',
                    `${at(state.lang, 'customers.since', { date: c.created_at.slice(0, 10) })} · ${at(state.lang, 'customers.stamps', { count: card?.stamps_total ?? 0 })}`,
                ),
            );
            const isSelf = c.id === state.user.id;
            const select = el('select', 'field admin-role');
            select.setAttribute('aria-label', at(state.lang, 'customers.role'));
            for (const role of ['customer', 'barber', 'admin']) {
                const option = el('option', '', at(state.lang, `role.${role}`));
                option.value = role;
                option.selected = c.role === role;
                select.append(option);
            }
            // Roles: admins only, never their own (also enforced by set_user_role in the database)
            select.disabled = !state.isAdmin || isSelf;
            select.addEventListener('change', async () => {
                const { error } = await state.supabase.rpc('set_user_role', { p_user_id: c.id, p_role: select.value });
                setMessage(
                    'customersMessage',
                    error ? 'error' : 'success',
                    error ? errorKey(error) : 'customers.roleSaved',
                );
                loaders.customers();
            });
            const side = el('div', 'admin-row');
            if (isSelf) side.append(el('span', 'status-badge is-confirmed', at(state.lang, 'customers.you')));
            side.append(
                select,
                button(at(state.lang, 'customers.details'), 'btn btn-ghost btn-sm', () =>
                    toggleCustomerDetails(c, item),
                ),
            );
            item.append(info, side);
            return item;
        }),
    );
}

// Only what is needed to serve the customer: bookings, visits, loyalty, Zeyd's private note
async function toggleCustomerDetails(c, item) {
    const existing = item.querySelector('.customer-details');
    if (existing) {
        existing.remove();
        return;
    }
    const box = el('div', 'customer-details');
    box.append(el('p', 'admin-item-meta', at(state.lang, 'common.loading')));
    item.append(box);
    const sb = state.supabase;
    const [bookings, rewards, note] = await Promise.all([
        sb
            .from('bookings')
            .select('starts_at, status, services (name_fr, name_ar)')
            .eq('customer_id', c.id)
            .order('starts_at', { ascending: false })
            .limit(15),
        sb.from('loyalty_rewards').select('redeemed_at').eq('customer_id', c.id),
        sb.from('customer_notes').select('note').eq('customer_id', c.id).maybeSingle(),
    ]);
    const card = Array.isArray(c.loyalty_cards) ? c.loyalty_cards[0] : c.loyalty_cards;
    const stamps = card?.stamps_total ?? 0;
    const completed = (bookings.data ?? []).filter((b) => b.status === 'completed').length;
    const available = (rewards.data ?? []).filter((r) => !r.redeemed_at).length;
    box.replaceChildren(
        el('p', '', at(state.lang, 'customers.loyalty', { count: stamps % 10, total: stamps, rewards: available })),
        el('p', '', at(state.lang, 'customers.completed', { count: completed })),
    );
    const history = el('ul', 'booking-history');
    const rows = bookings.data ?? [];
    history.append(
        ...(rows.length
            ? rows.map((b) => {
                  const name = (state.lang === 'ar' && b.services?.name_ar) || b.services?.name_fr || '';
                  return el(
                      'li',
                      '',
                      `${formatDateOf(b.starts_at, state.lang)} ${formatTime(b.starts_at)} · ${name} · ${at(state.lang, `status.${b.status}`)}`,
                  );
              })
            : [el('li', '', at(state.lang, 'customers.noBookings'))]),
    );
    box.append(history);

    // Private note: only if the notes table exists (migration of stage D)
    if (!note.error) {
        const text = el('textarea', 'field');
        text.rows = 2;
        text.maxLength = 1000;
        text.value = note.data?.note ?? '';
        box.append(
            labelled(at(state.lang, 'customers.note'), text),
            button(at(state.lang, 'customers.saveNote'), 'btn btn-ghost btn-sm', async () => {
                const value = text.value.trim();
                const { error } = value
                    ? await sb.from('customer_notes').upsert({ customer_id: c.id, note: value })
                    : await sb.from('customer_notes').delete().eq('customer_id', c.id);
                setMessage(
                    'customersMessage',
                    error ? 'error' : 'success',
                    error ? errorKey(error) : 'customers.noteSaved',
                );
            }),
        );
    }
}

// --- Settings (admin only, enforced by RLS) ---
const settingFields = [
    ['setSlotStep', 'slot_step_minutes'],
    ['setMinNotice', 'min_notice_minutes'],
    ['setMaxDays', 'max_days_ahead'],
    ['setCancelNotice', 'cancel_notice_minutes'],
    ['setMaxActive', 'max_active_bookings'],
    ['setMinGap', 'min_gap_minutes'],
];

function initSettings() {
    $('settingsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const booking = { booking_enabled: $('setBookingEnabled').checked };
        for (const [id, column] of settingFields) {
            const value = Number($(id).value);
            if (!Number.isInteger(value) || value < 0) {
                setMessage('settingsMessage', 'error', 'error.validation');
                return;
            }
            booking[column] = value;
        }
        const share = Number($('setHashemShare').value);
        if (!Number.isInteger(share) || share < 0) {
            setMessage('settingsMessage', 'error', 'error.validation');
            return;
        }
        const sb = state.supabase;
        const [b, p] = await Promise.all([
            sb.from('booking_settings').update(booking).eq('id', true).select('id'),
            sb
                .from('payment_settings')
                .update({ online_payments_enabled: $('setPaymentsEnabled').checked, hashem_share_cents: share })
                .eq('id', true)
                .select('id'),
        ]);
        const error = b.error ?? p.error ?? (!b.data?.length || !p.data?.length ? { message: 'forbidden' } : null);
        setMessage('settingsMessage', error ? 'error' : 'success', error ? errorKey(error) : 'settings.saved');
    });
}

loaders.settings = async () => {
    const sb = state.supabase;
    const [{ data: booking }, { data: payment }] = await Promise.all([
        sb.from('booking_settings').select('*').maybeSingle(),
        sb.from('payment_settings').select('*').maybeSingle(),
    ]);
    if (booking) {
        $('setBookingEnabled').checked = booking.booking_enabled ?? true;
        for (const [id, column] of settingFields) $(id).value = booking[column] ?? '';
    }
    if (payment) {
        $('setPaymentsEnabled').checked = payment.online_payments_enabled;
        $('setHashemShare').value = payment.hashem_share_cents;
    }
    $('settingsAdminOnly').hidden = state.isAdmin;
    for (const control of $('settingsForm').querySelectorAll('input, button')) control.disabled = !state.isAdmin;
};

init();

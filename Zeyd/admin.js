// Barber / admin dashboard. Every action is checked by the database (RLS policies and functions
// that verify the role): this page only shows what the signed-in account is allowed to do.
import { at } from './admin-i18n.js';
import { cameraErrorKey, cameraUnavailable } from './camera.js';
import { confirmDialog } from './confirmDialog.js';
import { createHoldButton } from './holdButton.js';
import { detectLanguage, deviceLanguage } from './i18n.js';
import { renderLoyaltyCard } from './loyalty.js';
import { groupThreads } from './messageThreads.js';
import { confirmPasswordChange, sendPasswordCode } from './passwordChange.js';
import { initInstall } from './pwa.js';
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
function gate(key, withForm = false) {
    $('gateText').textContent = at(state.lang, key);
    $('gateText').dataset.i18n = key;
    $('gateForm').hidden = !withForm;
    $('gateAccount').hidden = true;
    $('gateSwitch').hidden = true;
}

// Signed in, but the database says this account is not staff (role « customer »): show which account it is,
// since a typo in the e-mail (a missing dot…) is the usual reason, and offer to sign in with another one.
function gateForbidden(supabase, email) {
    gate('gate.forbidden');
    $('gateAccount').textContent = at(state.lang, 'gate.account', { email: email ?? '—' });
    $('gateAccount').hidden = false;
    $('gateSwitch').hidden = false;
    $('gateSwitch').onclick = async () => {
        await supabase.auth.signOut();
        gate('gate.signIn', true);
    };
}

// Sign-in form shown by the gate: the session is stored per address (127.0.0.1 and 192.168.x.x are two
// separate sessions), so Zeyd signs in here and the dashboard opens without going through the site.
function initGateForm(supabase) {
    const form = $('gateForm');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const email = $('gateEmail').value.trim();
        const password = $('gatePassword').value;
        if (!email || !password) return setMessage('gateMessage', 'error', 'gate.missing');
        $('gateSubmit').disabled = true;
        setMessage('gateMessage', null);
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        $('gateSubmit').disabled = false;
        if (error) {
            const key = `gate.error.${error.code ?? ''}`;
            if (at(state.lang, key) !== key) return setMessage('gateMessage', 'error', key);
            // Unknown cause: show what Supabase answered (code, HTTP status), never the password
            const detail = [error.code ?? error.name, error.status, error.message].filter(Boolean).join(' · ');
            return setMessage('gateMessage', 'error', 'gate.error.other', { detail });
        }
        $('gatePassword').value = '';
        openDashboard(supabase, data.session);
    });
}

async function init() {
    applyLanguage(detectLanguage(readPref('lang'), deviceLanguage()));
    initTheme();
    initInstall({ translate: (key) => at(state.lang, key) });
    for (const b of document.querySelectorAll('[data-lang]')) {
        b.addEventListener('click', () => {
            applyLanguage(b.dataset.lang);
            writePref('lang', b.dataset.lang);
        });
    }

    const supabase = await getSupabase();
    if (!supabase) return gate('gate.offline');
    state.supabase = supabase;
    initGateForm(supabase);
    const {
        data: { session },
    } = await supabase.auth.getSession();
    if (!session) return gate('gate.signIn', true);
    openDashboard(supabase, session);
}

// Same check after a stored session or a sign-in on this page: the role comes from the database only
async function openDashboard(supabase, session) {
    gate('gate.loading');
    state.user = session.user;
    const [{ data: staff, error }, { data: admin }] = await Promise.all([
        supabase.rpc('is_staff'),
        supabase.rpc('is_admin'),
    ]);
    if (error) {
        state.user = null;
        return gate('gate.unreachable');
    }
    if (!staff) {
        state.user = null;
        return gateForbidden(supabase, session.user?.email);
    }
    state.isAdmin = Boolean(admin);

    $('adminGate').hidden = true;
    $('adminTabs').hidden = false;
    $('adminSignOut').hidden = false;
    $('adminSignOut').addEventListener('click', async () => {
        // Signing out only ends the session on this device: bookings are not touched
        const confirmed = await confirmDialog({
            message: at(state.lang, 'header.signOutConfirm'),
            ok: at(state.lang, 'common.ok'),
            cancel: at(state.lang, 'common.cancel'),
        });
        if (!confirmed) return;
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
    // Red dot on « Messages » while a customer message is unread
    refreshMessagesDot();
    setInterval(() => {
        if (!document.hidden) refreshMessagesDot();
    }, 60_000);
    initPasswordChange();
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

// Status shown with an icon AND a word, never by colour alone
const STATUS_ICON = { confirmed: '✓', requested: '…', completed: '✔', cancelled: '✕', no_show: '!' };

function statusBadge(status) {
    const badge = el('span', `status-badge is-${status}`);
    badge.append(el('span', 'status-icon', STATUS_ICON[status] ?? '•'), at(state.lang, `status.${status}`));
    badge.firstChild.setAttribute('aria-hidden', 'true');
    return badge;
}

// Calendar card: the essentials, and a button that opens the details panel
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
        const facts = bookingFacts(b);
        if (facts) info.append(el('p', 'admin-item-meta', facts));
    }
    const badges = el('p', 'badge-row');
    badges.append(statusBadge(b.status));
    if (state.paidBookings?.has(b.id))
        badges.append(el('span', 'status-badge is-payment-paid', at(state.lang, 'paystatus.paid')));
    if (b.is_custom_request) badges.append(el('span', 'status-badge is-requested', at(state.lang, 'bookings.custom')));
    if (b.rescheduled_from) badges.append(el('span', 'status-badge', at(state.lang, 'bookings.rescheduled')));
    info.append(badges);
    if (b.customer_note) info.append(noteBlock(b.customer_note, true));
    if (b.status === 'cancelled') info.append(cancellationInfo(b));
    item.append(
        info,
        button(at(state.lang, 'bookings.open'), 'btn btn-ghost btn-sm', () => openBookingSheet(b)),
    );
    return item;
}

function bookingFacts(b) {
    const facts = [];
    if (b.services?.price != null) facts.push(euros.format(Number(b.services.price)));
    if (b.ends_at) {
        facts.push(
            at(state.lang, 'bookings.minutes', {
                count: Math.round((new Date(b.ends_at) - new Date(b.starts_at)) / 60000),
            }),
        );
    }
    return facts.join(' · ');
}

// The customer's own words (written when booking): shown as typed, never interpreted as HTML
function noteBlock(note, short = false) {
    const box = el('blockquote', `customer-note${short ? ' is-short' : ''}`);
    // In the list the block carries its own label; in the details panel the section title says it
    if (short) box.append(el('span', 'customer-note-label', at(state.lang, 'bookings.noteLabel')));
    const text = el('span', 'customer-note-text', note);
    text.dir = 'auto'; // an Arabic message reads right to left even on the French dashboard
    box.append(text);
    return box;
}

// --- Details panel (side sheet on a computer, bottom sheet on a phone); the calendar stays where it was ---
function openBookingSheet(b) {
    state.sheetBooking = b;
    const sheet = $('bookingSheet');
    renderBookingSheet(b);
    if (!sheet.open) sheet.showModal();
}

function closeBookingSheet() {
    const sheet = $('bookingSheet');
    if (sheet.open) sheet.close();
}

function sheetSection(titleKey, ...children) {
    const section = el('section', 'sheet-section');
    section.append(el('h3', 'sheet-section-title', at(state.lang, titleKey)), ...children);
    return section;
}

function renderBookingSheet(b) {
    const body = $('bookingSheetBody');
    setMessage('sheetMessage', null);
    $('bookingSheetTitle').textContent = `${formatDateOf(b.starts_at, state.lang)} · ${formatTime(b.starts_at)}`;
    const badges = el('p', 'badge-row');
    badges.append(statusBadge(b.status));
    if (b.is_custom_request) badges.append(el('span', 'status-badge is-requested', at(state.lang, 'bookings.custom')));
    if (b.rescheduled_from) badges.append(el('span', 'status-badge', at(state.lang, 'bookings.rescheduled')));

    const customer = [el('p', 'admin-item-title', b.profiles?.full_name || '—')];
    if (b.profiles?.email) {
        const mail = el('a', 'admin-item-meta', b.profiles.email);
        mail.href = `mailto:${String(b.profiles.email).replace(/[^\w.+@-]/g, '')}`;
        mail.dir = 'ltr';
        customer.push(mail);
    }
    const payment = el('p', 'admin-item-meta', at(state.lang, 'common.loading'));
    const history = el('ol', 'booking-history');
    const sections = [
        badges,
        sheetSection('sheet.customer', ...customer),
        sheetSection('sheet.service', el('p', '', serviceName(b)), el('p', 'admin-item-meta', bookingFacts(b))),
        sheetSection('sheet.payment', payment),
    ];
    sections.push(
        b.customer_note
            ? sheetSection('bookings.noteLabel', noteBlock(b.customer_note))
            : sheetSection('bookings.noteLabel', el('p', 'admin-item-meta', at(state.lang, 'sheet.noNote'))),
    );
    if (b.status === 'cancelled') sections.push(sheetSection('sheet.cancellation', cancellationInfo(b)));
    sections.push(sheetSection('sheet.actions', bookingActions(b)), sheetSection('bookings.history', history));
    body.replaceChildren(...sections);
    loadSheetPayment(b, payment);
    loadHistory(b, history);
}

// Payment state from the payments table (only "paid" counts as paid)
async function loadSheetPayment(b, target) {
    const { data, error } = await state.supabase
        .from('payments')
        .select('status, amount_cents, paid_at')
        .eq('booking_id', b.id)
        .order('created_at', { ascending: false });
    if (error) {
        target.textContent = at(state.lang, 'common.error');
        return;
    }
    const paid = data.find((p) => p.status === 'paid');
    target.textContent = paid
        ? at(state.lang, 'sheet.paidOn', {
              amount: cents(paid.amount_cents),
              date: formatDateOf(paid.paid_at, state.lang),
              time: formatTime(paid.paid_at),
          })
        : at(state.lang, data.length ? 'sheet.notPaidAttempts' : 'sheet.notPaid', { count: data.length });
}

// After an action: the database answered, so the calendar and the panel show the new state
async function refreshAfterAction() {
    await loaders.bookings();
    const current = state.sheetBooking && state.calendarRows?.find((r) => r.id === state.sheetBooking.id);
    if (current && $('bookingSheet').open) {
        state.sheetBooking = current;
        renderBookingSheet(current);
    }
}

function bookingActions(b) {
    const actions = el('div', 'admin-row admin-actions');
    const setStatus = (status) => async (e) => {
        e.currentTarget.disabled = true; // one request per tap
        const { error } = await state.supabase.rpc('set_booking_status', { p_booking_id: b.id, p_status: status });
        if (error) {
            e.currentTarget.disabled = false;
            setMessage('sheetMessage', 'error', errorKey(error));
            return;
        }
        await refreshAfterAction();
        setMessage('sheetMessage', 'success', 'bookings.statusSaved');
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
    if (!actions.childElementCount) actions.append(el('p', 'admin-item-meta', at(state.lang, 'sheet.noAction')));
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
    method.addEventListener('change', () => {
        hint.textContent = at(
            state.lang,
            method.value === 'bank_transfer' ? 'payments.transferHint' : 'payments.recordHint',
        );
    });
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
        const value = Math.round(Number(amount.value) * 100);
        if (!Number.isInteger(value) || value <= 0) {
            setMessage('sheetMessage', 'error', 'error.validation');
            return;
        }
        confirm.disabled = true;
        const { error } = await state.supabase.rpc('staff_record_payment', {
            p_booking_id: b.id,
            p_amount_cents: value,
            p_method: method.value,
            p_reference: reference.value.trim() || null,
        });
        if (error) {
            // The form keeps what was typed, so nothing has to be entered again
            confirm.disabled = false;
            setMessage('sheetMessage', 'error', errorKey(error));
            return;
        }
        await refreshAfterAction();
        setMessage('sheetMessage', 'success', 'payments.recorded');
    });
    return form;
}

// Who created, confirmed, cancelled or moved this booking, when and why (booking_events, staff only)
async function loadHistory(b, box) {
    box.replaceChildren(el('li', 'admin-item-meta', at(state.lang, 'common.loading')));
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

    const [todays, { data: nextRows }, { data: recent, error: recentError }, { data: visits }, summary] =
        await Promise.all([
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

    renderEarnings(summary.error ? null : summary.data);

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
    renderOverview();
};

// Start of the chosen period, as an ISO date-time (Paris calendar)
function periodStart(period) {
    const today = todayInParis();
    if (period === 'month') return parisLocalToIso(`${today.slice(0, 8)}01T00:00`);
    return parisLocalToIso(`${addDays(today, -(Number(period) - 1))}T00:00`);
}

async function renderOverview() {
    const sb = state.supabase;
    const grid = $('statsGrid');
    const period = $('statsPeriod').value;
    const since = periodStart(period);
    const now = new Date();
    const in7 = new Date(now.getTime() + 7 * 864e5).toISOString();
    grid.replaceChildren(el('p', 'admin-item-meta', at(state.lang, 'common.loading')));
    const count = (query) => query.then((r) => (r.error ? null : r.count));
    const head = (table) => sb.from(table).select('*', { count: 'exact', head: true });

    const [upcoming, completed, cancelled, customers, rewards, records] = await Promise.all([
        count(
            head('bookings')
                .in('status', ['confirmed', 'requested'])
                .gte('starts_at', now.toISOString())
                .lt('starts_at', in7),
        ),
        count(head('bookings').eq('status', 'completed').gte('starts_at', since)),
        count(head('bookings').eq('status', 'cancelled').gte('cancelled_at', since)),
        count(head('profiles').eq('role', 'customer').gte('created_at', since)),
        count(head('loyalty_rewards').is('redeemed_at', null)),
        sb.rpc('payment_records', { p_limit: 500 }),
    ]);

    // Money: payments the database marked "paid" in the period, and the ones with a problem
    let money = null;
    if (!records.error) {
        const inPeriod = records.data.filter((p) => (p.paid_at ?? p.created_at) >= since);
        const paid = inPeriod.filter((p) => p.status === 'paid');
        money = {
            received: paid.reduce((s, p) => s + p.amount_cents, 0),
            review: inPeriod.filter((p) => ['mismatch', 'duplicate'].includes(p.status)).length,
            test: paid.some((p) => !p.livemode),
        };
    }
    const periodLabel = at(state.lang, period === 'month' ? 'stats.thisMonth' : `stats.last${period}`);
    const stat = (value, labelKey, caption, tone = '') => {
        const box = el('div', `stat${tone ? ` is-${tone}` : ''}`);
        const number = el('p', 'stat-value', value ?? '—');
        number.dir = 'ltr';
        box.append(number, el('p', 'stat-label', at(state.lang, labelKey)), el('p', 'stat-caption', caption));
        if (value === null || value === undefined) box.classList.add('is-unavailable');
        return box;
    };
    const fmt = (n) => (n === null || n === undefined ? null : String(n));
    grid.replaceChildren(
        stat(fmt(upcoming), 'stats.upcoming', at(state.lang, 'stats.next7')),
        stat(fmt(completed), 'stats.completed', periodLabel),
        stat(fmt(cancelled), 'stats.cancelled', periodLabel, cancelled ? 'warn' : ''),
        stat(fmt(customers), 'stats.newCustomers', periodLabel),
        stat(money ? cents(money.received) : null, 'stats.received', periodLabel),
        stat(money ? fmt(money.review) : null, 'stats.review', periodLabel, money?.review ? 'warn' : ''),
        stat(fmt(rewards), 'stats.rewards', at(state.lang, 'stats.now')),
    );
    const notes = [at(state.lang, 'stats.noteSource')];
    if (money?.test) notes.push(at(state.lang, 'stats.noteTest'));
    if (!money) notes.push(at(state.lang, 'stats.noteMoneyUnavailable'));
    $('statsNote').textContent = notes.join(' ');
}

// Total of the payments the database marked "paid" (online and recorded at the salon)
function renderEarnings(summary) {
    const live = summary?.find((row) => row.livemode);
    const test = summary?.find((row) => !row.livemode);
    $('earningsAmount').textContent = cents(live?.amount_cents ?? 0);
    const meta = [at(state.lang, 'home.payments', { count: live?.payments_count ?? 0 })];
    if (test) meta.push(at(state.lang, 'home.test', { amount: cents(test.amount_cents), count: test.payments_count }));
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
        const current = $('bookingsDay').value || todayInParis();
        if (state.calendarView === 'month') {
            const d = new Date(`${current.slice(0, 7)}-01T12:00:00Z`);
            d.setUTCMonth(d.getUTCMonth() + sign);
            $('bookingsDay').value = d.toISOString().slice(0, 10);
        } else {
            $('bookingsDay').value = addDays(current, sign * (state.calendarView === 'week' ? 7 : 1));
        }
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
    $('statsPeriod').addEventListener('change', renderOverview);
    // Details panel: close button, Escape (native), or a tap outside it
    const sheet = $('bookingSheet');
    $('bookingSheetClose').addEventListener('click', closeBookingSheet);
    sheet.addEventListener('click', (e) => {
        if (e.target === sheet) closeBookingSheet();
    });
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
    // Hold for 1.2 s to cancel: a quick tap never cancels an appointment by mistake
    const hold = createHoldButton({
        label: at(state.lang, 'bookings.holdCancel'),
        holdingLabel: at(state.lang, 'bookings.holding'),
        busyLabel: at(state.lang, 'bookings.cancelling'),
        hint: at(state.lang, 'bookings.holdHint'),
        className: 'btn btn-danger btn-sm',
        duration: 1200,
        onConfirm: async () => {
            const { data, error } = await state.supabase.rpc('staff_cancel_booking', {
                p_booking_id: booking.id,
                p_reason: reason.value.trim() || null,
            });
            if (error) {
                setMessage('sheetMessage', 'error', errorKey(error));
                return false;
            }
            // The database confirmed the cancellation: the slot is free again for everybody
            const info = data?.[0];
            await refreshAfterAction();
            setMessage('sheetMessage', 'success', 'bookings.cancelled');
            if (info?.customer_email) {
                const done = el('div', 'admin-email');
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
                $('bookingSheetBody').prepend(done);
            }
            return true;
        },
    });
    const row = el('div', 'admin-row');
    row.append(
        hold,
        button(at(state.lang, 'bookings.keep'), 'btn btn-ghost btn-sm', () => form.replaceWith(actions)),
    );
    form.append(row, el('p', 'hold-hint', at(state.lang, 'bookings.holdHint')));
    form.addEventListener('submit', (e) => e.preventDefault());
    return form;
}

const CALENDAR_FILTERS = ['all', 'confirmed', 'requested', 'completed', 'cancelled', 'no_show'];
const parisDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: SALON_TIME_ZONE }).format(new Date(iso));

function calendarRange(view, day) {
    if (view === 'week') {
        const from = weekStart(day);
        return { from, to: addDays(from, 7) };
    }
    if (view === 'month') {
        const first = `${day.slice(0, 7)}-01`;
        const next = new Date(`${first}T12:00:00Z`);
        next.setUTCMonth(next.getUTCMonth() + 1);
        return { from: first, to: next.toISOString().slice(0, 10) };
    }
    return { from: day, to: addDays(day, 1) };
}

function renderFilters() {
    const box = $('calFilters');
    const current = state.calendarFilter ?? 'all';
    box.replaceChildren(
        ...CALENDAR_FILTERS.map((f) => {
            const chip = button(at(state.lang, `filter.${f}`), 'filter-chip', () => {
                state.calendarFilter = f;
                loaders.bookings();
            });
            chip.setAttribute('aria-pressed', String(f === current));
            return chip;
        }),
    );
}

loaders.bookings = async () => {
    const view = state.calendarView ?? 'day';
    for (const b of document.querySelectorAll('[data-view]'))
        b.setAttribute('aria-pressed', String(b.dataset.view === view));
    renderFilters();
    const day = $('bookingsDay').value || todayInParis();
    const { from, to } = calendarRange(view, day);
    const dateLabel = (d) => formatDateOf(parisLocalToIso(`${d}T12:00`), state.lang);
    $('calRange').textContent =
        view === 'week'
            ? at(state.lang, 'bookings.weekRange', { from: dateLabel(from), to: dateLabel(addDays(to, -1)) })
            : view === 'month'
              ? new Intl.DateTimeFormat(state.lang === 'ar' ? 'ar-u-nu-latn' : 'fr-FR', {
                    timeZone: SALON_TIME_ZONE,
                    month: 'long',
                    year: 'numeric',
                }).format(new Date(`${from}T12:00:00Z`))
              : dateLabel(day);

    const list = $('bookingsList');
    list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'common.loading')));
    const { data, error } = await fetchBookingsBetween(from, to);
    if (error) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'common.error')));
        return;
    }
    state.calendarRows = data;
    // Paid bookings (badge): only payments the database marked "paid"
    const ids = data.map((b) => b.id);
    const { data: paid } = ids.length
        ? await state.supabase.from('payments').select('booking_id').eq('status', 'paid').in('booking_id', ids)
        : { data: [] };
    state.paidBookings = new Set((paid ?? []).map((p) => p.booking_id));

    const filter = state.calendarFilter ?? 'all';
    const rows = filter === 'all' ? data : data.filter((b) => b.status === filter);
    list.classList.toggle('is-month', view === 'month');

    if (view === 'month') {
        list.replaceChildren(...monthGrid(from, to, rows));
        return;
    }
    if (view === 'day') {
        list.replaceChildren(
            ...(rows.length
                ? rows.map((b) => bookingItem(b))
                : [el('li', 'admin-empty', at(state.lang, 'bookings.empty'))]),
        );
        return;
    }
    // Week: every day of the week, with its bookings (empty days stay visible)
    const items = [];
    for (let i = 0; i < 7; i += 1) {
        const d = addDays(from, i);
        const ofDay = rows.filter((b) => parisDay(b.starts_at) === d);
        const active = ofDay.filter((b) => b.status !== 'cancelled').length;
        const head = el('li', `calendar-day${d === todayInParis() ? ' is-today' : ''}`);
        head.append(
            el('span', 'calendar-day-name', dateLabel(d)),
            el('span', 'calendar-day-count', at(state.lang, 'bookings.dayCount', { count: active })),
        );
        items.push(head, ...ofDay.map((b) => bookingItem(b)));
    }
    list.replaceChildren(...items);
};

// Month: a grid of days (Monday first); a day opens its day view
function monthGrid(from, to, rows) {
    const cells = [];
    const weekdayFmt = new Intl.DateTimeFormat(state.lang === 'ar' ? 'ar' : 'fr-FR', {
        weekday: 'short',
        timeZone: 'UTC',
    });
    for (let i = 0; i < 7; i += 1) {
        cells.push(el('li', 'month-head', weekdayFmt.format(new Date(Date.UTC(2026, 10, 2 + i)))));
    }
    const lead = (new Date(`${from}T12:00:00Z`).getUTCDay() + 6) % 7;
    for (let i = 0; i < lead; i += 1) cells.push(el('li', 'month-cell is-empty'));
    for (let d = from; d < to; d = addDays(d, 1)) {
        const ofDay = rows.filter((b) => parisDay(b.starts_at) === d);
        const active = ofDay.filter((b) => b.status !== 'cancelled').length;
        const cancelled = ofDay.length - active;
        const cell = el('li', `month-cell${d === todayInParis() ? ' is-today' : ''}`);
        const open = button('', 'month-day', () => {
            $('bookingsDay').value = d;
            state.calendarView = 'day';
            loaders.bookings();
        });
        open.append(el('span', 'month-num', String(Number(d.slice(8)))));
        if (active) open.append(el('span', 'month-count', String(active)));
        if (cancelled) open.append(el('span', 'month-cancelled', `✕${cancelled}`));
        open.setAttribute(
            'aria-label',
            `${formatDateOf(parisLocalToIso(`${d}T12:00`), state.lang)} · ${at(state.lang, 'bookings.dayCount', { count: active })}`,
        );
        cell.append(open);
        cells.push(cell);
    }
    return cells;
}

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
    // The camera is released as soon as the page is hidden or left
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopScan();
    });
    window.addEventListener('pagehide', stopScan);
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
    const unavailable = cameraUnavailable({
        isSecureContext: window.isSecureContext,
        mediaDevices: navigator.mediaDevices,
    });
    if (unavailable) {
        setMessage('loyaltyMessage', 'error', unavailable);
        return;
    }
    try {
        // Back camera when the phone has one; any camera otherwise
        state.scanStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } },
            audio: false,
        });
    } catch (error) {
        setMessage('loyaltyMessage', 'error', cameraErrorKey(error));
        return;
    }
    const video = $('scannerVideo');
    video.srcObject = state.scanStream;
    try {
        await video.play();
    } catch {
        stopScan();
        setMessage('loyaltyMessage', 'error', 'loyalty.cameraError');
        return;
    }
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
    // The same card the customer sees on the site (10 circles, copper 10th with the gift)
    const dots = el('div', 'admin-loyalty-card');
    renderLoyaltyCard(dots, card, state.lang);

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
        // 50 hours between two stamps: the database gives the time of the next possible stamp in the hint
        if (error?.message === 'cooldown_active' && error.hint)
            setMessage('loyaltyMessage', 'error', 'error.cooldown_active', {
                date: formatDateOf(error.hint, state.lang),
                time: formatTime(error.hint),
            });
        else if (error) setMessage('loyaltyMessage', 'error', errorKey(error));
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

// --- Payments received (online and at the salon) ---
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
                    'admin-item-title',
                    at(state.lang, 'payments.received', { amount: cents(s.amount_cents), count: s.payments_count }),
                ),
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
    body.append(badges);
    item.append(body);
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
    // What a change touches: the upcoming bookings of each service
    const { data: upcoming } = await state.supabase
        .from('bookings')
        .select('service_id')
        .in('status', ['confirmed', 'requested'])
        .gte('starts_at', new Date().toISOString());
    const upcomingBy = {};
    for (const b of upcoming ?? []) upcomingBy[b.service_id] = (upcomingBy[b.service_id] ?? 0) + 1;
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
            const impact = el(
                'p',
                'field-hint',
                at(state.lang, upcomingBy[s.id] ? 'services.impact' : 'services.noImpact', {
                    count: upcomingBy[s.id] ?? 0,
                }),
            );
            item.append(grid, impact, row);
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
    $('galleryFile').addEventListener('change', () => {
        const file = $('galleryFile').files?.[0];
        const preview = $('galleryPreview');
        if (preview.dataset.url) URL.revokeObjectURL(preview.dataset.url);
        if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) {
            preview.hidden = true;
            return;
        }
        preview.dataset.url = URL.createObjectURL(file);
        preview.src = preview.dataset.url;
        preview.hidden = false;
    });
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
        .select('id, image_url, title_fr, title_ar, is_published, sort_order')
        .order('sort_order')
        .order('created_at', { ascending: false });
    const list = $('galleryList');
    if (!data?.length) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'gallery.empty')));
        return;
    }
    // Swap the position of two photos (order shown on the site)
    const move = async (index, delta) => {
        const other = data[index + delta];
        if (!other) return;
        const ordered = data.map((p, i) => ({ id: p.id, sort_order: i * 10 }));
        [ordered[index].sort_order, ordered[index + delta].sort_order] = [
            ordered[index + delta].sort_order,
            ordered[index].sort_order,
        ];
        const results = await Promise.all(
            [ordered[index], ordered[index + delta]].map((p) =>
                state.supabase.from('haircuts').update({ sort_order: p.sort_order }).eq('id', p.id),
            ),
        );
        const failed = results.find((r) => r.error);
        if (failed) setMessage('galleryMessage', 'error', errorKey(failed.error));
        loaders.gallery();
    };
    list.replaceChildren(
        ...data.map((photo, index) => {
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
                        const { error } = await state.supabase
                            .from('haircuts')
                            .update({ is_published: !photo.is_published })
                            .eq('id', photo.id);
                        if (error) setMessage('galleryMessage', 'error', errorKey(error));
                        loaders.gallery();
                    },
                ),
                button(at(state.lang, 'gallery.delete'), 'btn btn-ghost btn-sm', async () => {
                    if (!window.confirm(at(state.lang, 'gallery.deleteConfirm'))) return;
                    const { error } = await state.supabase.from('haircuts').delete().eq('id', photo.id);
                    if (error) {
                        setMessage('galleryMessage', 'error', errorKey(error));
                        return;
                    }
                    // The file is removed only once the database row is gone
                    const path = photo.image_url.split('/gallery/')[1];
                    if (path) await state.supabase.storage.from('gallery').remove([decodeURIComponent(path)]);
                    setMessage('galleryMessage', 'success', 'gallery.deleted');
                    loaders.gallery();
                }),
            );
            const order = el('div', 'admin-row');
            const up = button(at(state.lang, 'gallery.moveUp'), 'btn btn-ghost btn-sm', () => move(index, -1));
            const down = button(at(state.lang, 'gallery.moveDown'), 'btn btn-ghost btn-sm', () => move(index, 1));
            up.disabled = index === 0;
            down.disabled = index === data.length - 1;
            order.append(up, down);
            caption.append(order);
            caption.append(row);
            item.append(img, caption);
            return item;
        }),
    );
};

// --- Customers and roles ---
function initCustomers() {
    $('customerSearch').addEventListener('input', renderCustomers);
    $('customerFilter').addEventListener('change', renderCustomers);
    $('customerSort').addEventListener('change', renderCustomers);
}

// --- Messages with customers (booking_messages, migration 20261102110000). Opening the panel marks the customers'
// messages read; answering goes through staff_send_message (staff only, checked by the database). ---
const isMissingTable = (error) =>
    ['42P01', 'PGRST205', 'PGRST202'].includes(error?.code) ||
    /does not exist|schema cache/i.test(error?.message ?? '');

async function refreshMessagesDot() {
    const { count, error } = await state.supabase
        .from('booking_messages')
        .select('id', { count: 'exact', head: true })
        .eq('from_staff', false)
        .is('read_at', null);
    $('messagesDot').hidden = Boolean(error) || !count;
}

function messageBookingLabel(booking) {
    if (!booking?.starts_at) return '';
    const service = (state.lang === 'ar' && booking.services?.name_ar) || booking.services?.name_fr || '';
    return [formatDateOf(booking.starts_at, state.lang), formatTime(booking.starts_at), service]
        .filter(Boolean)
        .join(' · ');
}

function renderStaffThread(thread) {
    const card = el('article', 'message-thread');
    const customer = thread.last.profiles ?? {};
    const head = el('header', 'message-thread-head');
    const who = el('div', '');
    const name = el('p', 'message-thread-title', customer.full_name || customer.email || '—');
    name.dir = 'auto';
    who.append(name, el('p', 'admin-item-meta', messageBookingLabel(thread.last.bookings)));
    head.append(
        who,
        el('span', `message-status is-${thread.status}`, at(state.lang, `messages.status.${thread.status}`)),
    );
    const list = el('ul', 'message-list');
    for (const m of thread.messages) {
        const item = el('li', `message ${m.from_staff ? 'is-mine' : 'is-theirs'}`);
        const body = el('p', 'message-body', m.body);
        body.dir = 'auto';
        item.append(
            body,
            el(
                'p',
                'message-meta',
                `${at(state.lang, m.from_staff ? 'messages.fromSalon' : 'messages.fromCustomer')} · ${formatDateOf(m.created_at, state.lang)} ${formatTime(m.created_at)}`,
            ),
        );
        list.append(item);
    }
    const reply = el('textarea', 'field');
    reply.rows = 2;
    reply.maxLength = 1000;
    reply.dir = 'auto';
    reply.setAttribute('aria-label', at(state.lang, 'messages.reply'));
    reply.placeholder = at(state.lang, 'messages.replyPlaceholder');
    const send = button(at(state.lang, 'messages.send'), 'btn btn-primary btn-sm', async () => {
        const body = reply.value.trim();
        if (!body) return setMessage('messagesPanelMessage', 'error', 'messages.error.message_empty');
        send.disabled = true;
        const { error } = await state.supabase.rpc('staff_send_message', {
            p_booking_id: thread.bookingId,
            p_body: body,
        });
        send.disabled = false;
        if (error) return setMessage('messagesPanelMessage', 'error', errorKey(error));
        setMessage('messagesPanelMessage', 'success', 'messages.sent');
        loaders.messages();
    });
    card.append(head, list, reply, send);
    return card;
}

loaders.messages = async () => {
    const box = $('adminThreads');
    box.replaceChildren(el('p', 'admin-empty', at(state.lang, 'common.loading')));
    const { data, error } = await state.supabase
        .from('booking_messages')
        .select(
            'id, booking_id, customer_id, from_staff, body, created_at, read_at, bookings:booking_id (starts_at, status, services (name_fr, name_ar)), profiles:customer_id (full_name, email)',
        )
        .order('created_at')
        .limit(500);
    if (error) {
        box.replaceChildren(
            el('p', 'admin-empty', at(state.lang, isMissingTable(error) ? 'messages.unavailable' : 'common.error')),
        );
        return;
    }
    const threads = groupThreads(data ?? [], 'staff');
    if (!threads.length) {
        box.replaceChildren(el('p', 'admin-empty', at(state.lang, 'messages.empty')));
        return;
    }
    box.replaceChildren(...threads.map(renderStaffThread));
    // Seen now: the customers' messages of every conversation shown become « read »
    const unread = threads.filter((t) => t.unread);
    await Promise.all(unread.map((t) => state.supabase.rpc('staff_mark_messages_read', { p_booking_id: t.bookingId })));
    if (unread.length) refreshMessagesDot();
};

loaders.customers = async () => {
    const { data } = await state.supabase
        .from('profiles')
        .select('id, full_name, email, role, created_at, loyalty_cards (stamps_total, short_code)')
        .order('created_at', { ascending: false });
    state.customers = data ?? [];
    // Free haircuts waiting to be used, per customer (for the "Avec coupe offerte" filter)
    const { data: rewards } = await state.supabase
        .from('loyalty_rewards')
        .select('customer_id')
        .is('redeemed_at', null);
    state.customersWithReward = new Set((rewards ?? []).map((r) => r.customer_id));
    renderCustomers();
};

const cardOf = (c) => (Array.isArray(c.loyalty_cards) ? c.loyalty_cards[0] : c.loyalty_cards);

function renderCustomers() {
    const query = $('customerSearch').value.trim().toLowerCase();
    const filter = $('customerFilter').value;
    const sort = $('customerSort').value;
    const list = $('customersList');
    const rows = state.customers
        .filter((c) => {
            const text = `${c.full_name ?? ''} ${c.email ?? ''} ${cardOf(c)?.short_code ?? ''} ${c.id}`.toLowerCase();
            if (query && !text.includes(query)) return false;
            if (filter === 'customer') return c.role === 'customer';
            if (filter === 'staff') return c.role !== 'customer';
            if (filter === 'reward') return state.customersWithReward?.has(c.id);
            return true;
        })
        .sort((a, b) => {
            if (sort === 'name') return (a.full_name ?? '').localeCompare(b.full_name ?? '', state.lang);
            if (sort === 'visits') return (cardOf(b)?.stamps_total ?? 0) - (cardOf(a)?.stamps_total ?? 0);
            return b.created_at.localeCompare(a.created_at);
        });
    $('customersCount').textContent = at(state.lang, 'customers.count', {
        count: rows.length,
        total: state.customers.length,
    });
    if (!rows.length) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'customers.none')));
        return;
    }
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

    // Payments of this customer (only "paid" counts as paid)
    const { data: payments, error: payError } = await sb
        .from('payments')
        .select('amount_cents, status, paid_at, created_at')
        .eq('customer_id', c.id)
        .order('created_at', { ascending: false })
        .limit(10);
    if (!payError) {
        const pays = el('ul', 'booking-history');
        pays.append(
            ...(payments.length
                ? payments.map((p) =>
                      el(
                          'li',
                          '',
                          `${formatDateOf(p.paid_at ?? p.created_at, state.lang)} · ${cents(p.amount_cents)} · ${at(state.lang, `paystatus.${p.status}`)}`,
                      ),
                  )
                : [el('li', '', at(state.lang, 'customers.noPayments'))]),
        );
        box.append(el('p', 'admin-item-title', at(state.lang, 'customers.payments')), pays);
    }

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
                    ? await saveCustomerNote(sb, c.id, value)
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

// Staff may only change the note column of customer_notes: an upsert also sets customer_id on conflict
// and is refused (42501), so the existing note is updated, or a new one inserted. Success only when the
// database returns the saved row.
async function saveCustomerNote(sb, customerId, note) {
    const updated = await sb
        .from('customer_notes')
        .update({ note })
        .eq('customer_id', customerId)
        .select('customer_id');
    if (updated.error || updated.data?.length) return updated;
    const inserted = await sb.from('customer_notes').insert({ customer_id: customerId, note }).select('customer_id');
    if (!inserted.error && !inserted.data?.length) return { error: { message: 'forbidden' } };
    return inserted;
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
        const sb = state.supabase;
        const [b, p] = await Promise.all([
            sb.from('booking_settings').update(booking).eq('id', true).select('id'),
            sb
                .from('payment_settings')
                .update({ online_payments_enabled: $('setPaymentsEnabled').checked })
                .eq('id', true)
                .select('id'),
        ]);
        const error = b.error ?? p.error ?? (!b.data?.length || !p.data?.length ? { message: 'forbidden' } : null);
        setMessage('settingsMessage', error ? 'error' : 'success', error ? errorKey(error) : 'settings.saved');
    });
}

// Password of the signed-in account (passwordChange.js): code by e-mail, checked by Supabase Auth, then the new
// password. Nothing typed here is kept: the fields are emptied after each attempt that reached Supabase.
const RESEND_DELAY_S = 60;

function passwordErrorKey(error) {
    const key = `password.error.${error?.code ?? ''}`;
    return at(state.lang, key) === key ? 'password.error.other' : key;
}

function initPasswordChange() {
    const form = $('passwordForm');
    const send = $('passwordSendCode');
    if (!form || !send) return;
    const email = state.user?.email ?? '';
    let timer = 0;

    const waitBeforeResend = () => {
        let left = RESEND_DELAY_S;
        send.disabled = true;
        clearInterval(timer);
        const tick = () => {
            send.textContent = at(state.lang, 'password.resendIn', { s: left });
            if (left-- <= 0) {
                clearInterval(timer);
                send.disabled = false;
                send.textContent = at(state.lang, 'password.resend');
            }
        };
        tick();
        timer = setInterval(tick, 1000);
    };

    send.addEventListener('click', async () => {
        send.disabled = true;
        setMessage('passwordMessage', null);
        const { error } = await sendPasswordCode(state.supabase.auth, email);
        if (error) {
            send.disabled = false;
            setMessage('passwordMessage', 'error', passwordErrorKey(error), {
                detail: [error.code, error.status].filter(Boolean).join(' · '),
            });
            return;
        }
        $('passwordStep').hidden = false;
        $('passwordCode').focus();
        setMessage('passwordMessage', 'success', 'password.codeSent', { email });
        waitBeforeResend();
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        $('passwordSave').disabled = true;
        const result = await confirmPasswordChange(state.supabase.auth, {
            email,
            userId: state.user?.id,
            code: $('passwordCode').value,
            password: $('passwordNew').value,
            repeat: $('passwordRepeat').value,
        });
        $('passwordSave').disabled = false;
        // Only « other » has a detail here: the code was valid but for a different account
        if (result.errorKey) {
            return setMessage('passwordMessage', 'error', result.errorKey, { detail: 'account_mismatch' });
        }
        // Supabase answered: the typed code and passwords are not kept on the page
        for (const id of ['passwordCode', 'passwordNew', 'passwordRepeat']) $(id).value = '';
        if (result.error) {
            return setMessage('passwordMessage', 'error', passwordErrorKey(result.error), {
                detail: [result.error.code, result.error.status].filter(Boolean).join(' · '),
            });
        }
        $('passwordStep').hidden = true;
        clearInterval(timer);
        send.disabled = false;
        send.textContent = at(state.lang, 'password.sendCode');
        setMessage('passwordMessage', 'success', 'password.changed');
    });
}

// Account and connected services: each line says what is set up, what is not, or that it cannot be checked
async function renderConnectedStatus() {
    const list = $('statusList');
    list.replaceChildren(el('li', 'admin-item-meta', at(state.lang, 'common.loading')));
    const row = (labelKey, value, ok) => {
        const item = el('li', `status-line is-${ok === true ? 'ok' : ok === false ? 'off' : 'unknown'}`);
        item.append(el('span', 'status-line-label', at(state.lang, labelKey)), el('span', 'status-line-value', value));
        return item;
    };
    const role = state.isAdmin ? 'role.admin' : 'role.barber';
    const lines = [row('status.account', `${state.user.email ?? '—'} · ${at(state.lang, role)}`, true)];
    const { data: pay } = await state.supabase.from('payment_settings').select('online_payments_enabled').maybeSingle();
    lines.push(
        row(
            'status.onlinePayments',
            at(state.lang, pay?.online_payments_enabled ? 'status.shown' : 'status.hidden'),
            pay ? pay.online_payments_enabled : null,
        ),
    );
    const { data: server, error } = await state.supabase.functions.invoke('notify-staff', { body: { status: true } });
    if (error || !server) {
        lines.push(row('status.server', at(state.lang, 'status.serverUnreachable'), null));
    } else {
        const stripe =
            { test: 'status.stripeTest', live: 'status.stripeLive', none: 'status.notSet' }[server.stripe] ??
            'status.notSet';
        lines.push(
            row(
                'status.stripe',
                at(state.lang, stripe),
                server.stripe === 'test' ? true : server.stripe === 'live' ? null : false,
            ),
            row(
                'status.webhook',
                at(state.lang, server.stripe_webhook ? 'status.set' : 'status.notSet'),
                server.stripe_webhook,
            ),
            row(
                'status.livePayments',
                at(state.lang, server.live_payments_allowed ? 'status.liveAllowed' : 'status.liveBlocked'),
                !server.live_payments_allowed,
            ),
            row(
                'status.telegramBot',
                at(state.lang, server.telegram_bot ? 'status.set' : 'status.notSet'),
                server.telegram_bot,
            ),
            row(
                'status.telegramZeyd',
                at(state.lang, server.telegram_staff_chat ? 'status.set' : 'status.notSet'),
                server.telegram_staff_chat,
            ),
        );
    }
    list.replaceChildren(...lines);
}

loaders.settings = async () => {
    renderConnectedStatus();
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
    }
    $('settingsAdminOnly').hidden = state.isAdmin;
    for (const control of $('settingsForm').querySelectorAll('input, button')) control.disabled = !state.isAdmin;
};

init();

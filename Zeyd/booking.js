// Booking section and account dialog. The database decides what is allowed (hours, closures,
// double booking, limits); this file only shows the choices it offers and reports its answers.
import {
    bookAppointment,
    cancelBooking,
    errorCode,
    fetchBookableDays,
    fetchMyBookings,
    fetchSlots,
    onAuthChange,
    requestCustomTime,
    signIn,
    signOut,
    signUp,
} from './api.js';
import { t } from './i18n.js';
import { formatDateOf, formatDay, formatTime, parisLocalToIso } from './time.js';

const state = {
    ready: false,
    lang: 'fr',
    services: [],
    priceFormatter: null,
    user: null,
    days: null, // null = backend unavailable
    serviceId: null,
    day: null,
    slots: null, // null = loading
    slot: null,
    authMode: 'signin',
    bookings: [],
    slotsRequest: null,
    messages: {}, // element id -> { kind, key, params } so messages follow language changes
};

const $ = (id) => document.getElementById(id);
const isBookable = (service) => Boolean(service?.dbId && service.durationMinutes);
const currentService = () => state.services.find((s) => s.id === state.serviceId) ?? null;
const serviceName = (service) => service?.name[state.lang] ?? service?.name.fr ?? '';

// --- Messages (icon + text, never colour alone) ---
function setMessage(id, kind, key, params = {}) {
    state.messages[id] = kind ? { kind, key, params } : null;
    renderMessage(id);
}

function renderMessage(id) {
    const el = $(id);
    const message = state.messages[id];
    if (!el) return;
    el.hidden = !message;
    if (!message) return;
    el.className = `form-message ${message.kind === 'success' ? 'is-success' : 'is-error'}`;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', message.kind === 'success' ? '#i-check' : '#i-alert');
    icon.append(use);
    const text = document.createElement('p');
    text.className = 'form-message-text';
    text.textContent = t(state.lang, message.key, message.params);
    el.replaceChildren(icon, text);
}

const errorKey = (error) => `error.${errorCode(error)}`;

// --- Public API used by script.js ---
export async function initBooking({ lang, services, priceFormatter }) {
    state.lang = lang;
    state.services = services;
    state.priceFormatter = priceFormatter;
    state.ready = true;

    $('bookingService')?.addEventListener('change', (e) => {
        state.serviceId = e.target.value;
        state.slot = null;
        loadSlots();
    });
    $('bookingDays')?.addEventListener('change', (e) => {
        state.day = e.target.value;
        state.slot = null;
        loadSlots();
    });
    $('bookingSlots')?.addEventListener('change', (e) => {
        state.slot = state.slots?.find((s) => s.starts_at === e.target.value) ?? null;
        renderSummary();
    });
    $('bookingForm')?.addEventListener('submit', onBookingSubmit);
    $('customForm')?.addEventListener('submit', onCustomSubmit);
    initAccountDialog();

    renderServiceSelect();
    renderSummary();
    onAuthChange(onUserChange);

    state.days = await fetchBookableDays();
    $('bookingOffline').hidden = state.days !== null;
    $('bookingForm').hidden = state.days === null;
    $('customRequest').hidden = state.days === null;
    if (state.days?.length) state.day = state.days[0];
    renderDays();
    loadSlots();
}

export function setBookingLanguage(lang) {
    state.lang = lang;
    if (!state.ready) return;
    renderServiceSelect();
    renderDays();
    renderSlots();
    renderSummary();
    renderAuthMode();
    renderBookings();
    for (const id of Object.keys(state.messages)) renderMessage(id);
}

export function setBookingServices(services) {
    state.services = services;
    if (!state.ready) return;
    renderServiceSelect();
    loadSlots();
}

// Called by the "Réserver" link of a service card.
export function selectBookingService(serviceId) {
    state.serviceId = serviceId;
    state.slot = null;
    if (!state.ready) return;
    renderServiceSelect();
    loadSlots();
}

// --- Booking form ---
function renderServiceSelect() {
    const select = $('bookingService');
    if (!select) return;
    if (!state.services.some((s) => s.id === state.serviceId)) {
        state.serviceId = (state.services.find(isBookable) ?? state.services[0])?.id ?? null;
    }
    const options = state.services.map((service) => {
        const option = document.createElement('option');
        option.value = service.id;
        const price = state.priceFormatter.format(service.price);
        const duration = service.durationMinutes
            ? t(state.lang, 'services.duration', { min: service.durationMinutes })
            : t(state.lang, 'services.durationUnknown');
        option.textContent = `${serviceName(service)} — ${price} · ${duration}`;
        option.selected = service.id === state.serviceId;
        return option;
    });
    select.replaceChildren(...options);
    $('bookingServiceHint').hidden = isBookable(currentService());
}

function radio(name, value, label, checked) {
    const wrapper = document.createElement('label');
    wrapper.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = checked;
    const text = document.createElement('span');
    text.textContent = label;
    wrapper.append(input, text);
    return wrapper;
}

function renderDays() {
    const container = $('bookingDays');
    if (!container || !state.days) return;
    container.replaceChildren(
        ...state.days.map((day) => radio('day', day, formatDay(day, state.lang), day === state.day)),
    );
}

async function loadSlots() {
    const service = currentService();
    $('bookingServiceHint').hidden = isBookable(service);
    if (!state.days || !isBookable(service) || !state.day) {
        state.slots = [];
        renderSlots();
        renderSummary();
        return;
    }
    state.slots = null;
    renderSlots();
    const requested = `${service.dbId}|${state.day}`;
    state.slotsRequest = requested;
    const slots = await fetchSlots(service.dbId, state.day);
    if (state.slotsRequest !== requested) return; // a newer choice was made meanwhile
    state.slots = slots ?? [];
    if (state.slot && !state.slots.some((s) => s.starts_at === state.slot.starts_at)) state.slot = null;
    renderSlots();
    renderSummary();
}

function renderSlots() {
    const container = $('bookingSlots');
    const hint = $('bookingSlotsHint');
    if (!container) return;
    const service = currentService();
    if (state.slots === null) {
        container.replaceChildren();
        hint.textContent = t(state.lang, 'booking.loading');
        return;
    }
    container.replaceChildren(
        ...state.slots.map((slot) =>
            radio('slot', slot.starts_at, formatTime(slot.starts_at), slot.starts_at === state.slot?.starts_at),
        ),
    );
    if (!isBookable(service)) hint.textContent = '';
    else if (!state.day) hint.textContent = t(state.lang, 'booking.chooseDay');
    else hint.textContent = state.slots.length ? '' : t(state.lang, 'booking.noSlots');
}

function renderSummary() {
    const summary = $('bookingSummary');
    if (!summary) return;
    const service = currentService();
    summary.textContent =
        service && state.slot
            ? t(state.lang, 'booking.summary', {
                  service: serviceName(service),
                  day: formatDateOf(state.slot.starts_at, state.lang),
                  time: formatTime(state.slot.starts_at),
              })
            : t(state.lang, 'booking.summaryEmpty');
    $('bookingSubmitText').textContent = t(state.lang, state.user ? 'booking.submit' : 'booking.signInToBook');
}

async function onBookingSubmit(event) {
    event.preventDefault();
    if (!state.user) {
        openAccount('signin');
        setMessage('authMessage', 'error', 'error.auth_required');
        return;
    }
    const service = currentService();
    if (!isBookable(service) || !state.slot) {
        setMessage('bookingMessage', 'error', 'booking.summaryEmpty');
        return;
    }
    const button = $('bookingSubmit');
    button.disabled = true;
    const { data, error } = await bookAppointment(service.dbId, state.slot.starts_at, $('bookingNote').value);
    button.disabled = false;
    if (error) {
        setMessage('bookingMessage', 'error', errorKey(error));
        if (errorCode(error) === 'slot_unavailable') loadSlots();
        return;
    }
    setMessage('bookingMessage', 'success', 'booking.success', {
        day: formatDateOf(data.starts_at, state.lang),
        time: formatTime(data.starts_at),
    });
    $('bookingNote').value = '';
    state.slot = null;
    loadSlots();
    loadMyBookings();
}

async function onCustomSubmit(event) {
    event.preventDefault();
    if (!state.user) {
        openAccount('signin');
        setMessage('authMessage', 'error', 'error.auth_required');
        return;
    }
    const startsAt = parisLocalToIso($('customDate').value);
    const service = currentService();
    if (!startsAt || !service?.dbId) {
        setMessage('customMessage', 'error', !startsAt ? 'error.invalid_time' : 'error.service_unavailable');
        return;
    }
    const { error } = await requestCustomTime(service.dbId, startsAt, $('customNote').value);
    if (error) {
        setMessage('customMessage', 'error', errorKey(error));
        return;
    }
    setMessage('customMessage', 'success', 'booking.customSuccess');
    $('customDate').value = '';
    $('customNote').value = '';
    loadMyBookings();
}

// --- Account dialog ---
function initAccountDialog() {
    const dialog = $('accountDialog');
    if (!dialog) return;
    document.querySelectorAll('[data-open-account]').forEach((btn) => {
        btn.addEventListener('click', () => openAccount());
    });
    $('accountCloseBtn').addEventListener('click', () => dialog.close());
    // Click on the backdrop closes the dialog
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.close();
    });
    document.querySelectorAll('[data-auth-mode]').forEach((tab) => {
        tab.addEventListener('click', () => {
            state.authMode = tab.dataset.authMode;
            setMessage('authMessage', null);
            renderAuthMode();
        });
    });
    $('authForm').addEventListener('submit', onAuthSubmit);
    $('signOutBtn').addEventListener('click', async () => {
        await signOut();
        setMessage('accountMessage', null);
    });
}

function openAccount(mode) {
    if (mode) state.authMode = mode;
    renderAuthMode();
    const dialog = $('accountDialog');
    if (!dialog.open) dialog.showModal();
}

function renderAuthMode() {
    const signup = state.authMode === 'signup';
    $('signInTab')?.setAttribute('aria-selected', String(!signup));
    $('signUpTab')?.setAttribute('aria-selected', String(signup));
    if (!$('authForm')) return;
    $('authNameGroup').hidden = !signup;
    $('authPassword').autocomplete = signup ? 'new-password' : 'current-password';
    $('authSubmit').textContent = t(state.lang, signup ? 'account.signUpSubmit' : 'account.signInSubmit');
}

async function onAuthSubmit(event) {
    event.preventDefault();
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    if (!$('authEmail').checkValidity() || !email) {
        setMessage('authMessage', 'error', 'error.invalid_credentials');
        return;
    }
    if (state.authMode === 'signup' && password.length < 8) {
        setMessage('authMessage', 'error', 'error.weak_password');
        return;
    }
    const button = $('authSubmit');
    button.disabled = true;
    const result =
        state.authMode === 'signup'
            ? await signUp(email, password, { fullName: $('authName').value.trim(), lang: state.lang })
            : await signIn(email, password);
    button.disabled = false;
    if (result.error) {
        setMessage('authMessage', 'error', errorKey(result.error));
        return;
    }
    $('authPassword').value = '';
    if (state.authMode === 'signup' && !result.data?.session) {
        // Email confirmation is on: the account is active once the link is opened.
        setMessage('authMessage', 'success', 'account.checkEmail', { email });
        state.authMode = 'signin';
        renderAuthMode();
        return;
    }
    setMessage('authMessage', null);
}

function onUserChange(user) {
    state.user = user;
    document.querySelectorAll('.account-dot').forEach((dot) => {
        dot.hidden = !user;
    });
    if ($('authView')) {
        $('authView').hidden = Boolean(user);
        $('accountView').hidden = !user;
        $('accountEmail').textContent = user?.email ?? '';
    }
    renderSummary();
    if (user) loadMyBookings();
    else {
        state.bookings = [];
        renderBookings();
    }
}

async function loadMyBookings() {
    state.bookings = (await fetchMyBookings()) ?? [];
    renderBookings();
}

function renderBookings() {
    const list = $('myBookings');
    if (!list) return;
    if (!state.bookings.length) {
        const empty = document.createElement('li');
        empty.className = 'my-bookings-empty';
        empty.textContent = t(state.lang, 'account.noBookings');
        list.replaceChildren(empty);
        return;
    }
    list.replaceChildren(
        ...state.bookings.map((booking) => {
            const item = document.createElement('li');
            item.className = 'my-booking';
            const day = formatDateOf(booking.starts_at, state.lang);
            const time = formatTime(booking.starts_at);

            const info = document.createElement('div');
            const when = document.createElement('p');
            when.className = 'my-booking-when';
            when.textContent = `${day} · ${time}`;
            const what = document.createElement('p');
            what.className = 'my-booking-what';
            const names = booking.services ?? {};
            what.textContent = (state.lang === 'ar' && names.name_ar) || names.name_fr || '';
            const status = document.createElement('span');
            status.className = `status-badge is-${booking.status}`;
            status.textContent = t(state.lang, `status.${booking.status}`);
            info.append(when, what, status);

            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'btn btn-ghost btn-sm';
            cancel.textContent = t(state.lang, 'account.cancel');
            cancel.setAttribute('aria-label', t(state.lang, 'account.cancelAria', { day, time }));
            cancel.addEventListener('click', async () => {
                if (!window.confirm(t(state.lang, 'account.cancelConfirm'))) return;
                const { error } = await cancelBooking(booking.id);
                if (error) setMessage('accountMessage', 'error', errorKey(error));
                else setMessage('accountMessage', 'success', 'account.cancelled');
                loadMyBookings();
                loadSlots();
            });
            item.append(info, cancel);
            return item;
        }),
    );
}

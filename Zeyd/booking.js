// Booking section and account dialog. The database decides what is allowed (hours, closures,
// double booking, limits); this file only shows the choices it offers and reports its answers.
import {
    bookAppointment,
    cancelBooking,
    errorCode,
    fetchBookableDays,
    fetchMyBookings,
    fetchMyLoyalty,
    fetchMyPayments,
    fetchPaymentSettings,
    fetchSlots,
    onAuthChange,
    requestCustomTime,
    resendConfirmation,
    signIn,
    signOut,
    signUp,
    startCheckout,
} from './api.js';
import { cleanAuthUrl, parseAuthRedirect } from './authRedirect.js';
import { t } from './i18n.js';
import { renderLoyaltyCard, renderQrCode } from './loyalty.js';
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
    authStep: 'choices',
    authKnown: false,
    authOpener: null,
    bookings: [],
    payments: {},
    paymentsEnabled: false,
    loyalty: null,
    loyaltyLoaded: false,
    slotsRequest: null,
    autoAdvanceDay: true, // on first display only: skip days that have no free time left
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

// After a confirmation link, how long to wait for supabase-js to restore the session before saying so
const CONFIRM_TIMEOUT_MS = 15000;

// --- Public API used by script.js ---
export async function initBooking({ lang, services, priceFormatter }) {
    state.lang = lang;
    state.services = services;
    state.priceFormatter = priceFormatter;
    state.ready = true;
    // Read before the Supabase client starts: it consumes the tokens of the URL when it is created
    const authRedirect = parseAuthRedirect(location.hash, location.search);

    $('bookingService')?.addEventListener('change', (e) => {
        state.serviceId = e.target.value;
        state.slot = null;
        loadSlots();
    });
    $('bookingDays')?.addEventListener('change', (e) => {
        state.autoAdvanceDay = false;
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
    initAuthScreen();
    initAccountDialog();

    renderServiceSelect();
    renderSummary();
    handleAuthRedirect(authRedirect);

    state.days = await fetchBookableDays();
    onAuthChange(onUserChange);
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
    renderAuthStep();
    renderBookings();
    renderLoyalty();
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
    const nextDay = state.days[state.days.indexOf(state.day) + 1];
    if (state.autoAdvanceDay && slots && !slots.length && nextDay) {
        state.day = nextDay;
        renderDays();
        loadSlots();
        return;
    }
    state.autoAdvanceDay = false;
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
    const { data, error } = await requestCustomTime(service.dbId, startsAt, $('customNote').value);
    if (error) {
        setMessage('customMessage', 'error', errorKey(error));
        return;
    }
    // A valid custom time is confirmed at once; with an unknown duration it waits for Zeyd
    if (data?.status === 'confirmed') {
        setMessage('customMessage', 'success', 'booking.success', {
            day: formatDateOf(data.starts_at, state.lang),
            time: formatTime(data.starts_at),
        });
        loadSlots();
    } else {
        setMessage('customMessage', 'success', 'booking.customSuccess');
    }
    $('customDate').value = '';
    $('customNote').value = '';
    loadMyBookings();
}

// --- Sign-in screen (full screen, barber chair) ---
const WELCOME_KEY = 'welcomeSeen';

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
        // The choice only lasts for this visit
    }
}

function initAuthScreen() {
    const screen = $('authScreen');
    if (!screen) return;
    screen.querySelectorAll('[data-auth-mode]').forEach((btn) => {
        btn.addEventListener('click', () => showAuthScreen(btn.dataset.authMode));
    });
    $('authSkipBtn').addEventListener('click', hideAuthScreen);
    $('authCloseBtn').addEventListener('click', hideAuthScreen);
    $('authBackBtn').addEventListener('click', () => showAuthScreen('choices'));
    $('authSwitchBtn').addEventListener('click', () =>
        showAuthScreen(state.authMode === 'signup' ? 'signin' : 'signup'),
    );
    $('authForm').addEventListener('submit', onAuthSubmit);
    $('authResendBtn').addEventListener('click', onResendConfirmation);
    screen.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideAuthScreen();
    });
}

function showAuthScreen(step = 'choices') {
    const screen = $('authScreen');
    if (!screen) return;
    const opening = screen.hidden;
    if (opening) state.authOpener = document.activeElement;
    if (step !== 'choices') state.authMode = step;
    state.authStep = step;
    screen.hidden = false;
    document.body.classList.add('has-overlay');
    if (step === 'choices') {
        setMessage('authMessage', null);
        showResend(false);
    }
    renderAuthStep();
    const focusTarget = step === 'choices' ? screen.querySelector('[data-auth-mode="signin"]') : $('authEmail');
    focusTarget?.focus();
}

function hideAuthScreen() {
    const screen = $('authScreen');
    if (!screen || screen.hidden) return;
    screen.hidden = true;
    document.body.classList.remove('has-overlay');
    writePref(WELCOME_KEY, '1');
    state.authOpener?.focus?.();
}

function renderAuthStep() {
    if (!$('authForm')) return;
    const choices = state.authStep === 'choices';
    const signup = state.authMode === 'signup';
    $('authChoices').hidden = !choices;
    $('authForm').hidden = choices;
    $('authNameGroup').hidden = !signup;
    $('authPassword').autocomplete = signup ? 'new-password' : 'current-password';
    $('authFormTitle').textContent = t(state.lang, signup ? 'auth.signUpTitle' : 'auth.signInTitle');
    $('authSubmit').textContent = t(state.lang, signup ? 'account.signUpSubmit' : 'account.signInSubmit');
    $('authSwitchBtn').textContent = t(state.lang, signup ? 'auth.toSignIn' : 'auth.toSignUp');
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
        showResend(errorCode(result.error) === 'email_not_confirmed');
        return;
    }
    showResend(false);
    $('authPassword').value = '';
    if (state.authMode === 'signup' && !result.data?.session) {
        // Email confirmation is on: the account is active once the link is opened.
        setMessage('authMessage', 'success', 'account.checkEmail', { email });
        state.authMode = 'signin';
        renderAuthStep();
        return;
    }
    setMessage('authMessage', null);
    hideAuthScreen();
}

function showResend(visible) {
    if ($('authResendBtn')) $('authResendBtn').hidden = !visible;
}

async function onResendConfirmation() {
    const email = $('authEmail').value.trim();
    if (!email || !$('authEmail').checkValidity()) {
        setMessage('authMessage', 'error', 'error.email_required');
        $('authEmail').focus();
        return;
    }
    const button = $('authResendBtn');
    button.disabled = true;
    const { error } = await resendConfirmation(email);
    button.disabled = false;
    if (error) {
        setMessage('authMessage', 'error', errorKey(error));
        return;
    }
    setMessage('authMessage', 'success', 'auth.resent', { email });
}

// Back from the confirmation email (see authRedirect.js).
// Failure: explained at once. Success: supabase-js restores the session, onUserChange confirms it;
// if it never does, a message replaces the wait instead of an endless loading.
function handleAuthRedirect(redirect) {
    if (!redirect) return;
    if (redirect.kind === 'error') {
        history.replaceState(null, '', cleanAuthUrl(location.pathname, location.search));
        showAuthScreen('signin');
        showResend(true);
        setMessage('authMessage', 'error', `error.${redirect.reason}`);
        return;
    }
    state.confirmPending = true;
    state.confirmTimer = setTimeout(() => confirmFailed(), CONFIRM_TIMEOUT_MS);
}

function confirmFailed() {
    if (!state.confirmPending) return;
    state.confirmPending = false;
    clearTimeout(state.confirmTimer);
    history.replaceState(null, '', cleanAuthUrl(location.pathname, location.search));
    showAuthScreen('signin');
    showResend(true);
    setMessage('authMessage', 'error', 'error.session_failed');
}

// --- Account dialog (signed in) ---
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
    $('signOutBtn').addEventListener('click', async () => {
        await signOut();
        setMessage('accountMessage', null);
        dialog.close();
    });
    $('loyaltyQrBtn').addEventListener('click', openQr);
    const qrDialog = $('qrDialog');
    $('qrCloseBtn').addEventListener('click', () => qrDialog.close());
    // Click outside the panel (on the backdrop) closes it; Escape is handled by <dialog>
    qrDialog.addEventListener('click', (e) => {
        if (e.target === qrDialog) qrDialog.close();
    });
}

function openAccount(mode) {
    if (!state.user) {
        showAuthScreen(mode ?? 'choices');
        return;
    }
    const dialog = $('accountDialog');
    if (!dialog.open) dialog.showModal();
    loadMyBookings();
    loadLoyalty();
}

function onUserChange(user) {
    const firstCall = !state.authKnown;
    state.authKnown = true;
    state.user = user;
    document.querySelectorAll('.account-dot').forEach((dot) => {
        dot.hidden = !user;
    });
    if ($('accountEmail')) $('accountEmail').textContent = user?.email ?? '';
    renderSummary();
    if (user && state.confirmPending) {
        // Signed in by the confirmation link: say it, then show the account
        state.confirmPending = false;
        clearTimeout(state.confirmTimer);
        history.replaceState(null, '', cleanAuthUrl(location.pathname, location.search));
        hideAuthScreen();
        openAccount();
        setMessage('accountMessage', 'success', 'account.emailConfirmed');
        return;
    }
    if (user) {
        hideAuthScreen();
        loadMyBookings();
        loadLoyalty();
    } else if (state.confirmPending) {
        // The link carried a session that could not be restored
        confirmFailed();
    } else {
        state.bookings = [];
        state.loyalty = null;
        if ($('qrDialog')?.open) $('qrDialog').close();
        renderBookings();
        renderLoyalty();
        if ($('accountDialog')?.open) $('accountDialog').close();
        // First visit: welcome screen once (only when accounts can actually be used)
        // (not over the sign-in form already opened by a confirmation link)
        if (firstCall && state.days !== null && !readPref(WELCOME_KEY) && $('authScreen')?.hidden)
            showAuthScreen('choices');
    }
}

// --- Loyalty card ---
async function loadLoyalty() {
    if (!state.user) return;
    state.loyalty = await fetchMyLoyalty();
    state.loyaltyLoaded = true;
    renderLoyalty();
}

function renderLoyalty() {
    const container = $('loyaltyCard');
    if (!container) return;
    const card = state.loyalty;
    $('loyaltyQrBtn').hidden = !card;
    if (!card) {
        container.replaceChildren();
        $('loyaltyProgress').textContent =
            state.user && state.loyaltyLoaded ? t(state.lang, 'loyalty.unavailable') : '';
        if ($('qrDialog').open) $('qrDialog').close();
        return;
    }
    const filled = renderLoyaltyCard(container, card, state.lang);
    const lines = [];
    const reward = filled === 10 || card.available_rewards > 0;
    if (reward) lines.push(t(state.lang, 'loyalty.rewardReady'));
    if (card.available_rewards > 1)
        lines.push(t(state.lang, 'loyalty.rewardsAvailable', { count: card.available_rewards }));
    if (filled < 10) lines.push(t(state.lang, 'loyalty.progress', { count: filled, left: 10 - filled }));
    $('loyaltyProgress').textContent = lines.join(' ');
    $('loyaltyProgress').classList.toggle('is-reward', reward);
    $('loyaltyShortCode').textContent = card.short_code;
}

// Only displays the code: no request is sent, so it cannot add a visit.
async function openQr() {
    const card = state.loyalty;
    const dialog = $('qrDialog');
    if (!card || dialog.open) return;
    $('loyaltyShortCode').textContent = card.short_code;
    setMessage('qrMessage', null);
    dialog.showModal();
    const ok = await renderQrCode($('loyaltyQrCode'), card.token);
    if (!ok) setMessage('qrMessage', 'error', 'loyalty.qrError', { code: card.short_code });
}

// --- Upcoming bookings (with payment) ---
async function loadMyBookings() {
    if (!state.user) return;
    const [bookings, settings] = await Promise.all([fetchMyBookings(state.user.id), fetchPaymentSettings()]);
    // Cancelled bookings are shown only when the salon cancelled them, so the customer knows why
    state.bookings = (bookings ?? []).filter(
        (b) => b.status !== 'cancelled' || (b.cancelled_by && b.cancelled_by !== b.customer_id),
    );
    state.paymentsEnabled = Boolean(settings?.online_payments_enabled);
    state.payments = await fetchMyPayments(state.bookings.map((b) => b.id));
    renderBookings();
}

async function onPay(booking, button) {
    button.disabled = true;
    setMessage('accountMessage', 'success', 'pay.redirecting');
    const { data, error } = await startCheckout(booking.id);
    if (error) {
        button.disabled = false;
        setMessage('accountMessage', 'error', errorKey(error));
        return;
    }
    window.location.assign(data.url);
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
            item.className = `my-booking${booking.status === 'cancelled' ? ' is-cancelled' : ''}`;
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
            status.textContent =
                booking.status === 'cancelled'
                    ? t(state.lang, 'account.cancelledBySalon')
                    : t(state.lang, `status.${booking.status}`);
            info.append(when, what, status);

            const payment = state.payments?.[booking.id];
            if (payment?.status === 'paid') {
                const paid = document.createElement('span');
                paid.className = 'status-badge is-paid';
                paid.textContent = t(state.lang, 'pay.paid');
                info.append(' ', paid);
            }
            if (booking.status === 'cancelled' && booking.cancel_reason) {
                const reason = document.createElement('p');
                reason.className = 'my-booking-what';
                reason.textContent = t(state.lang, 'account.cancelReason', { reason: booking.cancel_reason });
                info.append(reason);
            }

            const actions = document.createElement('div');
            actions.className = 'my-booking-actions';
            const price = Number(names.price);
            if (state.paymentsEnabled && booking.status === 'confirmed' && payment?.status !== 'paid' && price > 0) {
                const pay = document.createElement('button');
                pay.type = 'button';
                pay.className = 'btn btn-primary btn-sm';
                pay.textContent = t(state.lang, 'pay.button', { amount: state.priceFormatter.format(price) });
                pay.addEventListener('click', () => onPay(booking, pay));
                actions.append(pay);
            }
            if (booking.status === 'confirmed' || booking.status === 'requested') {
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
                actions.append(cancel);
            }
            item.append(info, actions);
            return item;
        }),
    );
}

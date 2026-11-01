// Booking section and account dialog. The database decides what is allowed (hours, closures,
// double booking, limits); this file only shows the choices it offers and reports its answers.
import {
    bookAppointment,
    cancelMyBooking,
    errorCode,
    fetchBookableDays,
    fetchMyBookings,
    fetchMyLoyalty,
    fetchMyPayments,
    fetchPaymentSettings,
    fetchSchedule,
    fetchSlots,
    notifyStaffOfBooking,
    onAuthChange,
    requestCustomTime,
    rescheduleMyBooking,
    resendConfirmation,
    saveSoundPrefs,
    signIn,
    signOut,
    signUp,
    startCheckout,
} from './api.js';
import { cleanAuthUrl, parseAuthRedirect } from './authRedirect.js';
import { confirmDialog } from './confirmDialog.js';
import { createHoldButton } from './holdButton.js';
import { t } from './i18n.js';
import { renderLoyaltyCard, renderQrCode } from './loyalty.js';
import { initMessagesCenter, openMessages, refreshMessages, renderMessages } from './messagesCenter.js';
import { closePages, openPage } from './overlays.js';
import { initProfilePage, loadProfile, renderProfileLanguage } from './profilePage.js';
import { buildSlotGrid } from './slotGrid.js';
import { adoptSoundPrefs, getSoundPrefs, onSoundPrefsChange } from './sound.js';
import { mergeSoundPrefs, samePrefs } from './soundCore.js';
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
        state.slot = state.slots?.find((s) => s.starts_at === e.target.value && !s.taken) ?? null;
        renderSummary();
    });
    $('bookingForm')?.addEventListener('submit', onBookingSubmit);
    $('customForm')?.addEventListener('submit', onCustomSubmit);
    initAuthScreen();
    initAccountPages();
    initCancelDialog();
    // A change made while signed in is saved to the account too (debounced: one request per burst of clicks)
    onSoundPrefsChange((prefs, source) => {
        if (source !== 'local' || !state.user) return;
        clearTimeout(state.soundSaveTimer);
        state.soundSaveTimer = setTimeout(() => saveSoundPrefs(prefs), 800);
    });

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
    // Other customers book and cancel too: the times are refreshed every minute and when the page is shown again
    setInterval(() => {
        if (!document.hidden) loadSlots({ quiet: true });
    }, 60_000);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) loadSlots({ quiet: true });
    });
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
    renderCancelDialog();
    renderReschedule();
    renderProfileLanguage();
    renderMessages();
    $('signOutBtn')?.setLabels?.(signOutLabels());
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

// quiet: refresh without the "Chargement…" step (periodic refresh)
async function loadSlots({ quiet = false } = {}) {
    const service = currentService();
    $('bookingServiceHint').hidden = isBookable(service);
    if (!state.days || !isBookable(service) || !state.day) {
        state.slots = [];
        renderSlots();
        renderSummary();
        return;
    }
    if (!quiet) {
        state.slots = null;
        renderSlots();
    }
    const requested = `${service.dbId}|${state.day}`;
    state.slotsRequest = requested;
    const [slots, schedule] = await Promise.all([fetchSlots(service.dbId, state.day), fetchSchedule()]);
    if (state.slotsRequest !== requested) return; // a newer choice was made meanwhile
    if (quiet && slots === null) return; // keep what is shown if the refresh failed
    // Free times from the database, plus the taken ones (greyed out) when the opening hours are known
    state.slots = schedule
        ? buildSlotGrid({
              day: state.day,
              hours: schedule.hours,
              stepMinutes: schedule.stepMinutes,
              durationMinutes: service.durationMinutes,
              minNoticeMinutes: schedule.minNoticeMinutes,
              now: Date.now(),
              freeSlots: slots ?? [],
              toIso: parisLocalToIso,
          })
        : (slots ?? []);
    if (slots === null) state.slots = [];
    const hasFree = state.slots.some((s) => !s.taken);
    const nextDay = state.days[state.days.indexOf(state.day) + 1];
    if (state.autoAdvanceDay && slots && !hasFree && nextDay) {
        state.day = nextDay;
        renderDays();
        loadSlots();
        return;
    }
    state.autoAdvanceDay = false;
    if (state.slot && !state.slots.some((s) => s.starts_at === state.slot.starts_at && !s.taken)) state.slot = null;
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
            slot.taken
                ? takenChoice(formatTime(slot.starts_at))
                : radio('slot', slot.starts_at, formatTime(slot.starts_at), slot.starts_at === state.slot?.starts_at),
        ),
    );
    if (!isBookable(service)) hint.textContent = '';
    else if (!state.day) hint.textContent = t(state.lang, 'booking.chooseDay');
    else hint.textContent = state.slots.some((s) => !s.taken) ? '' : t(state.lang, 'booking.noSlots');
}

// A taken time: shown in grey with « Réservé », cannot be chosen (the database refuses it anyway)
function takenChoice(time) {
    const wrapper = radio('slot', '', time, false);
    wrapper.classList.add('is-taken');
    wrapper.querySelector('input').disabled = true;
    const label = document.createElement('small');
    label.textContent = t(state.lang, 'booking.taken');
    wrapper.querySelector('span').append(label);
    return wrapper;
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
    $('bookingSubmitText').textContent = t(
        state.lang,
        state.rescheduling ? 'reschedule.submit' : state.user ? 'booking.submit' : 'booking.signInToBook',
    );
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
    if (state.rescheduling) {
        await submitReschedule(button);
        return;
    }
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

// Supabase only sends a link without an error after it has confirmed the address: even when the session
// cannot be restored here (link opened in another browser, expired session), the account is confirmed.
function confirmFailed() {
    if (!state.confirmPending) return;
    state.confirmPending = false;
    clearTimeout(state.confirmTimer);
    history.replaceState(null, '', cleanAuthUrl(location.pathname, location.search));
    showAuthScreen('signin');
    setMessage('authMessage', 'success', 'auth.accountConfirmed');
}

// --- « Profil » and « Mes RDV » pages (signed in; opened and closed through overlays.js) ---
const signOutLabels = () => ({
    label: t(state.lang, 'account.signOutHold'),
    holdingLabel: t(state.lang, 'account.signOutHolding'),
    busyLabel: t(state.lang, 'account.signOutBusy'),
    hint: t(state.lang, 'account.signOutHint'),
});

function initAccountPages() {
    if (!$('profilePage')) return;
    document.querySelectorAll('[data-open-account]').forEach((btn) => {
        btn.addEventListener('click', () => openAccount());
    });
    document.querySelectorAll('[data-open-bookings]').forEach((btn) => {
        btn.addEventListener('click', () => openAccountPanel('bookings'));
    });
    initProfilePage({
        getUser: () => state.user,
        t: (key, params) => t(state.lang, key, params),
        setMessage,
    });
    initMessagesCenter({
        getUser: () => state.user,
        getLang: () => state.lang,
        t: (key, params) => t(state.lang, key, params),
        setMessage,
    });
    // Sign out: hold the button, then confirm. Only the session of this device ends; bookings stay saved.
    const hold = createHoldButton({
        ...signOutLabels(),
        className: 'btn btn-signout',
        duration: 900,
        onConfirm: confirmSignOut,
    });
    hold.id = 'signOutBtn';
    $('signOutBtn').replaceWith(hold);
    $('loyaltyQrBtn').addEventListener('click', openQr);
    const qrDialog = $('qrDialog');
    $('qrCloseBtn').addEventListener('click', () => qrDialog.close());
    // Click outside the panel (on the backdrop) closes it; Escape is handled by <dialog>
    qrDialog.addEventListener('click', (e) => {
        if (e.target === qrDialog) qrDialog.close();
    });
}

// Returns false when the person chose « Annuler »: the hold button is then ready again
async function confirmSignOut() {
    const confirmed = await confirmDialog({
        message: t(state.lang, 'account.signOutConfirm'),
        ok: t(state.lang, 'common.yes'),
        cancel: t(state.lang, 'common.cancel'),
        cancelIcon: true,
    });
    if (!confirmed) return false;
    await signOut();
    setMessage('profileMessage', null);
    setMessage('accountMessage', null);
    closePages();
    return true;
}

// « Profil » (bottom bar, or « Mon compte » on wide screens) and « Mes RDV »: two separate full-screen pages;
// the welcome / sign-in screen when signed out
export function openAccountPanel(section = 'profile') {
    if (!state.user) {
        showAuthScreen('choices');
        return;
    }
    if (section === 'bookings') {
        openPage('bookingsPage');
        loadMyBookings();
    } else {
        openPage('profilePage');
        loadProfile();
        loadLoyalty();
        openMessages();
    }
}

function openAccount(mode) {
    if (!state.user) {
        showAuthScreen(mode ?? 'choices');
        return;
    }
    openAccountPanel('profile');
}

function onUserChange(user) {
    const firstCall = !state.authKnown;
    state.authKnown = true;
    state.user = user;
    // Red dot on « Profil » / « Mon compte »: only for unread salon messages (messagesCenter.js)
    refreshMessages();
    if ($('accountEmail')) $('accountEmail').textContent = user?.email ?? '';
    renderSummary();
    if (user) syncSoundPrefs(user);
    if (user && returnTo()) {
        // Came from the dashboard's sign-in button: go back there once signed in
        location.replace(returnTo());
        return;
    }
    if (user && state.confirmPending) {
        // Signed in by the confirmation link: say it, then show the account
        state.confirmPending = false;
        clearTimeout(state.confirmTimer);
        history.replaceState(null, '', cleanAuthUrl(location.pathname, location.search));
        hideAuthScreen();
        openAccount();
        setMessage('profileMessage', 'success', 'account.emailConfirmed');
        return;
    }
    if (user) {
        hideAuthScreen();
        loadMyBookings();
        loadLoyalty();
        loadProfile();
    } else if (state.confirmPending) {
        // The link carried a session that could not be restored
        confirmFailed();
    } else {
        state.bookings = [];
        state.loyalty = null;
        stopRescheduling();
        if ($('cancelDialog')?.open) $('cancelDialog').close();
        if ($('qrDialog')?.open) $('qrDialog').close();
        renderBookings();
        renderLoyalty();
        closePages();
        // First visit: welcome screen once (only when accounts can actually be used)
        // (not over the sign-in form already opened by a confirmation link)
        if (firstCall && returnTo()) showAuthScreen('signin');
        else if (firstCall && state.days !== null && !readPref(WELCOME_KEY) && $('authScreen')?.hidden)
            showAuthScreen('choices');
    }
}

// index.html?next=admin (the dashboard's "Se connecter" button). Only this page is accepted, so the
// parameter cannot send anyone to another site.
const RETURN_PAGES = { admin: 'admin.html' };
const returnTo = () => RETURN_PAGES[new URLSearchParams(location.search).get('next')] ?? null;

// Sound preferences: this browser vs. the account. The most recent explicit choice wins, and a sound
// turned off is never turned back on by the other side (see mergeSoundPrefs).
function syncSoundPrefs(user) {
    const remote = user.user_metadata?.sound_prefs ?? null;
    const local = getSoundPrefs();
    const merged = mergeSoundPrefs(local, remote);
    if (!samePrefs(merged, local)) adoptSoundPrefs(merged);
    if (merged.updatedAt && !samePrefs(merged, remote)) saveSoundPrefs(merged);
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

// --- Customer cancellation: a reason first, then an explicit confirmation ---
function initCancelDialog() {
    const dialog = $('cancelDialog');
    if (!dialog) return;
    const close = () => dialog.close();
    $('cancelCloseBtn').addEventListener('click', close);
    $('cancelKeep').addEventListener('click', close);
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) close();
    });
    $('cancelForm').addEventListener('change', renderCancelDialog);
    // Enter in a field does not cancel: only holding the button does
    $('cancelForm').addEventListener('submit', (e) => e.preventDefault());
    // "Hold to cancel": the appointment is cancelled only after the button is held for 1.2 s
    const hold = createHoldButton({
        ...cancelLabels(false),
        className: 'btn btn-danger',
        duration: 1200,
        canStart: validateCancel,
        onConfirm: confirmCancel,
    });
    hold.id = 'cancelSubmit';
    $('cancelSubmit').replaceWith(hold);
    $('rescheduleStart').addEventListener('click', startRescheduling);
    $('rescheduleAbort').addEventListener('click', () => {
        stopRescheduling();
        setMessage('bookingMessage', null);
    });
}

function openCancelDialog(booking) {
    state.cancelTarget = booking;
    $('cancelForm').reset();
    setMessage('cancelMessage', null);
    $('cancelSubmit').resetHold?.();
    renderCancelDialog();
    $('cancelDialog').showModal();
}

const selectedReason = () => $('cancelForm')?.querySelector('input[name="cancelReason"]:checked')?.value ?? null;
const canReschedule = (booking) => booking?.status === 'confirmed';

function renderCancelDialog() {
    const booking = state.cancelTarget;
    if (!booking || !$('cancelDialog')) return;
    const day = formatDateOf(booking.starts_at, state.lang);
    const time = formatTime(booking.starts_at);
    const names = booking.services ?? {};
    $('cancelSummary').textContent =
        `${day} · ${time} · ${(state.lang === 'ar' && names.name_ar) || names.name_fr || ''}`;
    const reason = selectedReason();
    // Details are optional for every reason, « Autre raison » included
    $('cancelDetailsLabel').textContent = t(state.lang, 'cancel.detailsOptional');
    const offer = reason === 'reschedule' && canReschedule(booking);
    $('rescheduleOffer').hidden = !offer;
    $('cancelWarning').textContent = t(state.lang, 'cancel.warning', { day, time });
    $('cancelSubmit').setLabels?.(cancelLabels(offer));
}

function cancelLabels(withoutNew) {
    return {
        label: t(state.lang, withoutNew ? 'cancel.holdWithoutNew' : 'cancel.hold'),
        holdingLabel: t(state.lang, 'cancel.holding'),
        busyLabel: t(state.lang, 'cancel.busy'),
        hint: t(state.lang, 'cancel.holdHint'),
    };
}

// Checked before the hold starts: a reason is required; the details are optional
function validateCancel() {
    if (!selectedReason()) {
        setMessage('cancelMessage', 'error', 'error.invalid_reason');
        return false;
    }
    setMessage('cancelMessage', null);
    return true;
}

// Runs once the hold is complete. Returns false on failure: nothing was cancelled, the button can be held again
async function confirmCancel() {
    const booking = state.cancelTarget;
    if (!booking || !validateCancel()) return false;
    const { error } = await cancelMyBooking(booking.id, selectedReason(), $('cancelDetails').value.trim());
    if (error) {
        setMessage('cancelMessage', 'error', errorKey(error));
        if (errorCode(error) === 'invalid_status') loadMyBookings(); // already cancelled elsewhere
        return false;
    }
    // Only now, confirmed by the database, is the slot free again
    $('cancelDialog').close();
    setMessage('accountMessage', 'success', 'account.cancelled');
    notifyStaffOfBooking(booking.id);
    loadMyBookings();
    loadSlots();
    return true;
}

// --- Rescheduling: the customer picks the new slot first; the old booking is cancelled only when the new one
// is confirmed, in one database transaction (reschedule_my_booking) ---
function startRescheduling() {
    const booking = state.cancelTarget;
    const service = state.services.find((s) => s.dbId === booking?.service_id);
    if (!booking || !isBookable(service)) {
        setMessage('cancelMessage', 'error', 'reschedule.notPossible');
        return;
    }
    state.rescheduling = { booking, details: $('cancelDetails').value.trim() };
    $('cancelDialog').close();
    closePages();
    state.serviceId = service.id;
    state.slot = null;
    state.autoAdvanceDay = true;
    setMessage('bookingMessage', null);
    renderServiceSelect();
    renderReschedule();
    loadSlots();
    // After overlays.js has put the page back where it was (windows just closed)
    setTimeout(() => $('booking')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
}

function stopRescheduling() {
    if (!state.rescheduling) return;
    state.rescheduling = null;
    renderReschedule();
    renderSummary();
}

function renderReschedule() {
    const banner = $('rescheduleBanner');
    if (!banner) return;
    const r = state.rescheduling;
    banner.hidden = !r;
    $('bookingService').disabled = Boolean(r); // same service: only the time changes
    if (r) {
        $('rescheduleText').textContent = t(state.lang, 'reschedule.bannerText', {
            day: formatDateOf(r.booking.starts_at, state.lang),
            time: formatTime(r.booking.starts_at),
        });
    }
}

async function submitReschedule(button) {
    const { booking, details } = state.rescheduling;
    button.disabled = true;
    const { data, error } = await rescheduleMyBooking(booking.id, state.slot.starts_at, details);
    button.disabled = false;
    if (error) {
        // Nothing changed in the database: the original appointment is still booked
        setMessage('bookingMessage', 'error', errorKey(error));
        if (errorCode(error) === 'slot_unavailable') loadSlots();
        return;
    }
    stopRescheduling();
    setMessage('bookingMessage', 'success', 'reschedule.success', {
        day: formatDateOf(data.starts_at, state.lang),
        time: formatTime(data.starts_at),
    });
    notifyStaffOfBooking(booking.id);
    state.slot = null;
    loadSlots();
    loadMyBookings();
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
                cancel.addEventListener('click', () => openCancelDialog(booking));
                actions.append(cancel);
            }
            item.append(info, actions);
            return item;
        }),
    );
}

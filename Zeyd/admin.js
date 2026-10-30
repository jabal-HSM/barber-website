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

// --- Home: earnings card, today, notifications ---
loaders.home = async () => {
    const sb = state.supabase;
    const today = todayInParis();
    const [{ data: earnings }, { data: notifications }, { data: todays }] = await Promise.all([
        sb.rpc('barber_earnings'),
        sb
            .from('staff_notifications')
            .select('id, amount_cents, livemode, created_at, read_at')
            .order('created_at', { ascending: false })
            .limit(20),
        sb
            .from('bookings')
            .select('starts_at, profiles:customer_id (full_name)')
            .in('status', ['confirmed', 'requested'])
            .gte('starts_at', parisLocalToIso(`${today}T00:00`))
            .lt('starts_at', parisLocalToIso(`${nextDay(today)}T00:00`))
            .order('starts_at'),
    ]);

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

    const upcoming = (todays ?? []).filter((b) => new Date(b.starts_at) >= new Date());
    const summary = [at(state.lang, 'home.todayCount', { count: todays?.length ?? 0 })];
    if (upcoming[0]) {
        summary.push(
            at(state.lang, 'home.next', {
                time: formatTime(upcoming[0].starts_at),
                name: upcoming[0].profiles?.full_name || '—',
            }),
        );
    }
    $('todaySummary').textContent = summary.join(' · ');

    const list = $('notificationList');
    if (!notifications?.length) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'home.noNotifications')));
        return;
    }
    list.replaceChildren(
        ...notifications.map((n) => {
            const item = el('li', `admin-item notification${n.read_at ? '' : ' is-unread'}`);
            const text = el('div');
            const title = el(
                'p',
                'admin-item-title',
                at(state.lang, 'home.paymentReceived', { amount: euros.format(n.amount_cents / 100) }),
            );
            if (!n.livemode)
                title.append(' ', el('span', 'status-badge is-requested', at(state.lang, 'home.testBadge')));
            text.append(
                title,
                el('p', 'admin-item-meta', `${formatDateOf(n.created_at, state.lang)} · ${formatTime(n.created_at)}`),
            );
            item.append(text);
            if (!n.read_at) {
                item.append(
                    button(at(state.lang, 'home.markRead'), 'btn btn-ghost btn-sm', async () => {
                        await state.supabase
                            .from('staff_notifications')
                            .update({ read_at: new Date().toISOString() })
                            .eq('id', n.id);
                        loaders.home();
                    }),
                );
            }
            return item;
        }),
    );
};

// --- Bookings of a day ---
function initBookings() {
    $('bookingsDay').value = todayInParis();
    $('bookingsDay').addEventListener('change', () => loaders.bookings());
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
    const day = $('bookingsDay').value || todayInParis();
    const list = $('bookingsList');
    list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'common.loading')));
    const { data, error } = await state.supabase
        .from('bookings')
        .select(
            'id, starts_at, ends_at, status, is_custom_request, customer_note, cancel_reason, profiles:customer_id (full_name, email), services (name_fr, name_ar)',
        )
        .gte('starts_at', parisLocalToIso(`${day}T00:00`))
        .lt('starts_at', parisLocalToIso(`${nextDay(day)}T00:00`))
        .order('starts_at');
    if (error) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'common.error')));
        return;
    }
    if (!data.length) {
        list.replaceChildren(el('li', 'admin-empty', at(state.lang, 'bookings.empty')));
        return;
    }
    list.replaceChildren(
        ...data.map((b) => {
            const item = el('li', `admin-item booking-item is-${b.status}`);
            const info = el('div', 'admin-item-body');
            const when = el(
                'p',
                'admin-item-title',
                `${formatTime(b.starts_at)}${b.ends_at ? ` – ${formatTime(b.ends_at)}` : ''}`,
            );
            when.dir = 'ltr';
            const service = (state.lang === 'ar' && b.services?.name_ar) || b.services?.name_fr || '';
            info.append(
                when,
                el('p', '', `${b.profiles?.full_name || '—'} · ${service}`),
                el('p', 'admin-item-meta', b.profiles?.email ?? ''),
            );
            const badges = el('p');
            badges.append(el('span', `status-badge is-${b.status}`, at(state.lang, `status.${b.status}`)));
            if (b.is_custom_request)
                badges.append(' ', el('span', 'status-badge is-requested', at(state.lang, 'bookings.custom')));
            info.append(badges);
            if (b.customer_note)
                info.append(el('p', 'admin-item-meta', at(state.lang, 'bookings.note', { note: b.customer_note })));

            const actions = el('div', 'admin-row admin-actions');
            const setStatus = (status) => async () => {
                const { error: err } = await state.supabase.rpc('set_booking_status', {
                    p_booking_id: b.id,
                    p_status: status,
                });
                if (err) setMessage('bookingsMessage', 'error', errorKey(err));
                loaders.bookings();
            };
            if (b.status === 'requested')
                actions.append(
                    button(at(state.lang, 'bookings.confirm'), 'btn btn-primary btn-sm', setStatus('confirmed')),
                );
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
            item.append(info, actions);
            return item;
        }),
    );
};

// --- Loyalty: scan a customer's QR code, confirm the visit ---
function initLoyalty() {
    $('scanBtn').addEventListener('click', () => (state.scanStream ? stopScan() : startScan()));
    $('codeForm').addEventListener('submit', (e) => {
        e.preventDefault();
        lookup($('codeInput').value);
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
    body.append(
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
    result.replaceChildren(body);
    result.hidden = false;
}

loaders.loyalty = () => {
    // The scanner starts only on demand (camera permission)
};

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
        .select('id, name_fr, name_ar, price, duration_minutes, is_active')
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
            const price = input('number', s.price, { min: '0', step: '0.5', inputmode: 'decimal' });
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
                    (durationValue !== null && !(Number.isInteger(durationValue) && durationValue > 0))
                ) {
                    setMessage('servicesMessage', 'error', 'error.validation');
                    return;
                }
                const { error: err } = await state.supabase
                    .from('services')
                    .update({
                        name_fr: nameFr.value.trim(),
                        name_ar: nameAr.value.trim(),
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
                }),
                button(at(state.lang, 'hours.remove'), 'btn btn-ghost btn-sm', async () => {
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
                    await sb.from('closures').delete().eq('id', c.id);
                    loaders.hours();
                }),
            );
            return item;
        }),
    );
};

// --- Gallery: photos are resized in the browser before upload (fast pages on phones) ---
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
            setMessage('galleryMessage', 'error', 'error.validation');
            return;
        }
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
            caption.append(
                el('p', 'admin-item-title', (state.lang === 'ar' && photo.title_ar) || photo.title_fr || '—'),
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
            side.append(select);
            item.append(info, side);
            return item;
        }),
    );
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

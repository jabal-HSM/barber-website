// Loyalty card: 10 circles (the 10th is the free cut) and the customer's QR code.
// The card only displays what the database says; stamps are added by the barber in the dashboard.
import { t } from './i18n.js';

export const QR_PREFIX = 'ZEYD-LOYALTY:';
const QR_LIBRARY = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';

// Static drawing of a black gift box (no user data inside)
const GIFT_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true" class="lc-gift">
    <path d="M16 9.5c-1.6-3.6-6.4-4.4-6.4-1.4 0 2 3.1 1.9 6.4 1.4Z" fill="none" stroke="#141414" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M16 9.5c1.6-3.6 6.4-4.4 6.4-1.4 0 2-3.1 1.9-6.4 1.4Z" fill="none" stroke="#141414" stroke-width="1.6" stroke-linejoin="round"/>
    <rect x="6.5" y="10" width="19" height="5" rx="1.2" fill="#141414"/>
    <rect x="8" y="15" width="16" height="11" rx="1.2" fill="#1f1f1f"/>
    <rect x="14.6" y="10" width="2.8" height="16" fill="#d9c7a8"/>
    <rect x="8" y="15" width="16" height="1.2" fill="#000" opacity=".35"/>
</svg>`;

// Static drawing of open scissors: shown instead of the gift once the 10 visits are reached (free cut earned)
const SCISSORS_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true" class="lc-gift lc-scissors">
    <g fill="none" stroke="#141414" stroke-width="1.9" stroke-linecap="round">
        <circle cx="10" cy="23.5" r="4"/>
        <circle cx="22" cy="23.5" r="4"/>
        <path d="M12.7 20.6 22.6 4.5"/>
        <path d="M19.3 20.6 9.4 4.5"/>
    </g>
    <circle cx="16" cy="15.2" r="1.3" fill="#fff3e2"/>
</svg>`;

// How many circles to fill. After the 10th stamp the card stays full (gift highlighted)
// while the reward is waiting to be used.
export function filledCount(stampsTotal, availableRewards) {
    const progress = stampsTotal % 10;
    return progress === 0 && stampsTotal > 0 && availableRewards > 0 ? 10 : progress;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// Brand block: the scissors-Z monogram (logo-mark-ink.png, cut from logozeyd.jpeg) + ZEYD / BARBER
function brandBlock() {
    const logo = el('div', 'lc-logo');
    logo.lang = 'en';
    logo.dir = 'ltr';
    const mark = el('img', 'lc-mark');
    mark.src = 'logo-mark-ink.png';
    mark.alt = '';
    mark.width = 234;
    mark.height = 396;
    logo.append(mark, el('span', 'lc-logo-name', 'ZEYD'), el('span', 'lc-logo-sub', 'BARBER'));
    return logo;
}

export function renderLoyaltyCard(container, card, lang) {
    const filled = filledCount(card.stamps_total, card.available_rewards);
    const root = el('div', `lc${filled === 10 ? ' is-complete' : ''}`);

    // Top stripe: two slanted purple bars, like the foil band of a membership card
    const stripe = el('div', 'lc-stripe');
    stripe.setAttribute('aria-hidden', 'true');
    stripe.append(el('span', 'lc-bar'), el('span', 'lc-bar'));

    const title = el('div', 'lc-title');
    const english = el('span', 'lc-title-en', 'Loyalty card');
    english.lang = 'en';
    title.append(el('span', 'lc-title-main', t(lang, 'loyalty.cardLabel')), english);

    const identity = el('div', 'lc-identity');
    const name = el('p', 'lc-name', card.full_name || '—');
    name.dir = 'auto';
    identity.append(name, el('p', 'lc-member', t(lang, 'loyalty.member')));

    const stamps = el('ol', 'lc-stamps');
    for (let n = 1; n <= 10; n += 1) {
        const done = n <= filled;
        const stamp = el('li', `lc-stamp${done ? ' is-filled' : ''}${n === 10 ? ' is-reward' : ''}`);
        if (n === 10) {
            stamp.innerHTML = filled === 10 ? SCISSORS_SVG : GIFT_SVG;
            stamp.setAttribute('aria-label', t(lang, 'loyalty.rewardStamp'));
        } else {
            const num = el('span', 'lc-num', String(n));
            num.setAttribute('aria-hidden', 'true');
            stamp.append(num);
            stamp.setAttribute(
                'aria-label',
                t(lang, 'loyalty.stamp', { n, state: t(lang, done ? 'loyalty.stampDone' : 'loyalty.stampTodo') }),
            );
        }
        stamps.append(stamp);
    }

    const offer = el('p', 'lc-offer', t(lang, 'loyalty.offer'));

    const foot = el('div', 'lc-foot');
    const count = el('span', 'lc-count', `${filled}/10`);
    count.dir = 'ltr';
    foot.append(el('span', 'lc-slogan', t(lang, 'auth.tagline')), count);

    root.append(stripe, brandBlock(), title, identity, stamps, offer, foot);
    if (filled === 10) root.append(el('p', 'lc-reward-badge', t(lang, 'loyalty.rewardTitle')));
    container.replaceChildren(root);
    return filled;
}

let libraryPromise = null;
function loadQrLibrary() {
    libraryPromise ??= new Promise((resolve, reject) => {
        if (window.qrcode) {
            resolve(window.qrcode);
            return;
        }
        const script = document.createElement('script');
        script.src = QR_LIBRARY;
        script.async = true;
        script.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('qr_library')));
        script.onerror = () => reject(new Error('qr_library'));
        document.head.append(script);
    });
    return libraryPromise;
}

// Draws the QR code of the card token. Returns false when the library cannot be loaded.
export async function renderQrCode(container, token) {
    try {
        const qrcode = await loadQrLibrary();
        const qr = qrcode(0, 'M');
        qr.addData(`${QR_PREFIX}${token}`);
        qr.make();
        // Generated from a UUID only: safe to insert as markup
        container.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
        container.querySelector('svg')?.setAttribute('role', 'img');
        return true;
    } catch {
        container.replaceChildren();
        return false;
    }
}

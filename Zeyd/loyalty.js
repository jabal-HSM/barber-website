// Loyalty card: 10 circles (the 10th is the free cut) and the customer's QR code.
// The card only displays what the database says; stamps are added by the barber in the dashboard.
import { t } from './i18n.js';

export const QR_PREFIX = 'ZEYD-LOYALTY:';
const QR_LIBRARY = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Static drawing of a black gift box (no user data inside)
const GIFT_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true" class="lc-gift">
    <path d="M16 9.5c-1.6-3.6-6.4-4.4-6.4-1.4 0 2 3.1 1.9 6.4 1.4Z" fill="none" stroke="#141414" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M16 9.5c1.6-3.6 6.4-4.4 6.4-1.4 0 2-3.1 1.9-6.4 1.4Z" fill="none" stroke="#141414" stroke-width="1.6" stroke-linejoin="round"/>
    <rect x="6.5" y="10" width="19" height="5" rx="1.2" fill="#141414"/>
    <rect x="8" y="15" width="16" height="11" rx="1.2" fill="#1f1f1f"/>
    <rect x="14.6" y="10" width="2.8" height="16" fill="#d9c7a8"/>
    <rect x="8" y="15" width="16" height="1.2" fill="#000" opacity=".35"/>
</svg>`;

// How many circles to fill. After the 10th stamp the card stays full (gift highlighted)
// while the reward is waiting to be used.
export function filledCount(stampsTotal, availableRewards) {
    const progress = stampsTotal % 10;
    return progress === 0 && stampsTotal > 0 && availableRewards > 0 ? 10 : progress;
}

export function renderLoyaltyCard(container, card, lang) {
    const filled = filledCount(card.stamps_total, card.available_rewards);
    const root = document.createElement('div');
    root.className = `lc${filled === 10 ? ' is-complete' : ''}`;

    const stripe = document.createElement('div');
    stripe.className = 'lc-stripe';

    const head = document.createElement('div');
    head.className = 'lc-head';
    const brand = document.createElement('span');
    brand.className = 'lc-brand';
    brand.lang = 'en';
    brand.dir = 'ltr';
    brand.textContent = 'ZEYD BARBER';
    const label = document.createElement('span');
    label.className = 'lc-label';
    label.textContent = t(lang, 'loyalty.cardLabel');
    head.append(brand, label);

    const name = document.createElement('p');
    name.className = 'lc-name';
    name.textContent = card.full_name || '—';

    const stamps = document.createElement('ol');
    stamps.className = 'lc-stamps';
    for (let n = 1; n <= 10; n += 1) {
        const stamp = document.createElement('li');
        const done = n <= filled;
        stamp.className = `lc-stamp${done ? ' is-filled' : ''}${n === 10 ? ' is-reward' : ''}`;
        if (n === 10) {
            stamp.innerHTML = GIFT_SVG;
            stamp.setAttribute('aria-label', t(lang, 'loyalty.rewardStamp'));
        } else {
            const icon = document.createElementNS(SVG_NS, 'svg');
            icon.setAttribute('class', 'icon');
            icon.setAttribute('aria-hidden', 'true');
            const use = document.createElementNS(SVG_NS, 'use');
            use.setAttribute('href', '#i-scissors');
            icon.append(use);
            stamp.append(icon);
            stamp.setAttribute(
                'aria-label',
                t(lang, 'loyalty.stamp', { n, state: t(lang, done ? 'loyalty.stampDone' : 'loyalty.stampTodo') }),
            );
        }
        stamps.append(stamp);
    }

    const foot = document.createElement('div');
    foot.className = 'lc-foot';
    const code = document.createElement('span');
    code.dir = 'ltr';
    code.textContent = `N° ${card.short_code}`;
    const count = document.createElement('span');
    count.dir = 'ltr';
    count.textContent = `${filled}/10`;
    foot.append(code, count);

    root.append(stripe, head, name, stamps, foot);
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

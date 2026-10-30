import { fetchGallery, fetchServices } from './api.js';
import { initBooking, selectBookingService, setBookingLanguage, setBookingServices } from './booking.js';
import { GALLERY, SERVICES } from './data.js';
import { DEFAULT_LANG, LANGUAGES, t } from './i18n.js';

// Same storage keys as the previous version, so saved preferences are kept.
const STORAGE_KEYS = { lang: 'lang', theme: 'theme' };
const WHATSAPP_URL = 'https://wa.me/qr/CMYWVONTY3QNG1';
const DESKTOP_NAV_QUERY = window.matchMedia('(min-width: 64em)');

// Prices are always shown in euros, French format ("15 €"), in both languages.
const priceFormatter = new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
});

const root = document.documentElement;
let currentLang = DEFAULT_LANG;
// Built-in content first; replaced by the database content when a backend is configured (config.js).
let services = SERVICES;
let gallery = GALLERY;

// localStorage can throw (private mode, blocked storage): preferences are then simply not saved.
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
        // Ignore: the choice still applies for this visit.
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initLanguage();
    initMenu();
    renderHeroFacts();
    document.getElementById('currentYear').textContent = String(new Date().getFullYear());
    initBooking({ lang: currentLang, services, priceFormatter });
    loadRemoteContent();
});

async function loadRemoteContent() {
    const [remoteServices, remoteGallery] = await Promise.all([fetchServices(), fetchGallery()]);
    if (remoteServices) {
        services = remoteServices;
        renderServices();
        renderHeroFacts();
        setBookingServices(services);
    }
    if (remoteGallery) {
        gallery = remoteGallery;
        renderGallery();
    }
}

// --- Language ---
function initLanguage() {
    const saved = readPref(STORAGE_KEYS.lang);
    applyLanguage(saved in LANGUAGES ? saved : DEFAULT_LANG);

    document.querySelectorAll('[data-lang]').forEach((btn) => {
        btn.addEventListener('click', () => {
            applyLanguage(btn.dataset.lang);
            writePref(STORAGE_KEYS.lang, currentLang);
        });
    });
}

function applyLanguage(lang) {
    currentLang = lang;
    root.lang = lang;
    root.dir = LANGUAGES[lang].dir;

    document.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = t(lang, el.dataset.i18n);
    });

    // data-i18n-attr="aria-label:a11y.home; alt:hero.photoAlt"
    document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
        for (const pair of el.dataset.i18nAttr.split(';')) {
            const [attr, key] = pair.split(':').map((part) => part.trim());
            if (attr && key) el.setAttribute(attr, t(lang, key));
        }
    });

    document.title = t(lang, 'meta.title');
    document.querySelector('meta[name="description"]')?.setAttribute('content', t(lang, 'meta.description'));

    document.querySelectorAll('[data-lang]').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
    });

    renderServices();
    renderGallery();
    setBookingLanguage(lang);
    updateThemeButton();
    updateMenuButton();
}

// --- Theme (light by default) ---
function initTheme() {
    const saved = readPref(STORAGE_KEYS.theme);
    setTheme(saved === 'dark' ? 'dark' : 'light');

    document.getElementById('themeToggleBtn')?.addEventListener('click', () => {
        setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
        writePref(STORAGE_KEYS.theme, root.dataset.theme);
    });
}

function setTheme(theme) {
    // Switch every colour at once: hover transitions must not fade text over an already-changed background.
    root.classList.add('is-theme-switching');
    root.dataset.theme = theme;
    const themeColor = getComputedStyle(root).getPropertyValue('--color-bg').trim();
    root.classList.remove('is-theme-switching');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
    updateThemeButton();
}

function updateThemeButton() {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    const isDark = root.dataset.theme === 'dark';
    const label = t(currentLang, isDark ? 'a11y.themeToLight' : 'a11y.themeToDark');
    btn.setAttribute('aria-pressed', String(isDark));
    btn.setAttribute('aria-label', label);
    btn.title = label;
}

// --- Mobile menu ---
function initMenu() {
    const header = document.getElementById('siteHeader');
    const toggle = document.getElementById('menuToggleBtn');
    if (!header || !toggle) return;

    toggle.addEventListener('click', () => setMenuOpen(!header.classList.contains('is-menu-open')));

    // Close after choosing a link, on Escape, on a click outside, or when the desktop nav takes over.
    document.getElementById('siteNav')?.addEventListener('click', (e) => {
        if (e.target.closest('a')) setMenuOpen(false);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && header.classList.contains('is-menu-open')) {
            setMenuOpen(false);
            toggle.focus();
        }
    });
    document.addEventListener('click', (e) => {
        if (!header.contains(e.target)) setMenuOpen(false);
    });
    DESKTOP_NAV_QUERY.addEventListener('change', () => setMenuOpen(false));
}

function setMenuOpen(open) {
    document.getElementById('siteHeader')?.classList.toggle('is-menu-open', open);
    updateMenuButton();
}

function updateMenuButton() {
    const toggle = document.getElementById('menuToggleBtn');
    if (!toggle) return;
    const open = document.getElementById('siteHeader').classList.contains('is-menu-open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', t(currentLang, open ? 'a11y.closeMenu' : 'a11y.openMenu'));
}

// --- Services ---
function formatDuration(minutes) {
    return minutes ? t(currentLang, 'services.duration', { min: minutes }) : t(currentLang, 'services.durationUnknown');
}

function renderServices() {
    const list = document.getElementById('servicesList');
    const template = document.getElementById('serviceCardTemplate');
    if (!list || !template) return;

    const cards = services.map((service) => {
        const card = template.content.firstElementChild.cloneNode(true);
        const name = service.name[currentLang] ?? service.name.fr;

        card.dataset.serviceId = service.id;
        card.querySelector('.service-name').textContent = name;
        card.querySelector('.service-desc').textContent = service.description[currentLang] ?? service.description.fr;
        card.querySelector('.service-price').textContent = priceFormatter.format(service.price);

        const duration = card.querySelector('.service-duration-text');
        duration.textContent = formatDuration(service.durationMinutes);
        card.querySelector('.service-duration').title = t(currentLang, 'services.durationLabel');

        // In Arabic, keep the salon's French service name visible as a reference.
        const original = card.querySelector('.service-original');
        original.textContent = currentLang === 'fr' ? '' : service.name.fr;
        original.hidden = currentLang === 'fr';

        // Bookable online (known duration, from the database) -> booking form; otherwise WhatsApp.
        const link = card.querySelector('.service-link');
        const bookable = Boolean(service.dbId && service.durationMinutes);
        if (bookable) {
            link.href = '#booking';
            link.removeAttribute('target');
            link.removeAttribute('rel');
            link.addEventListener('click', () => selectBookingService(service.id));
        } else {
            link.href = WHATSAPP_URL;
        }
        link.querySelector('use').setAttribute('href', bookable ? '#i-calendar' : '#i-whatsapp');
        link.querySelector('.service-link-text').textContent = t(
            currentLang,
            bookable ? 'services.bookLink' : 'services.whatsappLink',
        );
        link.setAttribute(
            'aria-label',
            t(currentLang, bookable ? 'services.bookLinkAria' : 'services.whatsappLinkAria', { name }),
        );
        return card;
    });

    list.replaceChildren(...cards);
}

function renderHeroFacts() {
    const minPrice = Math.min(...services.map((s) => s.price));
    document.getElementById('factMinPrice').textContent = priceFormatter.format(minPrice);
    document.getElementById('factServiceCount').textContent = String(services.length);
}

// --- Gallery: shows real photos once there are some, otherwise the empty state ---
function renderGallery() {
    const grid = document.getElementById('galleryGrid');
    const empty = document.getElementById('galleryEmpty');
    if (!grid || !empty) return;

    const hasPhotos = gallery.length > 0;
    grid.hidden = !hasPhotos;
    empty.hidden = hasPhotos;
    if (!hasPhotos) return;

    const items = gallery.map((photo) => {
        const figure = document.createElement('figure');
        figure.className = 'gallery-item';
        if (photo.category) figure.dataset.category = photo.category;

        const img = document.createElement('img');
        img.src = photo.src;
        img.alt = photo.alt?.[currentLang] ?? photo.alt?.fr ?? '';
        img.loading = 'lazy';
        img.decoding = 'async';
        figure.append(img);
        return figure;
    });
    grid.replaceChildren(...items);
}

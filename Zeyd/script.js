import { fetchGallery, fetchServices, likeHaircut, onAuthChange, unlikeHaircut } from './api.js';
import {
    initBooking,
    openAccountPanel,
    selectBookingService,
    setBookingLanguage,
    setBookingServices,
} from './booking.js';
import { initBottomNav } from './bottomNav.js';
import { MIN_QUERY_LENGTH, searchCatalog } from './catalogSearch.js';
import { GALLERY, SERVICES } from './data.js';
import { DEFAULT_LANG, LANGUAGES, t } from './i18n.js';
import { closePages, initOverlays } from './overlays.js';
import { initSound, playThemeSound } from './sound.js';

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
let signedIn = false;
let bottomNav = null;

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
    initOverlays();
    initTheme();
    initLanguage();
    initMenu();
    initSound();
    renderHeroFacts();
    document.getElementById('currentYear').textContent = String(new Date().getFullYear());
    initBooking({ lang: currentLang, services, priceFormatter });
    initBottomBar();
    loadRemoteContent();
    // The gallery says which photos the signed-in customer likes: reload it when that person changes
    onAuthChange((user) => {
        if (Boolean(user) === signedIn) return;
        signedIn = Boolean(user);
        reloadGallery();
    });
});

async function reloadGallery() {
    const remoteGallery = await fetchGallery();
    if (!remoteGallery) return;
    gallery = remoteGallery;
    renderGallery();
    renderFavorites();
    renderSearch();
}

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
    renderFavorites();
    renderSearch();
    setBookingLanguage(lang);
    updateThemeButton();
    updateMenuButton();
    bottomNav?.refresh(); // the tab order follows the reading direction
}

// --- Theme (light by default) ---
function initTheme() {
    const saved = readPref(STORAGE_KEYS.theme);
    setTheme(saved === 'dark' ? 'dark' : 'light');

    document.getElementById('themeToggleBtn')?.addEventListener('click', () => {
        const before = root.dataset.theme;
        setTheme(before === 'dark' ? 'light' : 'dark');
        writePref(STORAGE_KEYS.theme, root.dataset.theme);
        // Only a deliberate, real change makes the "switch" sound (never the theme restored at load)
        if (root.dataset.theme !== before) playThemeSound();
    });
    // Same choice from « Profil » (switch « Mode sombre »)
    for (const input of document.querySelectorAll('[data-theme-switch]')) {
        input.addEventListener('change', () => {
            setTheme(input.checked ? 'dark' : 'light');
            writePref(STORAGE_KEYS.theme, root.dataset.theme);
            playThemeSound();
        });
    }
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
    const isDark = root.dataset.theme === 'dark';
    for (const input of document.querySelectorAll('[data-theme-switch]')) input.checked = isDark;
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
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

        figure.append(photoImage(photo), favoriteButton(photo));
        return figure;
    });
    grid.replaceChildren(...items);
}

function photoImage(photo) {
    const img = document.createElement('img');
    img.src = photo.src;
    img.alt = photo.alt?.[currentLang] ?? photo.alt?.fr ?? '';
    img.loading = 'lazy';
    img.decoding = 'async';
    return img;
}

function svgIcon(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', id);
    svg.append(use);
    return svg;
}

// --- Favourites (haircut_likes: one like per customer and published photo, enforced by the database) ---
function favoriteButton(photo) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fav-btn';
    btn.setAttribute('aria-pressed', String(photo.likedByMe));
    btn.setAttribute('aria-label', t(currentLang, photo.likedByMe ? 'favorites.remove' : 'favorites.add'));
    btn.append(svgIcon('#i-heart'));
    btn.addEventListener('click', () => toggleFavorite(photo, btn));
    return btn;
}

// The heart changes only once the database has accepted the change
async function toggleFavorite(photo, btn) {
    if (!signedIn) {
        closeSheets();
        openAccountPanel('profile');
        return;
    }
    btn.disabled = true;
    hideSheetErrors();
    const { error } = photo.likedByMe ? await unlikeHaircut(photo.id) : await likeHaircut(photo.id);
    btn.disabled = false;
    if (error) {
        showSheetError(btn, 'favorites.error');
        return;
    }
    photo.likedByMe = !photo.likedByMe;
    photo.likeCount += photo.likedByMe ? 1 : -1;
    renderGallery();
    renderFavorites();
    renderSearch();
}

function hideSheetErrors() {
    for (const box of document.querySelectorAll('.sheet-error, #galleryError')) box.hidden = true;
}

function showSheetError(btn, key) {
    const box = btn.closest('dialog')?.querySelector('.sheet-error') ?? document.getElementById('galleryError');
    if (!box) return;
    box.textContent = t(currentLang, key);
    box.hidden = false;
}

function emptyState(textKey, action) {
    const box = document.createElement('div');
    box.className = 'sheet-empty';
    const art = document.createElement('div');
    art.className = 'sheet-empty-art';
    art.append(svgIcon('#i-heart'));
    const text = document.createElement('p');
    text.textContent = t(currentLang, textKey);
    box.append(art, text);
    if (action) box.append(action);
    return box;
}

function sheetButton(labelKey, className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = t(currentLang, labelKey);
    btn.addEventListener('click', onClick);
    return btn;
}

function photoGrid(photos) {
    const grid = document.createElement('div');
    grid.className = 'sheet-photos';
    for (const photo of photos) {
        const figure = document.createElement('figure');
        figure.className = 'gallery-item';
        figure.append(photoImage(photo), favoriteButton(photo));
        grid.append(figure);
    }
    return grid;
}

function goToGallery() {
    closeSheets();
    document.getElementById('gallery')?.scrollIntoView({ behavior: 'smooth' });
}

function renderFavorites() {
    const body = document.getElementById('favoritesBody');
    if (!body) return;
    if (!signedIn) {
        body.replaceChildren(
            emptyState(
                'favorites.signIn',
                sheetButton('favorites.signInBtn', 'btn btn-primary btn-sm', () => {
                    closeSheets();
                    openAccountPanel('profile');
                }),
            ),
        );
        return;
    }
    if (!gallery.length) {
        body.replaceChildren(emptyState('favorites.noPhotos'));
        return;
    }
    const liked = gallery.filter((photo) => photo.likedByMe);
    body.replaceChildren(
        liked.length
            ? photoGrid(liked)
            : emptyState('favorites.empty', sheetButton('favorites.toGallery', 'btn btn-ghost btn-sm', goToGallery)),
    );
}

// --- Search (services and published photos the page already has) ---
function renderSearch() {
    const results = document.getElementById('searchResults');
    const input = document.getElementById('searchInput');
    if (!results || !input) return;
    const query = input.value.trim();
    const hint = (key, params) => {
        const p = document.createElement('p');
        p.className = 'field-hint sheet-hint';
        p.textContent = t(currentLang, key, params);
        return p;
    };
    if (query.length < MIN_QUERY_LENGTH) {
        results.replaceChildren(hint('search.hint'));
        return;
    }
    const found = searchCatalog(query, { services, gallery });
    if (!found.services.length && !found.photos.length) {
        results.replaceChildren(
            hint('search.none', { q: query }),
            ...(gallery.length ? [] : [hint('search.noPhotos')]),
        );
        return;
    }
    const parts = [];
    if (found.services.length) {
        const title = document.createElement('h3');
        title.className = 'account-subtitle';
        title.textContent = t(currentLang, 'search.services');
        const list = document.createElement('ul');
        list.className = 'search-services';
        list.append(...found.services.map(searchServiceItem));
        parts.push(title, list);
    }
    if (found.photos.length) {
        const title = document.createElement('h3');
        title.className = 'account-subtitle';
        title.textContent = t(currentLang, 'search.photos');
        parts.push(title, photoGrid(found.photos));
    } else if (!gallery.length) {
        parts.push(hint('search.noPhotos'));
    }
    results.replaceChildren(...parts);
}

function searchServiceItem(service) {
    const item = document.createElement('li');
    item.className = 'search-service';
    const text = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'search-service-name';
    name.textContent = service.name[currentLang] ?? service.name.fr;
    const meta = document.createElement('p');
    meta.className = 'search-service-meta';
    // The price is isolated (FSI … PDI) so « 15 € » keeps its order inside an Arabic line
    meta.textContent = `⁨${priceFormatter.format(service.price)}⁩ · ${formatDuration(service.durationMinutes)}`;
    text.append(name, meta);
    item.append(text);
    if (service.dbId && service.durationMinutes) {
        item.append(
            sheetButton('search.book', 'btn btn-primary btn-sm', () => {
                closeSheets();
                selectBookingService(service.id);
                document.getElementById('booking')?.scrollIntoView({ behavior: 'smooth' });
            }),
        );
    } else {
        const link = document.createElement('a');
        link.className = 'btn btn-ghost btn-sm';
        link.href = WHATSAPP_URL;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = t(currentLang, 'services.whatsappLink');
        item.append(link);
    }
    return item;
}

// --- Bottom bar (phones) ---
const SHEETS = ['favoritesDialog', 'searchDialog'];

function closeSheets() {
    for (const id of SHEETS) {
        const dialog = document.getElementById(id);
        if (dialog?.open) dialog.close();
    }
}

function openSheet(id) {
    closeSheets();
    const dialog = document.getElementById(id);
    if (!dialog) return;
    if (id === 'favoritesDialog') renderFavorites();
    if (id === 'searchDialog') renderSearch();
    dialog.showModal();
    if (id === 'searchDialog') document.getElementById('searchInput')?.focus();
}

function initBottomBar() {
    bottomNav = initBottomNav({
        onSelect: (tab) => {
            if (tab === 'home') {
                closeSheets();
                closePages();
                // After overlays.js has put the page back where it was
                setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 0);
            } else if (tab === 'profile' || tab === 'bookings') {
                closeSheets();
                openAccountPanel(tab);
            } else if (tab === 'favorites') {
                closePages();
                openSheet('favoritesDialog');
            } else if (tab === 'search') {
                closePages();
                openSheet('searchDialog');
            }
        },
    });
    const backHome = () => bottomNav?.select('home');
    // A sheet or a page closed (button, back button, Escape): back to « Accueil », unless another one is open
    const anyOpen = () =>
        SHEETS.some((id) => document.getElementById(id)?.open) ||
        ['profilePage', 'bookingsPage'].some((id) => document.getElementById(id)?.hidden === false);
    for (const id of ['profilePage', 'bookingsPage']) {
        document.getElementById(id)?.addEventListener('layer:close', () => {
            if (!anyOpen()) backHome();
        });
    }
    for (const id of SHEETS) {
        const dialog = document.getElementById(id);
        dialog?.addEventListener('close', () => {
            if (!anyOpen()) backHome();
        });
        // Click on the backdrop closes the sheet
        dialog?.addEventListener('click', (e) => {
            if (e.target === dialog && SHEETS.includes(id)) dialog.close();
        });
    }
    for (const btn of document.querySelectorAll('[data-close-dialog]')) {
        btn.addEventListener('click', () => btn.closest('dialog')?.close());
    }
    // Signed out, « Profil » and « Mes RDV » open the welcome screen: back to « Accueil » when it closes
    const authScreen = document.getElementById('authScreen');
    if (authScreen) {
        new MutationObserver(() => {
            if (authScreen.hidden && !anyOpen()) backHome();
        }).observe(authScreen, { attributes: true, attributeFilter: ['hidden'] });
    }
    document.getElementById('searchForm')?.addEventListener('submit', (e) => e.preventDefault());
    document.getElementById('searchInput')?.addEventListener('input', renderSearch);
}

// Everything that covers the page — <dialog> windows, the full-screen « Profil », « Favoris » and « Mes RDV » pages, the
// welcome screen — goes through here:
//   * the page behind cannot scroll while one is open, and comes back to the same place when the last closes;
//   * the phone's back button (and Escape for the pages) closes the top one instead of leaving the site;
//   * a « layer:close » event is sent on the element when it closes, for the bottom bar.
// Layers are detected from their state (dialog[open], [hidden]), so the existing code that opens them is unchanged.

const PAGE_IDS = ['profilePage', 'bookingsPage', 'favoritesPage'];
const layers = []; // open layers, last = on top
let savedY = 0;
let ownEntry = false; // one history entry stands for « something is open »
let ignorePop = 0;

const isOpen = (el) => (el.tagName === 'DIALOG' ? el.open : !el.hidden);
const isPage = (el) => PAGE_IDS.includes(el.id);

function lockScroll() {
    savedY = window.scrollY;
    const s = document.body.style;
    s.position = 'fixed';
    s.top = `-${savedY}px`;
    s.left = '0';
    s.right = '0';
    document.documentElement.classList.add('is-scroll-locked');
}

function unlockScroll() {
    const s = document.body.style;
    s.position = '';
    s.top = '';
    s.left = '';
    s.right = '';
    document.documentElement.classList.remove('is-scroll-locked');
    // Tells sound.js this jump is not a scroll by the person (no tick)
    window.dispatchEvent(new Event('zeyd:scroll-restore'));
    window.scrollTo({ top: savedY, behavior: 'instant' });
}

function update(el) {
    const open = isOpen(el);
    const index = layers.indexOf(el);
    if (open && index < 0) {
        if (!layers.length) {
            lockScroll();
            if (!ownEntry) {
                history.pushState({ zeydLayer: true }, '');
                ownEntry = true;
            }
        }
        layers.push(el);
    } else if (!open && index >= 0) {
        layers.splice(index, 1);
        el.dispatchEvent(new CustomEvent('layer:close'));
        if (!layers.length) {
            unlockScroll();
            // Closed by a button: remove our history entry, unless another layer opens right away
            setTimeout(() => {
                if (!layers.length && ownEntry) {
                    ownEntry = false;
                    ignorePop += 1;
                    history.back();
                }
            }, 0);
        }
    }
}

export function closeLayer(el) {
    if (el.tagName === 'DIALOG') el.close();
    else if (el.id === 'authScreen') document.getElementById('authCloseBtn')?.click();
    else el.hidden = true;
}

// Only one page at a time: opening one closes the other
export function openPage(id) {
    for (const other of PAGE_IDS) {
        const page = document.getElementById(other);
        if (other !== id && page && !page.hidden) page.hidden = true;
    }
    const page = document.getElementById(id);
    if (!page) return;
    page.hidden = false;
    page.querySelector('.app-page-body')?.scrollTo({ top: 0 });
    page.focus({ preventScroll: true });
}

export function closePages() {
    for (const id of PAGE_IDS) {
        const page = document.getElementById(id);
        if (page && !page.hidden) page.hidden = true;
    }
}

export function initOverlays() {
    // The position is restored here (unlockScroll): the browser must not also jump to the position it saved with
    // our history entry when it is removed, which would undo a scroll asked just after closing a window
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    const watched = (node) =>
        node.nodeType === 1 && (node.tagName === 'DIALOG' || isPage(node) || node.id === 'authScreen');
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            if (record.type === 'attributes' && watched(record.target)) update(record.target);
            for (const node of record.removedNodes ?? []) {
                if (watched(node) && layers.includes(node)) {
                    layers.splice(layers.indexOf(node), 1);
                    if (!layers.length) unlockScroll();
                }
            }
        }
    });
    observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['open', 'hidden'],
    });
    for (const node of document.querySelectorAll('dialog, #authScreen, .app-page')) {
        if (isOpen(node)) update(node);
    }

    window.addEventListener('popstate', () => {
        if (ignorePop) {
            ignorePop -= 1;
            return;
        }
        if (!ownEntry) return;
        ownEntry = false;
        const top = layers.at(-1);
        if (!top) return;
        const others = layers.length - 1;
        closeLayer(top);
        // More layers still open: keep one entry so the next « back » closes the next one
        if (others) {
            history.pushState({ zeydLayer: true }, '');
            ownEntry = true;
        }
    });

    // Escape closes the top page (dialogs already close themselves on Escape)
    document.addEventListener('keydown', (e) => {
        const top = layers.at(-1);
        if (e.key === 'Escape' && top && isPage(top)) closeLayer(top);
    });
    for (const btn of document.querySelectorAll('[data-close-page]')) {
        btn.addEventListener('click', () => closePages());
    }
}

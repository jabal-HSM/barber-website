// Floating notch bottom bar (phones). The active tab is lifted into the glowing ball and the bump of the
// panel follows it. What each tab opens is decided by script.js, with the site's existing features only.
import { barPath, easeInOutCubic, edgePath } from './notchGeometry.js';

const DURATION_MS = 380;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export function initBottomNav({ onSelect }) {
    const bar = document.getElementById('tabbar');
    if (!bar) return null;
    const svg = bar.querySelector('.tabbar-shape');
    const panel = bar.querySelector('.tabbar-panel');
    const glow = bar.querySelector('.tabbar-glow');
    const edge = bar.querySelector('.tabbar-edge');
    const ball = bar.querySelector('.tabbar-ball');
    const ballIcon = ball.querySelector('use');
    const tabs = [...bar.querySelectorAll('.tabbar-tab')];
    let active = 'home';
    let cx = null;
    let frame = 0;

    // Centre of a tab, in pixels from the left edge of the bar (the same in RTL and LTR)
    const centerOf = (name) => {
        const tab = tabs.find((t) => t.dataset.tab === name);
        const box = bar.getBoundingClientRect();
        const rect = tab.getBoundingClientRect();
        return rect.left - box.left + rect.width / 2;
    };

    const draw = (x) => {
        const width = bar.clientWidth;
        const height = bar.clientHeight;
        if (!width) return; // hidden (wide screens)
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        panel.setAttribute('d', barPath(width, height, x));
        glow.setAttribute('d', edgePath(width, x));
        edge.setAttribute('d', edgePath(width, x));
        ball.style.transform = `translateX(${x - ball.offsetWidth / 2}px)`;
    };

    const select = (name, { animate = true } = {}) => {
        const tab = tabs.find((t) => t.dataset.tab === name);
        if (!tab) return;
        active = name;
        for (const t of tabs) {
            if (t === tab) t.setAttribute('aria-current', 'page');
            else t.removeAttribute('aria-current');
        }
        ballIcon.setAttribute('href', tab.querySelector('use').getAttribute('href'));
        ball.classList.remove('is-popping');
        void ball.offsetWidth; // restart the small "pop" of the icon
        ball.classList.add('is-popping');

        cancelAnimationFrame(frame);
        const target = centerOf(name);
        if (!animate || cx === null || reducedMotion.matches) {
            cx = target;
            draw(cx);
            return;
        }
        const from = cx;
        const start = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - start) / DURATION_MS);
            cx = from + (target - from) * easeInOutCubic(t);
            draw(cx);
            if (t < 1) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
    };

    // Size, rotation or language direction changed: redraw at the active tab, without animation
    const refresh = () => {
        cancelAnimationFrame(frame);
        if (!bar.clientWidth) return;
        cx = centerOf(active);
        draw(cx);
    };

    for (const tab of tabs) {
        tab.addEventListener('click', () => {
            select(tab.dataset.tab);
            onSelect(tab.dataset.tab);
        });
    }
    new ResizeObserver(refresh).observe(bar);
    refresh();

    return { select, refresh, active: () => active };
}

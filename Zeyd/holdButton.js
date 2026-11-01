// "Hold to confirm" button: the action runs only after the button has been held down for `duration` ms
// (pointer, touch, or Space / Enter on the keyboard). A fill grows inside the button while it is held;
// releasing early cancels. Used for destructive actions (cancelling an appointment) instead of a simple click.
// No dependency; the fill follows the reading direction (RTL in Arabic) through logical CSS properties.

// Pure timing logic (tested in tests/hold-button.test.mjs)
export function createHoldController({ duration = 1200, onProgress = () => {}, onComplete = () => {} } = {}) {
    let startedAt = null;
    let done = false;
    return {
        get holding() {
            return startedAt !== null;
        },
        get done() {
            return done;
        },
        start(now) {
            if (done || startedAt !== null) return false;
            startedAt = now;
            onProgress(0);
            return true;
        },
        // Returns the progress 0..1; completes once when it reaches 1
        tick(now) {
            if (startedAt === null || done) return done ? 1 : 0;
            const progress = Math.min(1, Math.max(0, (now - startedAt) / duration));
            onProgress(progress);
            if (progress >= 1) {
                done = true;
                startedAt = null;
                onComplete();
            }
            return progress;
        },
        cancel() {
            if (startedAt === null) return false;
            startedAt = null;
            onProgress(0);
            return true;
        },
        // After a failed action, the button can be held again
        reset() {
            startedAt = null;
            done = false;
            onProgress(0);
        },
    };
}

const HOLD_KEYS = new Set([' ', 'Enter']);

// label / holdingLabel / busyLabel: texts; onConfirm: async action. Returns the <button>.
// canStart(): optional check before holding (e.g. a reason must be chosen); return false to refuse.
export function createHoldButton({
    label,
    holdingLabel = label,
    busyLabel = label,
    hint = '',
    duration = 1200,
    className = '',
    onConfirm,
    canStart = () => true,
}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `hold-btn ${className}`.trim();
    const fill = document.createElement('span');
    fill.className = 'hold-btn-fill';
    fill.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'hold-btn-text';
    text.textContent = label;
    button.append(fill, text);
    if (hint) {
        const hintEl = document.createElement('span');
        hintEl.className = 'visually-hidden';
        hintEl.textContent = ` ${hint}`;
        button.append(hintEl);
    }

    let frame = 0;
    let busy = false;
    const controller = createHoldController({
        duration,
        onProgress: (p) => {
            button.style.setProperty('--hold-progress', String(p));
        },
        onComplete: async () => {
            cancelAnimationFrame(frame);
            busy = true;
            button.classList.remove('is-holding');
            button.classList.add('is-busy');
            button.setAttribute('aria-busy', 'true');
            text.textContent = busyLabel;
            navigator.vibrate?.(15);
            let ok = false;
            try {
                ok = (await onConfirm()) !== false;
            } catch {
                ok = false;
            }
            busy = false;
            button.removeAttribute('aria-busy');
            button.classList.remove('is-busy');
            if (!ok) {
                // Failed on the server: nothing happened, the button can be held again
                controller.reset();
                text.textContent = label;
            }
        },
    });

    const loop = () => {
        controller.tick(performance.now());
        if (controller.holding) frame = requestAnimationFrame(loop);
    };
    const start = () => {
        if (busy || button.disabled || controller.done) return;
        if (!canStart()) {
            button.classList.remove('is-refused');
            void button.offsetWidth; // restart the shake animation
            button.classList.add('is-refused');
            return;
        }
        if (!controller.start(performance.now())) return;
        button.classList.add('is-holding');
        text.textContent = holdingLabel;
        frame = requestAnimationFrame(loop);
    };
    const stop = () => {
        if (!controller.holding) return;
        cancelAnimationFrame(frame);
        controller.cancel();
        button.classList.remove('is-holding');
        text.textContent = label;
    };

    button.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        button.setPointerCapture?.(e.pointerId);
        start();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, stop);
    button.addEventListener('keydown', (e) => {
        if (!HOLD_KEYS.has(e.key)) return;
        e.preventDefault(); // no click, no form submit, no page scroll
        if (!e.repeat) start();
    });
    button.addEventListener('keyup', (e) => {
        if (HOLD_KEYS.has(e.key)) stop();
    });
    button.addEventListener('blur', stop);
    // A long press on a phone must not open the context menu or select text
    button.addEventListener('contextmenu', (e) => e.preventDefault());
    button.addEventListener('click', (e) => e.preventDefault());
    button.addEventListener('animationend', () => button.classList.remove('is-refused'));

    button.resetHold = () => {
        stop();
        controller.reset();
        text.textContent = label;
    };
    // Language change: new texts without rebuilding the button (keeps the fill and the listeners)
    button.setLabels = (labels) => {
        ({ label = label, holdingLabel = holdingLabel, busyLabel = busyLabel } = labels);
        if (labels.hint !== undefined) {
            const hintEl = button.querySelector('.visually-hidden');
            if (hintEl) hintEl.textContent = ` ${labels.hint}`;
        }
        if (!controller.holding && !busy) text.textContent = label;
    };
    return button;
}

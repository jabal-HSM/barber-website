// Small « OK / Cancel » question in a modal <dialog>, styled like the QR window (.qr-dialog).
// Resolves true for OK; false for Cancel, Escape or a click outside the panel.
export function confirmDialog({ message, ok, cancel }) {
    return new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        dialog.className = 'qr-dialog confirm-dialog';
        const text = document.createElement('p');
        text.className = 'confirm-dialog-text';
        text.id = `confirm-${Date.now()}`;
        text.textContent = message;
        dialog.setAttribute('aria-labelledby', text.id);

        const button = (label, className, value) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = className;
            b.textContent = label;
            b.addEventListener('click', () => dialog.close(value));
            return b;
        };
        const no = button(cancel, 'btn btn-ghost btn-sm', 'cancel');
        const yes = button(ok, 'btn btn-primary btn-sm', 'ok');
        const actions = document.createElement('div');
        actions.className = 'confirm-dialog-actions';
        actions.append(no, yes);
        dialog.append(text, actions);

        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) dialog.close('cancel');
        });
        dialog.addEventListener('close', () => {
            resolve(dialog.returnValue === 'ok');
            dialog.remove();
        });
        document.body.append(dialog);
        dialog.showModal();
        no.focus();
    });
}

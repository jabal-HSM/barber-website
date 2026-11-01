// Why the QR scanner cannot use the camera, as a message key of admin-i18n.js.
// Browsers only give the camera to secure pages: https://, or http://localhost / 127.0.0.1.
// An address such as http://192.168.x.x or http://10.x.x.x is not secure: the camera is refused there
// whatever the code does, and only the manual code field can be used.

// Before asking: null when the camera can be requested
export function cameraUnavailable({ isSecureContext, mediaDevices }) {
    if (!isSecureContext) return 'loyalty.cameraInsecure';
    if (typeof mediaDevices?.getUserMedia !== 'function') return 'loyalty.cameraUnsupported';
    return null;
}

// After getUserMedia() failed
export function cameraErrorKey(error) {
    switch (error?.name) {
        case 'NotAllowedError':
        case 'SecurityError':
            return 'loyalty.cameraDenied';
        case 'NotFoundError':
        case 'OverconstrainedError':
            return 'loyalty.cameraNotFound';
        case 'NotReadableError':
        case 'AbortError':
            return 'loyalty.cameraBusy';
        default:
            return 'loyalty.cameraError';
    }
}

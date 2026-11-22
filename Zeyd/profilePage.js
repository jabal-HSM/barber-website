// « Profil » page: name and optional photo (profiles.full_name / avatar_url of the signed-in customer only, RLS),
// and the password change by e-mail code (passwordChange.js). The page itself is opened by booking.js.
import { fetchMyProfile, isSafeImageUrl, updateMyProfile } from './api.js';
import { confirmPasswordChange, sendPasswordCode } from './passwordChange.js';
import { getSupabase } from './supabaseClient.js';

const PHOTO_SIDE = 256; // stored photo: a small square JPEG (about 10–20 KB) in profiles.avatar_url
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RESEND_DELAY_S = 60;

const $ = (id) => document.getElementById(id);
const DATA_PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
export const isSafeAvatar = (url) => typeof url === 'string' && (DATA_PHOTO.test(url) || isSafeImageUrl(url));

let ctx = null; // { getUser, getLang, t, setMessage }
let profile = { full_name: '', avatar_url: null };
let pendingPhoto; // undefined = unchanged, null = removed, string = new photo

// Square crop from the centre, resized: only this small copy leaves the phone
async function shrinkPhoto(file) {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = PHOTO_SIDE;
    canvas.height = PHOTO_SIDE;
    canvas
        .getContext('2d')
        .drawImage(
            bitmap,
            (bitmap.width - side) / 2,
            (bitmap.height - side) / 2,
            side,
            side,
            0,
            0,
            PHOTO_SIDE,
            PHOTO_SIDE,
        );
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', 0.82);
}

function showAvatar(url) {
    const img = $('profileAvatarImg');
    const icon = document.querySelector('.profile-avatar-icon');
    const ok = isSafeAvatar(url);
    img.hidden = !ok;
    icon.hidden = ok;
    if (ok) img.src = url;
    else img.removeAttribute('src');
    $('profilePhotoRemove').hidden = !ok;
}

function render() {
    const user = ctx?.getUser();
    if (!user) return;
    const name = profile.full_name || user.user_metadata?.full_name || '';
    $('profileName').textContent = name || ctx.t('profile.noName');
    if (document.activeElement !== $('profileNameInput')) $('profileNameInput').value = name;
    showAvatar(pendingPhoto === undefined ? profile.avatar_url : pendingPhoto);
}

export async function loadProfile() {
    const user = ctx?.getUser();
    if (!user) return;
    pendingPhoto = undefined;
    render();
    const row = await fetchMyProfile(user.id);
    if (row) profile = { full_name: row.full_name ?? '', avatar_url: row.avatar_url ?? null };
    render();
}

export function renderProfileLanguage() {
    render();
}

function initPhoto() {
    const input = $('profilePhotoInput');
    const choose = () => input.click();
    $('profileAvatarBtn').addEventListener('click', choose);
    $('profilePhotoChoose').addEventListener('click', choose);
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        if (!file.type.startsWith('image/') || file.size > MAX_FILE_BYTES) {
            ctx.setMessage('profileMessage', 'error', 'profile.photoInvalid');
            return;
        }
        try {
            pendingPhoto = await shrinkPhoto(file);
        } catch {
            ctx.setMessage('profileMessage', 'error', 'profile.photoInvalid');
            return;
        }
        showAvatar(pendingPhoto);
        ctx.setMessage('profileMessage', 'success', 'profile.photoReady');
    });
    $('profilePhotoRemove').addEventListener('click', () => {
        pendingPhoto = null;
        showAvatar(null);
        ctx.setMessage('profileMessage', 'success', 'profile.photoReady');
    });
}

function initNameForm() {
    $('profileForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = ctx.getUser();
        if (!user) return;
        const change = { full_name: $('profileNameInput').value.trim() || null };
        if (pendingPhoto !== undefined) change.avatar_url = pendingPhoto;
        $('profileSave').disabled = true;
        const { data, error } = await updateMyProfile(user.id, change);
        $('profileSave').disabled = false;
        if (error) {
            ctx.setMessage('profileMessage', 'error', 'profile.saveError');
            return;
        }
        profile = { full_name: data.full_name ?? '', avatar_url: data.avatar_url ?? null };
        pendingPhoto = undefined;
        render();
        ctx.setMessage('profileMessage', 'success', 'profile.saved');
    });
}

function passwordErrorKey(error) {
    const key = `password.error.${error?.code ?? ''}`;
    return ctx.t(key) === key ? 'password.error.other' : key;
}

// The customer « Profil » no longer shows this card (replaced by the messages); kept for pages that still have it
function initPassword() {
    const send = $('profilePasswordSend');
    if (!send) return;
    let timer = 0;
    const resetSend = () => {
        clearInterval(timer);
        send.disabled = false;
        send.textContent = ctx.t('password.sendCode');
    };
    send.addEventListener('click', async () => {
        const user = ctx.getUser();
        if (!user) return;
        send.disabled = true;
        ctx.setMessage('profilePasswordMessage', null);
        const supabase = await getSupabase();
        const { error } = supabase ? await sendPasswordCode(supabase.auth, user.email) : { error: {} };
        if (error) {
            send.disabled = false;
            ctx.setMessage('profilePasswordMessage', 'error', passwordErrorKey(error), {
                detail: [error.code, error.status].filter(Boolean).join(' · '),
            });
            return;
        }
        $('profilePasswordStep').hidden = false;
        $('profilePasswordCode').focus();
        ctx.setMessage('profilePasswordMessage', 'success', 'password.codeSent', { email: user.email });
        let left = RESEND_DELAY_S;
        const tick = () => {
            send.textContent = ctx.t('password.resendIn', { s: left });
            if (left-- <= 0) {
                resetSend();
                send.textContent = ctx.t('password.resend');
            }
        };
        tick();
        timer = setInterval(tick, 1000);
    });
    $('profilePasswordForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = ctx.getUser();
        if (!user) return;
        const supabase = await getSupabase();
        if (!supabase) return;
        $('profilePasswordSave').disabled = true;
        const result = await confirmPasswordChange(supabase.auth, {
            email: user.email,
            userId: user.id,
            code: $('profilePasswordCode').value,
            password: $('profilePasswordNew').value,
            repeat: $('profilePasswordRepeat').value,
        });
        $('profilePasswordSave').disabled = false;
        if (result.errorKey) {
            ctx.setMessage('profilePasswordMessage', 'error', result.errorKey, { detail: 'account_mismatch' });
            return;
        }
        // Supabase answered: the typed code and passwords are not kept on the page
        for (const id of ['profilePasswordCode', 'profilePasswordNew', 'profilePasswordRepeat']) $(id).value = '';
        if (result.error) {
            ctx.setMessage('profilePasswordMessage', 'error', passwordErrorKey(result.error), {
                detail: [result.error.code, result.error.status].filter(Boolean).join(' · '),
            });
            return;
        }
        $('profilePasswordStep').hidden = true;
        resetSend();
        ctx.setMessage('profilePasswordMessage', 'success', 'password.changed');
    });
}

// getUser(): current user or null; t(key, params): text in the current language; setMessage(id, kind, key, params)
export function initProfilePage(helpers) {
    if (!$('profilePage')) return;
    ctx = helpers;
    initPhoto();
    initNameForm();
    initPassword();
}

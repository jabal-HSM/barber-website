// Data access for the site. Every function returns null (or does nothing) when no backend is
// configured or the request fails, so the page can always fall back to the content of data.js.
// Permissions are enforced by the database (Row Level Security), not by this file.
import { getSupabase } from './supabaseClient.js';

// Database row (public.services) -> the shape used by data.js and script.js
export function mapServiceRow(row) {
    return {
        id: row.slug ?? row.id,
        dbId: row.id, // needed to book; absent from data.js, so offline content cannot be booked
        price: Number(row.price),
        durationMinutes: row.duration_minutes ?? null,
        name: { fr: row.name_fr, ar: row.name_ar || row.name_fr },
        description: { fr: row.description_fr ?? '', ar: row.description_ar || row.description_fr || '' },
    };
}

// Only https URLs or paths relative to the site are accepted as image sources.
export function isSafeImageUrl(url) {
    return typeof url === 'string' && (/^https:\/\//i.test(url) || /^[\w-][\w./-]*$/.test(url));
}

// Database row (gallery_with_likes()) -> the shape used by GALLERY in data.js
export function mapGalleryRow(row) {
    return {
        id: row.id,
        src: row.image_url,
        category: row.category ?? null,
        alt: { fr: row.title_fr ?? '', ar: row.title_ar || row.title_fr || '' },
        likeCount: Number(row.like_count) || 0,
        likedByMe: Boolean(row.liked_by_me),
    };
}

export async function fetchServices() {
    const supabase = await getSupabase();
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('services')
        .select('id, slug, name_fr, name_ar, description_fr, description_ar, price, duration_minutes')
        .eq('is_active', true)
        .order('sort_order');
    if (error || !data?.length) return null;
    return data.map(mapServiceRow);
}

export async function fetchGallery() {
    const supabase = await getSupabase();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('gallery_with_likes');
    if (error || !data) return null;
    return data.filter((row) => isSafeImageUrl(row.image_url)).map(mapGalleryRow);
}

// Short error code for the UI. The booking functions raise codes such as 'slot_unavailable' as message.
const KNOWN_ERRORS = [
    'auth_required',
    'service_unavailable',
    'slot_unavailable',
    'too_many_bookings',
    'invalid_time',
    'not_found',
    'too_late_to_cancel',
    'invalid_status',
    'forbidden',
    'outside_hours',
    'too_close',
    'booking_disabled',
    'payments_disabled',
    'payments_not_configured',
    'live_payments_not_allowed',
    'already_paid',
    'stripe_error',
    'invalid_reason',
    'details_required',
    'details_too_long',
    'same_time',
];

// Supabase Auth error codes (error.code) → message keys. Read before the message text, which is not stable.
const AUTH_CODES = {
    user_already_exists: 'email_taken',
    email_exists: 'email_taken',
    weak_password: 'weak_password',
    email_address_invalid: 'invalid_email',
    email_address_not_authorized: 'email_send_failed',
    over_email_send_rate_limit: 'rate_limited',
    over_request_rate_limit: 'rate_limited',
    signup_disabled: 'signup_disabled',
    email_provider_disabled: 'signup_disabled',
    invalid_credentials: 'invalid_credentials',
    email_not_confirmed: 'email_not_confirmed',
};

export function errorCode(error) {
    if (!error) return null;
    const message = String(error.message ?? '');
    if (KNOWN_ERRORS.includes(message)) return message;
    if (AUTH_CODES[error.code]) return AUTH_CODES[error.code];
    // The confirmation e-mail could not be sent (mail server refused it): the account is not created
    if (/error sending .*e?mail/i.test(message)) return 'email_send_failed';
    if (/unable to validate email|invalid format|email address .* is invalid/i.test(message)) return 'invalid_email';
    if (error.name === 'AuthRetryableFetchError' || /failed to fetch|networkerror|load failed/i.test(message))
        return 'network';
    if (error.code === '42501' || /permission denied|JWT/i.test(message)) return 'auth_required';
    if (/invalid login credentials/i.test(message)) return 'invalid_credentials';
    if (/email not confirmed/i.test(message)) return 'email_not_confirmed';
    if (/already registered|already been registered/i.test(message)) return 'email_taken';
    if (/password/i.test(message)) return 'weak_password';
    if (/rate limit|too many/i.test(message)) return 'rate_limited';
    return 'unknown';
}

const NO_BACKEND = { data: null, error: { message: 'no_backend' } };

// --- Authentication ---
export async function signUp(email, password, { fullName = '', lang = 'fr' } = {}) {
    const supabase = await getSupabase();
    if (!supabase) return { error: new Error('No backend configured') };
    return supabase.auth.signUp({
        email,
        password,
        options: {
            data: { full_name: fullName, preferred_lang: lang },
            emailRedirectTo: `${location.origin}${location.pathname}`,
        },
    });
}

// Sound preferences follow the account (user_metadata: written by the person only, no security meaning)
export async function saveSoundPrefs(prefs) {
    const supabase = await getSupabase();
    if (!supabase) return { error: null };
    return supabase.auth.updateUser({ data: { sound_prefs: prefs } });
}

// New confirmation email, for an account whose link expired or never arrived
export async function resendConfirmation(email) {
    const supabase = await getSupabase();
    if (!supabase) return { error: new Error('No backend configured') };
    return supabase.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: `${location.origin}${location.pathname}` },
    });
}

export async function signIn(email, password) {
    const supabase = await getSupabase();
    if (!supabase) return { error: new Error('No backend configured') };
    return supabase.auth.signInWithPassword({ email, password });
}

export async function signOut() {
    const supabase = await getSupabase();
    return supabase ? supabase.auth.signOut() : { error: null };
}

export async function getCurrentUser() {
    const supabase = await getSupabase();
    if (!supabase) return null;
    const { data } = await supabase.auth.getUser();
    return data?.user ?? null;
}

// Calls `callback(user | null)` now and on every sign-in / sign-out.
export async function onAuthChange(callback) {
    const supabase = await getSupabase();
    if (!supabase) {
        callback(null);
        return;
    }
    supabase.auth.onAuthStateChange((_event, session) => callback(session?.user ?? null));
}

// --- Booking (rules are enforced by the database functions, see supabase/migrations) ---
export async function fetchBookableDays() {
    const supabase = await getSupabase();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('bookable_days');
    return error ? null : data.map((row) => row.day);
}

export async function fetchSlots(serviceDbId, day) {
    const supabase = await getSupabase();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('available_slots', { p_service_id: serviceDbId, p_day: day });
    return error ? null : data;
}

// Opening hours, start-time step and notice period (public): used to show taken times next to free ones
export async function fetchSchedule() {
    const supabase = await getSupabase();
    if (!supabase) return null;
    const [hours, settings] = await Promise.all([
        supabase.from('business_hours').select('weekday, opens_at, closes_at'),
        supabase.from('booking_settings').select('slot_step_minutes, min_notice_minutes').maybeSingle(),
    ]);
    if (hours.error || settings.error || !settings.data) return null;
    return {
        hours: hours.data,
        stepMinutes: settings.data.slot_step_minutes,
        minNoticeMinutes: settings.data.min_notice_minutes,
    };
}

export async function bookAppointment(serviceDbId, startsAt, note) {
    const supabase = await getSupabase();
    if (!supabase) return NO_BACKEND;
    const { data, error } = await supabase.rpc('book_appointment', {
        p_service_id: serviceDbId,
        p_starts_at: startsAt,
        p_note: note || null,
    });
    return { data: data?.[0] ?? null, error };
}

export async function requestCustomTime(serviceDbId, startsAt, note) {
    const supabase = await getSupabase();
    if (!supabase) return NO_BACKEND;
    const { data, error } = await supabase.rpc('request_custom_time', {
        p_service_id: serviceDbId,
        p_starts_at: startsAt,
        p_note: note || null,
    });
    return { data: data?.[0] ?? null, error };
}

export async function cancelBooking(bookingId) {
    const supabase = await getSupabase();
    if (!supabase) return NO_BACKEND;
    return supabase.rpc('cancel_booking', { p_booking_id: bookingId });
}

const missingFunction = (error) =>
    error?.code === 'PGRST202' || /could not find the function/i.test(error?.message ?? '');

// Cancellation with a reason (migration 20261101090000). Before that migration is applied on the project,
// the old cancellation still works, without the reason.
export async function cancelMyBooking(bookingId, reasonCode, details) {
    const supabase = await getSupabase();
    if (!supabase) return NO_BACKEND;
    const result = await supabase.rpc('cancel_my_booking', {
        p_booking_id: bookingId,
        p_reason_code: reasonCode,
        p_details: details || null,
    });
    if (missingFunction(result.error)) return { ...(await cancelBooking(bookingId)), reasonSaved: false };
    return { ...result, reasonSaved: !result.error };
}

// Moves a booking to a new slot in one step: if the new slot fails, the old booking is kept as it was.
export async function rescheduleMyBooking(bookingId, newStartsAt, details) {
    const supabase = await getSupabase();
    if (!supabase) return NO_BACKEND;
    const { data, error } = await supabase.rpc('reschedule_my_booking', {
        p_booking_id: bookingId,
        p_new_starts_at: newStartsAt,
        p_details: details || null,
    });
    return { data: data?.[0] ?? null, error };
}

// Asks the server to tell Zeyd (Telegram). Best effort: the cancellation is already stored and visible in
// the dashboard whatever happens here, and the server sends each notification at most once.
export async function notifyStaffOfBooking(bookingId) {
    try {
        const supabase = await getSupabase();
        await supabase?.functions.invoke('notify-staff', { body: { booking_id: bookingId } });
    } catch {
        // Function not deployed or offline: the notification stays "pending" in the dashboard
    }
}

// The signed-in customer's upcoming bookings (RLS returns their own rows only).
// Staff can read every booking, so the customer filter matters here.
export async function fetchMyBookings(userId) {
    const supabase = await getSupabase();
    if (!supabase || !userId) return null;
    const { data, error } = await supabase
        .from('bookings')
        .select(
            'id, service_id, starts_at, ends_at, status, is_custom_request, cancel_reason, cancelled_by, customer_id, services (name_fr, name_ar, price)',
        )
        .eq('customer_id', userId)
        .in('status', ['confirmed', 'requested', 'cancelled'])
        .gte('starts_at', new Date().toISOString())
        .order('starts_at');
    return error ? null : data;
}

// --- Messages with the salon (booking_messages, migration 20261102110000). RLS: a customer reads only the
// messages of their own bookings; writing goes through customer_send_message / mark_my_messages_read only. ---
// Table not created yet on this project (migration not applied): the page says so instead of failing.
export const isMissingTable = (error) =>
    ['42P01', 'PGRST205', 'PGRST202'].includes(error?.code) ||
    /does not exist|schema cache/i.test(error?.message ?? '');

export async function fetchMyMessages() {
    const supabase = await getSupabase();
    if (!supabase) return { data: [], error: null };
    return supabase
        .from('booking_messages')
        .select(
            'id, booking_id, from_staff, body, created_at, read_at, bookings:booking_id (starts_at, status, services (name_fr, name_ar))',
        )
        .order('created_at');
}

export async function sendMyMessage(bookingId, body) {
    const supabase = await getSupabase();
    if (!supabase) return NO_BACKEND;
    return supabase.rpc('customer_send_message', { p_booking_id: bookingId, p_body: body });
}

export async function markMyMessagesRead() {
    const supabase = await getSupabase();
    if (!supabase) return NO_BACKEND;
    return supabase.rpc('mark_my_messages_read', { p_booking_id: null });
}

// The customer's bookings that can be written about: upcoming ones and those of the last 30 days
export async function fetchMyRecentBookings(userId) {
    const supabase = await getSupabase();
    if (!supabase || !userId) return [];
    const { data, error } = await supabase
        .from('bookings')
        .select('id, starts_at, status, services (name_fr, name_ar)')
        .eq('customer_id', userId)
        .gte('starts_at', new Date(Date.now() - 30 * 86_400_000).toISOString())
        .order('starts_at', { ascending: false });
    return error ? [] : data;
}

// --- Own profile (name and photo of « Profil »). RLS: a customer reads and updates only their own row, and only
// full_name / avatar_url / preferred_lang can be written; the role never. ---
export async function fetchMyProfile(userId) {
    const supabase = await getSupabase();
    if (!supabase || !userId) return null;
    const { data, error } = await supabase
        .from('profiles')
        .select('full_name, avatar_url')
        .eq('id', userId)
        .maybeSingle();
    return error ? null : data;
}

// Success only when the database returns the saved row
export async function updateMyProfile(userId, change) {
    const supabase = await getSupabase();
    if (!supabase) return NO_BACKEND;
    const { data, error } = await supabase
        .from('profiles')
        .update(change)
        .eq('id', userId)
        .select('full_name, avatar_url');
    if (error) return { data: null, error };
    return data?.length ? { data: data[0], error: null } : { data: null, error: { message: 'forbidden' } };
}

// --- Likes (one per user and photo; the database rejects duplicates and anonymous likes) ---
export async function likeHaircut(haircutId) {
    const supabase = await getSupabase();
    if (!supabase) return { error: new Error('No backend configured') };
    const { error } = await supabase.from('haircut_likes').insert({ haircut_id: haircutId });
    // 23505 = already liked: treat as success
    return { error: error?.code === '23505' ? null : error };
}

export async function unlikeHaircut(haircutId) {
    const supabase = await getSupabase();
    if (!supabase) return { error: new Error('No backend configured') };
    return supabase.from('haircut_likes').delete().eq('haircut_id', haircutId);
}

// --- Loyalty card (stamps are added by the barber only, from the dashboard) ---
export async function fetchMyLoyalty() {
    const supabase = await getSupabase();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('my_loyalty');
    return error ? null : (data?.[0] ?? null);
}

// --- Online payment (Stripe Checkout through the create-checkout Edge Function) ---
export async function fetchPaymentSettings() {
    const supabase = await getSupabase();
    if (!supabase) return null;
    const { data } = await supabase.from('payment_settings').select('online_payments_enabled').maybeSingle();
    return data ?? null;
}

// Status of the customer's own payments, by booking id (only confirmed "paid" counts as paid)
export async function fetchMyPayments(bookingIds) {
    const supabase = await getSupabase();
    if (!supabase || !bookingIds.length) return {};
    const { data, error } = await supabase
        .from('payments')
        .select('booking_id, status, amount_cents, paid_at')
        .in('booking_id', bookingIds);
    if (error) return {};
    const byBooking = {};
    for (const row of data) {
        if (!byBooking[row.booking_id] || row.status === 'paid') byBooking[row.booking_id] = row;
    }
    return byBooking;
}

export async function startCheckout(bookingId) {
    const supabase = await getSupabase();
    if (!supabase) return NO_BACKEND;
    const { data, error } = await supabase.functions.invoke('create-checkout', { body: { booking_id: bookingId } });
    if (error) {
        // The function answers { error: '<code>' }; a missing function (not deployed yet) has no body
        const body = await error.context?.json?.().catch(() => null);
        return { data: null, error: { message: body?.error ?? 'payments_not_configured' } };
    }
    return { data, error: data?.url ? null : { message: 'stripe_error' } };
}

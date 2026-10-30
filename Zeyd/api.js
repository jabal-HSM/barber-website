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
];

export function errorCode(error) {
    if (!error) return null;
    const message = String(error.message ?? '');
    if (KNOWN_ERRORS.includes(message)) return message;
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

// The signed-in customer's upcoming bookings (RLS returns their own rows only).
// Staff can read every booking, so the customer filter matters here.
export async function fetchMyBookings(userId) {
    const supabase = await getSupabase();
    if (!supabase || !userId) return null;
    const { data, error } = await supabase
        .from('bookings')
        .select(
            'id, starts_at, ends_at, status, is_custom_request, cancel_reason, cancelled_by, customer_id, services (name_fr, name_ar, price)',
        )
        .eq('customer_id', userId)
        .in('status', ['confirmed', 'requested', 'cancelled'])
        .gte('starts_at', new Date().toISOString())
        .order('starts_at');
    return error ? null : data;
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

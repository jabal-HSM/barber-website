// Data access for the site. Every function returns null (or does nothing) when no backend is
// configured or the request fails, so the page can always fall back to the content of data.js.
// Permissions are enforced by the database (Row Level Security), not by this file.
import { getSupabase } from './supabaseClient.js';

// Database row (public.services) -> the shape used by data.js and script.js
export function mapServiceRow(row) {
    return {
        id: row.slug ?? row.id,
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

// --- Authentication (used by the customer account UI in Phase 5) ---
export async function signUp(email, password, { fullName = '', lang = 'fr' } = {}) {
    const supabase = await getSupabase();
    if (!supabase) return { error: new Error('No backend configured') };
    return supabase.auth.signUp({ email, password, options: { data: { full_name: fullName, preferred_lang: lang } } });
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

// Search in what the page already has: the active services and the published gallery photos. No extra
// request and nothing invented: a result is always a real service or a real photo.

// Latin accents, Arabic short vowels and tatweel are ignored; the usual Arabic letter variants are folded.
const MARKS = /[̀-ًͯ-ٰٟـ]/g;

export function normalize(text) {
    return String(text ?? '')
        .normalize('NFD')
        .replace(MARKS, '')
        .toLowerCase()
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/\s+/g, ' ')
        .trim();
}

export const MIN_QUERY_LENGTH = 2;

// Every word of the query must appear in the French or Arabic texts of the item
export function searchCatalog(query, { services = [], gallery = [] } = {}) {
    const q = normalize(query);
    if (q.length < MIN_QUERY_LENGTH) return { services: [], photos: [] };
    const words = q.split(' ');
    const matches = (texts) => {
        const haystack = normalize(texts.filter(Boolean).join(' '));
        return words.every((word) => haystack.includes(word));
    };
    return {
        services: services.filter((s) => matches([s.name?.fr, s.name?.ar, s.description?.fr, s.description?.ar])),
        photos: gallery.filter((p) => matches([p.alt?.fr, p.alt?.ar, p.category])),
    };
}

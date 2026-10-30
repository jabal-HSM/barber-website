// Site content kept as plain data so it can later be served by the backend (Phase 2+).
// Each entry mirrors a future database row: stable id, price in euros, duration in minutes.

// durationMinutes: 35 is a provisional value for regular cuts (30-40 min).
// null means the duration is not known yet and is shown as "to be confirmed".
export const SERVICES = [
    {
        id: 'degrade-bas',
        price: 15,
        durationMinutes: 35,
        name: { fr: 'Dégradé bas', ar: 'تدرّج منخفض' },
        description: {
            fr: 'Dégradé court, près de la nuque et des tempes.',
            ar: 'تدرّج قصير قرب الرقبة والصدغين.',
        },
    },
    {
        id: 'degrade-moyen',
        price: 15,
        durationMinutes: 35,
        name: { fr: 'Dégradé moyen', ar: 'تدرّج متوسط' },
        description: {
            fr: 'Dégradé qui remonte jusqu’à mi-hauteur des côtés.',
            ar: 'تدرّج يرتفع حتى منتصف الجانبين.',
        },
    },
    {
        id: 'degrade-haut',
        price: 15,
        durationMinutes: 35,
        name: { fr: 'Dégradé haut', ar: 'تدرّج عالٍ' },
        description: {
            fr: 'Dégradé marqué, remonté haut sur les côtés.',
            ar: 'تدرّج واضح يرتفع عالياً على الجانبين.',
        },
    },
    {
        id: 'degrade-progressif',
        price: 15,
        durationMinutes: 35,
        name: { fr: 'Dégradé progressif', ar: 'تدرّج تدريجي' },
        description: {
            fr: 'Transition douce et graduelle sur les côtés.',
            ar: 'انتقال ناعم ومتدرّج على الجانبين.',
        },
    },
    {
        id: 'coupe-classique',
        price: 15,
        durationMinutes: 35,
        name: { fr: 'Coupe classique', ar: 'قصّة كلاسيكية' },
        description: {
            fr: 'Coupe traditionnelle, nette et facile à coiffer.',
            ar: 'قصّة تقليدية مرتّبة وسهلة التصفيف.',
        },
    },
    {
        id: 'coupe-ciseaux',
        price: 15,
        durationMinutes: 35,
        name: { fr: 'Coupe aux ciseaux', ar: 'قصّة بالمقص' },
        description: {
            fr: 'Coupe réalisée entièrement aux ciseaux.',
            ar: 'قصّة منفّذة بالكامل بالمقص.',
        },
    },
    {
        id: 'coupe-enfant',
        price: 10,
        durationMinutes: null,
        name: { fr: 'Coupe enfant', ar: 'قصّة للأطفال' },
        description: {
            fr: 'Coupe de cheveux pour les enfants.',
            ar: 'قصّة شعر مخصّصة للأطفال.',
        },
    },
    {
        id: 'coupe-et-barbe',
        price: 15,
        durationMinutes: null,
        name: { fr: 'Coupe et barbe', ar: 'قصّة ولحية' },
        description: {
            fr: 'Coupe de cheveux et taille de la barbe.',
            ar: 'قصّة شعر مع تهذيب اللحية.',
        },
    },
];

// Real photos of the salon's haircuts only. Empty until the barber provides them.
// Expected shape: { src: 'gallery/fondu-bas-01.jpg', category: 'degrade', alt: { fr: '…', ar: '…' } }
export const GALLERY = [];

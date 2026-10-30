// UI strings for French (default, LTR) and Arabic (RTL).
// The brand name ZEYD BARBER and the contact links are never translated.

export const DEFAULT_LANG = 'fr';

export const LANGUAGES = {
    fr: { dir: 'ltr', locale: 'fr-FR' },
    ar: { dir: 'rtl', locale: 'ar' },
};

export const translations = {
    fr: {
        'meta.title': 'ZEYD BARBER | Salon de coiffure pour hommes',
        'meta.description':
            'ZEYD BARBER, salon de coiffure pour hommes : dégradés, coupes classiques et aux ciseaux, coupe enfant, coupe et barbe. Tarifs, horaires et contact.',

        'a11y.skip': 'Aller au contenu principal',
        'a11y.home': 'ZEYD BARBER, retour en haut de page',
        'a11y.mainNav': 'Navigation principale',
        'a11y.footerNav': 'Navigation du pied de page',
        'a11y.language': 'Choisir la langue',
        'a11y.openMenu': 'Ouvrir le menu',
        'a11y.closeMenu': 'Fermer le menu',
        'a11y.themeToDark': 'Activer le mode sombre',
        'a11y.themeToLight': 'Activer le mode clair',
        'a11y.newTab': '(nouvel onglet)',

        'nav.services': 'Prestations',
        'nav.gallery': 'Galerie',
        'nav.about': 'Le barbier',
        'nav.hours': 'Horaires',
        'nav.contact': 'Contact',
        'cta.book': 'Prendre rendez-vous',

        'hero.eyebrow': 'Salon de coiffure pour hommes',
        'hero.headline': 'Une coupe nette, pensée pour vous.',
        'hero.lead':
            'Dégradés, coupes classiques ou aux ciseaux, taille de barbe : ZEYD BARBER vous accueille pour une coupe soignée, réalisée avec attention.',
        'hero.ctaServices': 'Voir les prestations',
        'hero.ctaWhatsapp': 'Écrire sur WhatsApp',
        'hero.factFrom': 'Coupes dès',
        'hero.factHours': 'Ouvert',
        'hero.factServices': 'Prestations',
        'hero.photoAlt': 'Portrait de Zeyd, le barbier de ZEYD BARBER',
        'hero.caption': 'Zeyd, votre barbier',

        'services.eyebrow': 'Prestations & tarifs',
        'services.title': 'Nos prestations',
        'services.lead': 'Des coupes simples et soignées, à des tarifs clairs.',
        'services.noticeTitle': 'Réservation en ligne bientôt disponible',
        'services.notice':
            'Pour le moment, les rendez-vous se prennent directement sur WhatsApp ou Instagram. Choisissez votre prestation ci-dessous et écrivez-nous.',
        'services.duration': '≈ {min} min',
        'services.durationUnknown': 'Durée à confirmer',
        'services.durationLabel': 'Durée indicative',
        'services.bookLink': 'Demander sur WhatsApp',
        'services.bookLinkAria': 'Demander un rendez-vous pour « {name} » sur WhatsApp (nouvel onglet)',
        'services.footnote': 'Les durées sont indicatives et peuvent varier selon la coupe.',

        'gallery.eyebrow': 'Réalisations',
        'gallery.title': 'Galerie des coupes',
        'gallery.emptyTitle': 'Les photos arrivent bientôt',
        'gallery.emptyText':
            'Nous préparons une sélection de photos de nos coupes. En attendant, retrouvez ZEYD BARBER sur Instagram.',
        'gallery.emptyCta': 'Voir Instagram',

        'about.eyebrow': 'Le barbier',
        'about.title': 'Rencontrez Zeyd',
        'about.p1':
            'ZEYD BARBER, c’est le salon de Zeyd. Avant de prendre la tondeuse ou les ciseaux, il prend le temps de comprendre ce que vous souhaitez.',
        'about.p2':
            'Dégradé net, coupe classique, coupe aux ciseaux ou barbe : l’objectif est que vous repartiez avec une coupe qui vous ressemble et qui se porte facilement au quotidien.',
        'about.logoAlt': 'Logo ZEYD BARBER : un Z entrelacé avec une paire de ciseaux',

        'info.eyebrow': 'Infos pratiques',
        'hours.title': 'Horaires',
        'hours.morning': 'Matin',
        'hours.break': 'Pause',
        'hours.breakNote': 'Salon fermé',
        'hours.afternoon': 'Après-midi',
        'hours.days': 'Pour connaître les jours d’ouverture, contactez-nous sur WhatsApp ou Instagram.',
        'contact.title': 'Nous trouver',
        'contact.lead': 'Itinéraire, question ou rendez-vous : choisissez le moyen qui vous convient.',
        'contact.maps': 'Itinéraire Google Maps',
        'contact.whatsapp': 'WhatsApp',
        'contact.instagram': 'Instagram',

        'footer.tagline': 'Salon de coiffure pour hommes.',
        'footer.navTitle': 'Navigation',
        'footer.contactTitle': 'Contact',
        'footer.hoursTitle': 'Horaires',
        'footer.rights': 'Tous droits réservés.',
        'footer.backToTop': 'Haut de page',
    },
    ar: {
        'meta.title': 'ZEYD BARBER | صالون حلاقة رجالي',
        'meta.description':
            'ZEYD BARBER، صالون حلاقة رجالي: تدرّجات، قصّات كلاسيكية وبالمقص، قصّة للأطفال، قصّة ولحية. الأسعار وساعات العمل والتواصل.',

        'a11y.skip': 'الانتقال إلى المحتوى الرئيسي',
        'a11y.home': 'ZEYD BARBER، العودة إلى أعلى الصفحة',
        'a11y.mainNav': 'التنقل الرئيسي',
        'a11y.footerNav': 'روابط تذييل الصفحة',
        'a11y.language': 'اختيار اللغة',
        'a11y.openMenu': 'فتح القائمة',
        'a11y.closeMenu': 'إغلاق القائمة',
        'a11y.themeToDark': 'تفعيل الوضع الداكن',
        'a11y.themeToLight': 'تفعيل الوضع الفاتح',
        'a11y.newTab': '(علامة تبويب جديدة)',

        'nav.services': 'الخدمات',
        'nav.gallery': 'المعرض',
        'nav.about': 'الحلاق',
        'nav.hours': 'ساعات العمل',
        'nav.contact': 'التواصل',
        'cta.book': 'احجز موعداً',

        'hero.eyebrow': 'صالون حلاقة رجالي',
        'hero.headline': 'قصّة متقنة، مصمّمة لك.',
        'hero.lead': 'تدرّجات، قصّات كلاسيكية أو بالمقص، وتهذيب اللحية: يستقبلكم ZEYD BARBER لقصّة متقنة تُنجَز بعناية.',
        'hero.ctaServices': 'عرض الخدمات',
        'hero.ctaWhatsapp': 'راسلنا على WhatsApp',
        'hero.factFrom': 'القصّات ابتداءً من',
        'hero.factHours': 'مفتوح',
        'hero.factServices': 'خدمات',
        'hero.photoAlt': 'صورة زيد، حلاق ZEYD BARBER',
        'hero.caption': 'زيد، حلاقك',

        'services.eyebrow': 'الخدمات والأسعار',
        'services.title': 'خدماتنا',
        'services.lead': 'قصّات بسيطة ومتقنة، بأسعار واضحة.',
        'services.noticeTitle': 'الحجز عبر الموقع قريباً',
        'services.notice': 'حالياً، تُحجز المواعيد مباشرة عبر WhatsApp أو Instagram. اختر خدمتك أدناه وراسلنا.',
        'services.duration': '≈ {min} دقيقة',
        'services.durationUnknown': 'المدة تُحدَّد لاحقاً',
        'services.durationLabel': 'مدة تقريبية',
        'services.bookLink': 'اطلب عبر WhatsApp',
        'services.bookLinkAria': 'طلب موعد لخدمة «{name}» عبر WhatsApp (علامة تبويب جديدة)',
        'services.footnote': 'المدد تقريبية وقد تختلف حسب القصّة.',

        'gallery.eyebrow': 'أعمالنا',
        'gallery.title': 'معرض القصّات',
        'gallery.emptyTitle': 'الصور قريباً',
        'gallery.emptyText': 'نحضّر مجموعة من صور قصّاتنا. في الأثناء، تابعوا ZEYD BARBER على Instagram.',
        'gallery.emptyCta': 'زيارة Instagram',

        'about.eyebrow': 'الحلاق',
        'about.title': 'تعرّف على زيد',
        'about.p1': 'ZEYD BARBER هو صالون زيد. قبل أن يبدأ بالماكينة أو المقص، يأخذ وقته ليفهم ما تريده بالضبط.',
        'about.p2':
            'تدرّج نظيف، قصّة كلاسيكية، قصّة بالمقص أو تهذيب لحية: الهدف أن تخرج بقصّة تشبهك ويسهل الاعتناء بها يومياً.',
        'about.logoAlt': 'شعار ZEYD BARBER: حرف Z متشابك مع مقص',

        'info.eyebrow': 'معلومات عملية',
        'hours.title': 'ساعات العمل',
        'hours.morning': 'الصباح',
        'hours.break': 'استراحة',
        'hours.breakNote': 'الصالون مغلق',
        'hours.afternoon': 'بعد الظهر',
        'hours.days': 'لمعرفة أيام العمل، تواصلوا معنا عبر WhatsApp أو Instagram.',
        'contact.title': 'موقعنا',
        'contact.lead': 'للوصول إلينا أو لسؤال أو لحجز موعد: اختر الطريقة التي تناسبك.',
        'contact.maps': 'الاتجاهات على Google Maps',
        'contact.whatsapp': 'WhatsApp',
        'contact.instagram': 'Instagram',

        'footer.tagline': 'صالون حلاقة رجالي.',
        'footer.navTitle': 'روابط',
        'footer.contactTitle': 'التواصل',
        'footer.hoursTitle': 'ساعات العمل',
        'footer.rights': 'جميع الحقوق محفوظة.',
        'footer.backToTop': 'أعلى الصفحة',
    },
};

// Returns the string for `key`, falling back to French, then to the key itself.
// `{name}` placeholders are replaced from `params`.
export function t(lang, key, params = {}) {
    const template = translations[lang]?.[key] ?? translations[DEFAULT_LANG][key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

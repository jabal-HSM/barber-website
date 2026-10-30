import { supabase } from './supabaseClient.js';

// Dictionary Translations
const translations = {
    fr: {
        heroTitle: "L'Art de la Coiffure Masculine",
        heroSubtitle: 'Précision, Style & Expérience de Luxe',
        bookBtn: 'Prendre Rendez-vous',
        topCuts: 'Top Coupes Tendances',
        verifiedLikes: 'Votes Vérifiés',
        searchPlaceholder: 'Rechercher une prestation ou un style...',
        servicesTitle: 'Services & Tarifs',
        bookingTitle: 'Réserver un Créneau',
        selectService: 'Choisir le service',
        selectDate: 'Date du rendez-vous',
        selectTime: 'Heure disponible (09:00 - 19:00)',
        customTime: 'Ou demander un horaire sur-mesure (Optionnel)',
        confirmBooking: 'Confirmer le Rendez-vous',
        loyaltyTitle: 'Carte de Fidélité Digitale',
        loyaltyStatus: 'Client VIP Privilégié',
        loyaltyRewardRule: '10ème coupe offerte par le salon ZEYD BARBER.',
        infoTitle: 'Informations & Salon',
        navHome: 'Accueil',
        navExplore: 'Découvrir',
        navLoyalty: 'Fidélité',
        navAccount: 'Mon Compte',
        accountTitle: 'Connexion / Mon Compte',
        closeBtn: 'Fermer',
        loginBtn: 'Se Connecter',
        signupBtn: 'Créer un Compte',
        logoutBtn: 'Se Déconnecter',
    },
    ar: {
        heroTitle: 'فن الحلاقة والعناية للرجال',
        heroSubtitle: 'دقة، أسلوب وتجربة فاخرة مع ZEYD BARBER',
        bookBtn: 'احجز موعدك الآن',
        topCuts: 'أفضل القصات طلباً',
        verifiedLikes: 'تصويت حقيقي',
        searchPlaceholder: 'ابحث عن خدمة أو قصة شعر...',
        servicesTitle: 'الخدمات والأسعار',
        bookingTitle: 'حجز موعد',
        selectService: 'اختر الخدمة',
        selectDate: 'تاريخ الموعد',
        selectTime: 'الأوقات المتاحة (09:00 - 19:00)',
        customTime: 'أو اطلب وقتاً مخصصاً (اختياري)',
        confirmBooking: 'تأكيد الموعد',
        loyaltyTitle: 'بطاقة الولاء الرقمية',
        loyaltyStatus: 'زبون VIP مميز',
        loyaltyRewardRule: 'القصة العاشرة مجانية مقدمة من صالون ZEYD BARBER.',
        infoTitle: 'معلومات الصالون',
        navHome: 'الرئيسية',
        navExplore: 'اكتشف',
        navLoyalty: 'الولاء',
        navAccount: 'حسابي',
        accountTitle: 'تسجيل الدخول / حسابي',
        closeBtn: 'إغلاق',
        loginBtn: 'تسجيل الدخول',
        signupBtn: 'إنشاء حساب جديد',
        logoutBtn: 'تسجيل الخروج',
    },
};

// Escape DB/user values before inserting them into innerHTML templates (prevents XSS)
function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

let currentLang = localStorage.getItem('lang') || 'fr';
let currentUser = null;

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    initLanguage();
    checkAuthSession();
    await loadServicesFromDB();
    await loadHaircutsFromDB();
    initLikes();
    initBookingForm();
    initModals();
});

// --- 1. Supabase Auth Session Check ---
async function checkAuthSession() {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    if (session) {
        currentUser = session.user;
        updateUIForLoggedInUser();
    }

    supabase.auth.onAuthStateChange((_event, session) => {
        currentUser = session ? session.user : null;
        if (currentUser) {
            updateUIForLoggedInUser();
        } else {
            updateUIForLoggedOutUser();
        }
    });
}

function updateUIForLoggedInUser() {
    const accountBody = document.querySelector('#accountModal .modal-body');
    if (accountBody) {
        accountBody.innerHTML = `
            <p style="margin-bottom:10px;">Connecté en tant que: <strong>${escapeHtml(currentUser.email)}</strong></p>
            <button id="logoutActionBtn" class="btn btn-primary btn-block">${translations[currentLang].logoutBtn}</button>
        `;
        document.getElementById('logoutActionBtn').addEventListener('click', async () => {
            await supabase.auth.signOut();
            location.reload();
        });
    }
}

function updateUIForLoggedOutUser() {
    const accountBody = document.querySelector('#accountModal .modal-body');
    if (accountBody) {
        accountBody.innerHTML = `
            <div class="form-group">
                <label>Email</label>
                <input type="email" id="authEmail" class="form-control" placeholder="exemple@mail.com">
            </div>
            <div class="form-group">
                <label>Mot de passe</label>
                <input type="password" id="authPassword" class="form-control" placeholder="••••••••">
            </div>
            <div style="display:flex; gap:8px; margin-top:12px;">
                <button id="loginActionBtn" class="btn btn-primary" style="flex:1;">${translations[currentLang].loginBtn}</button>
                <button id="signupActionBtn" class="btn btn-outline" style="flex:1;">${translations[currentLang].signupBtn}</button>
            </div>
        `;

        document.getElementById('loginActionBtn').addEventListener('click', async () => {
            const email = document.getElementById('authEmail').value;
            const password = document.getElementById('authPassword').value;
            const { error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) alert(`Erreur: ${error.message}`);
            else alert('Connexion réussie !');
        });

        document.getElementById('signupActionBtn').addEventListener('click', async () => {
            const email = document.getElementById('authEmail').value;
            const password = document.getElementById('authPassword').value;
            const { error } = await supabase.auth.signUp({ email, password });
            if (error) alert(`Erreur: ${error.message}`);
            else alert('Compte créé ! Vérifiez votre boîte mail.');
        });
    }
}

// --- 2. Load Services directly from Supabase ---
async function loadServicesFromDB() {
    const { data: services, error } = await supabase.from('services').select('*');
    if (error || !services) return;

    const servicesList = document.getElementById('servicesList');
    const selectBox = document.getElementById('bookingServiceSelect');

    if (servicesList) servicesList.innerHTML = '';
    if (selectBox) selectBox.innerHTML = '';

    services.forEach((s) => {
        const title = escapeHtml(currentLang === 'ar' ? s.name_ar : s.name_fr);
        const price = escapeHtml(s.price);

        if (servicesList) {
            servicesList.innerHTML += `
                <div class="service-item">
                    <div class="service-details">
                        <h4>${title}</h4>
                        <span class="service-time">${escapeHtml(s.duration_minutes)} min</span>
                    </div>
                    <span class="service-price">${price} €</span>
                </div>
            `;
        }

        if (selectBox) {
            selectBox.innerHTML += `<option value="${escapeHtml(s.id)}">${title} - ${price} €</option>`;
        }
    });
}

// --- 3. Load Haircuts Gallery from Supabase ---
async function loadHaircutsFromDB() {
    const { data: haircuts, error } = await supabase.from('haircuts').select('*');
    const grid = document.getElementById('cutsGrid');
    if (!grid) return;

    if (error || !haircuts || haircuts.length === 0) {
        // Keep the sample cards from index.html when the DB has no haircuts yet
        if (grid.children.length > 0) return;
        grid.innerHTML = `<p style="text-align:center; color:var(--text-secondary); padding:20px;">
            ${currentLang === 'ar' ? 'لا توجد قصات حالياً في قاعدة البيانات. يمكن للحلاق إضافتها من لوحة التحكم.' : 'Aucune coupe disponible pour le moment.'}
        </p>`;
        return;
    }

    grid.innerHTML = '';
    haircuts.forEach((cut) => {
        const title = escapeHtml(currentLang === 'ar' ? cut.title_ar : cut.title_fr);
        const desc = escapeHtml(currentLang === 'ar' ? cut.desc_ar : cut.desc_fr);
        // Only allow http(s) image URLs; anything else falls back to the logo
        const imageUrl = /^https?:\/\//i.test(cut.image_url ?? '') ? escapeHtml(cut.image_url) : 'logozeyd.jpeg';

        grid.innerHTML += `
            <div class="cut-card">
                <div class="cut-image">
                    <img src="${imageUrl}" alt="${title}" onerror="this.src='logozeyd.jpeg'">
                    <span class="cut-price">${escapeHtml(cut.price)} €</span>
                    <button class="like-btn" data-haircut-id="${escapeHtml(cut.id)}">
                        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                        <span class="like-count">${Number(cut.likes_count) || 0}</span>
                    </button>
                </div>
                <div class="cut-info">
                    <h3>${title}</h3>
                    <p class="cut-desc">${desc}</p>
                </div>
            </div>
        `;
    });
}

// --- 3b. Likes (one per user, stored in haircut_likes) ---
function initLikes() {
    const grid = document.getElementById('cutsGrid');
    if (!grid) return;

    grid.addEventListener('click', (e) => {
        const btn = e.target.closest('.like-btn[data-haircut-id]');
        if (btn) handleLike(btn);
    });

    markUserLikes();
}

async function markUserLikes() {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;

    const { data: likes } = await supabase.from('haircut_likes').select('haircut_id').eq('user_id', session.user.id);
    likes?.forEach(({ haircut_id }) => {
        document.querySelector(`.like-btn[data-haircut-id="${CSS.escape(haircut_id)}"]`)?.classList.add('liked');
    });
}

async function handleLike(btn) {
    if (!currentUser) {
        alert(currentLang === 'ar' ? 'يرجى تسجيل الدخول أولاً للتصويت!' : 'Veuillez vous connecter pour voter !');
        document.getElementById('accountModal').classList.add('open');
        return;
    }
    if (btn.classList.contains('liked') || btn.disabled) return;

    btn.disabled = true;
    const { error } = await supabase
        .from('haircut_likes')
        .insert([{ haircut_id: btn.dataset.haircutId, user_id: currentUser.id }]);
    btn.disabled = false;

    // 23505 = unique violation: this user already liked this haircut
    if (error && error.code !== '23505') {
        alert(`Erreur: ${error.message}`);
        return;
    }

    btn.classList.add('liked');
    if (!error) {
        const count = btn.querySelector('.like-count');
        count.textContent = (Number(count.textContent) || 0) + 1;
    }
}

// --- 4. Handle Real DB Bookings ---
function initBookingForm() {
    const slotBtns = document.querySelectorAll('.slot-btn:not(.disabled)');
    let selectedTime = null;

    slotBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            slotBtns.forEach((b) => {
                b.classList.remove('selected');
            });
            btn.classList.add('selected');
            selectedTime = btn.getAttribute('data-time');
        });
    });

    document.getElementById('confirmBookingBtn')?.addEventListener('click', async () => {
        if (!currentUser) {
            alert(
                currentLang === 'ar' ? 'يرجى تسجيل الدخول أولاً لحجز موعد!' : 'Veuillez vous connecter pour réserver !',
            );
            document.getElementById('accountModal').classList.add('open');
            return;
        }

        const serviceId = document.getElementById('bookingServiceSelect').value;
        const date = document.getElementById('bookingDate').value;
        const customTime = document.getElementById('customTimeInput').value;

        if (!date || (!selectedTime && !customTime)) {
            alert(currentLang === 'ar' ? 'يرجى اختيار التاريخ والوقت.' : "Veuillez choisir la date et l'heure.");
            return;
        }

        const finalTime = customTime || selectedTime;

        // Insert directly into Supabase Bookings Table
        const { error } = await supabase.from('bookings').insert([
            {
                customer_id: currentUser.id,
                service_id: serviceId,
                booking_date: date,
                booking_time: finalTime,
                is_custom_time: !!customTime,
            },
        ]);

        if (error) {
            alert(`Erreur de réservation: ${error.message}`);
        } else {
            alert(currentLang === 'ar' ? 'تم تسجيل حجزك الحقيقي بنجاح!' : 'Réservation enregistrée avec succès !');
        }
    });
}

// --- 5. Language & Theme Helpers ---
function initTheme() {
    const themeBtn = document.getElementById('themeToggleBtn');
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);

    themeBtn?.addEventListener('click', () => {
        const active = document.documentElement.getAttribute('data-theme');
        const next = active === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
    });
}

function initLanguage() {
    const langBtn = document.getElementById('langToggleBtn');
    langBtn?.addEventListener('click', () => {
        currentLang = currentLang === 'fr' ? 'ar' : 'fr';
        localStorage.setItem('lang', currentLang);
        location.reload();
    });
}

function initModals() {
    const modal = document.getElementById('accountModal');
    document.getElementById('accountNavBtn')?.addEventListener('click', () => modal.classList.add('open'));
    document.querySelectorAll('.close-modal').forEach((b) => {
        b.addEventListener('click', () => modal.classList.remove('open'));
    });
}

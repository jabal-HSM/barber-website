// Messages to Zeyd (Telegram) for the staff notification queue: customer cancellations and reschedulings.
// The database decides what to send (staff_notification_claim gives each notification to one sender only);
// this module only formats the text and records the result. No e-mail or phone number is ever included.

export type NotificationData = {
    customer_name?: string | null;
    starts_at?: string | null;
    new_starts_at?: string | null;
    service_fr?: string | null;
    service_ar?: string | null;
    reason_code?: string | null;
    details?: string | null;
};

type Lang = 'fr' | 'ar';

const TEXT = {
    fr: {
        cancellation: '❌ Rendez-vous annulé par le client',
        reschedule: '🔁 Rendez-vous déplacé par le client',
        customer: 'Client',
        date: 'Date',
        time: 'Heure',
        newSlot: 'Nouveau créneau',
        service: 'Prestation',
        reason: 'Motif',
        details: 'Précisions',
        reasons: {
            reschedule: 'Souhaite changer l’heure',
            unavailable: 'N’est plus disponible',
            time_unsuitable: 'L’horaire ne convient pas',
            dissatisfied: 'Quelque chose ne convient pas',
            price_service: 'Prix ou prestation',
            other: 'Autre raison',
        } as Record<string, string>,
        noReason: 'Non précisé',
    },
    ar: {
        cancellation: '❌ ألغى الزبون موعده',
        reschedule: '🔁 غيّر الزبون موعده',
        customer: 'الزبون',
        date: 'التاريخ',
        time: 'الساعة',
        newSlot: 'الموعد الجديد',
        service: 'الخدمة',
        reason: 'السبب',
        details: 'تفاصيل',
        reasons: {
            reschedule: 'يريد تغيير الوقت',
            unavailable: 'لم يعد يستطيع الحضور',
            time_unsuitable: 'الوقت غير مناسب',
            dissatisfied: 'شيء ما لم يناسبه',
            price_service: 'السعر أو الخدمة',
            other: 'سبب آخر',
        } as Record<string, string>,
        noReason: 'غير محدد',
    },
};

const TIME_ZONE = 'Europe/Paris';

function day(iso: string, lang: Lang): string {
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-u-nu-latn' : 'fr-FR', {
        timeZone: TIME_ZONE,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
    }).format(new Date(iso));
}

function time(iso: string): string {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(
        new Date(iso),
    );
}

// Free text from a customer: shortened, and stripped of anything that could look like markup
const clean = (value: string | null | undefined, max = 300) =>
    String(value ?? '')
        .replace(/[<>]/g, '')
        .trim()
        .slice(0, max);

export function staffMessage(kind: string, data: NotificationData, lang: Lang = 'fr'): string {
    const t = TEXT[lang] ?? TEXT.fr;
    const lines = [kind === 'reschedule' ? t.reschedule : t.cancellation];
    lines.push(`${t.customer} : ${clean(data.customer_name, 80) || '—'}`);
    if (data.starts_at) {
        lines.push(`${t.date} : ${day(data.starts_at, lang)}`);
        lines.push(`${t.time} : ${time(data.starts_at)}`);
    }
    if (kind === 'reschedule' && data.new_starts_at) {
        lines.push(`${t.newSlot} : ${day(data.new_starts_at, lang)} ${time(data.new_starts_at)}`);
    }
    const service = lang === 'ar' ? data.service_ar || data.service_fr : data.service_fr;
    if (service) lines.push(`${t.service} : ${clean(service, 80)}`);
    if (kind !== 'reschedule') {
        lines.push(`${t.reason} : ${(data.reason_code && t.reasons[data.reason_code]) || t.noReason}`);
    }
    const details = clean(data.details);
    if (details) lines.push(`${t.details} : ${details}`);
    return lines.join('\n');
}

type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;
type Send = (text: string) => Promise<{ ok: true } | { ok: false; error: string }>;

export type DeliveryResult = 'sent' | 'failed' | 'not_configured' | 'nothing_to_send';

// Claims one notification (by id, or by booking for the customer's own cancellation), sends it once, records
// the outcome. A failure never touches the booking: the cancellation is already stored.
export async function deliverStaffNotification(
    deps: { rpc: Rpc; send: Send | null; lang?: Lang },
    target: { notificationId?: string | null; bookingId?: string | null; retry?: boolean },
): Promise<DeliveryResult> {
    const claimed = (await deps.rpc('staff_notification_claim', {
        p_id: target.notificationId ?? null,
        p_booking_id: target.bookingId ?? null,
        p_retry: Boolean(target.retry),
    })) as { id: string; kind: string; data: NotificationData }[];
    const item = claimed?.[0];
    if (!item) return 'nothing_to_send';

    if (!deps.send) {
        await deps.rpc('staff_notification_result', { p_id: item.id, p_status: 'not_configured', p_error: null });
        return 'not_configured';
    }
    const result = await deps.send(staffMessage(item.kind, item.data ?? {}, deps.lang ?? 'fr'));
    if (result.ok) {
        await deps.rpc('staff_notification_result', { p_id: item.id, p_status: 'sent', p_error: null });
        return 'sent';
    }
    await deps.rpc('staff_notification_result', { p_id: item.id, p_status: 'failed', p_error: result.error });
    return 'failed';
}

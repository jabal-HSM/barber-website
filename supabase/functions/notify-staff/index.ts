// POST /functions/v1/notify-staff
//   { booking_id }                       after a customer's own cancellation (any signed-in user)
//   { notification_id, retry: true }     re-send a failed message (staff only, from the dashboard)
// Sends Zeyd a Telegram message for a queued staff notification. The token stays here (Supabase secrets
// TELEGRAM_BOT_TOKEN + TELEGRAM_STAFF_CHAT_ID); the content comes from the database, never from the request.
// Each notification is claimed in the database first, so a refresh or a double call never sends it twice.
import { deliverStaffNotification } from '../_shared/staffNotify.ts';
import { getUser, serviceRpc } from '../_shared/supabase.ts';
import { sendTelegramMessage } from '../_shared/telegram.ts';

const env = (name: string) => Deno.env.get(name);
const UUID = /^[0-9a-f-]{36}$/i;

function corsHeaders(origin: string | null): Record<string, string> {
    const allowed = (env('ALLOWED_ORIGINS') ?? env('SITE_URL') ?? '')
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''));
    return {
        'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : (allowed[0] ?? ''),
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        Vary: 'Origin',
    };
}

// is_staff() evaluated with the caller's own token: the role is checked by the database, not by this code
async function callerIsStaff(authorization: string): Promise<boolean> {
    const response = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/is_staff`, {
        method: 'POST',
        headers: {
            apikey: env('SUPABASE_ANON_KEY') ?? '',
            Authorization: authorization,
            'Content-Type': 'application/json',
        },
        body: '{}',
    });
    return response.ok && (await response.json()) === true;
}

Deno.serve(async (req) => {
    const cors = corsHeaders(req.headers.get('Origin'));
    const reply = (status: number, body: Record<string, unknown>) =>
        new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });

    const authorization = req.headers.get('Authorization');
    const user = await getUser(env, authorization);
    if (!user || !authorization) return reply(401, { error: 'auth_required' });

    const body = (await req.json().catch(() => ({}))) as {
        booking_id?: string;
        notification_id?: string;
        retry?: boolean;
    };
    const bookingId = body.booking_id && UUID.test(body.booking_id) ? body.booking_id : null;
    const notificationId = body.notification_id && UUID.test(body.notification_id) ? body.notification_id : null;
    if (!bookingId && !notificationId) return reply(400, { error: 'not_found' });
    // Re-sending (or choosing a notification by id) is for Zeyd / admins only
    if (notificationId && !(await callerIsStaff(authorization))) return reply(403, { error: 'forbidden' });

    const token = env('TELEGRAM_BOT_TOKEN') ?? '';
    const chatId = env('TELEGRAM_STAFF_CHAT_ID') ?? '';
    const send = token && chatId ? (text: string) => sendTelegramMessage(fetch, token, chatId, text) : null;

    try {
        const status = await deliverStaffNotification(
            { rpc: serviceRpc(env), send, lang: env('TELEGRAM_STAFF_LANG') === 'ar' ? 'ar' : 'fr' },
            { bookingId, notificationId, retry: Boolean(notificationId && body.retry) },
        );
        return reply(200, { status });
    } catch (error) {
        console.error('notify_staff_error', (error as Error).message);
        return reply(500, { error: 'notify_failed' });
    }
});

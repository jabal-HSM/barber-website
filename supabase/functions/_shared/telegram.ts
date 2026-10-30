// Telegram Bot API, server side only. The token is never logged nor returned.

// Exact text requested by the project owner, sent once per confirmed real payment.
export const PAYMENT_MESSAGE =
    'برافو عليك يا هاشم 5 يورو وانت بارك انت اسطوري شفت شلون تعبك بلش يشتغل وربك عم يفتح عليك صلي على النبي🫂';

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function sendTelegramMessage(
    fetchImpl: FetchLike,
    token: string,
    chatId: string,
    text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!token || !chatId) return { ok: false, error: 'telegram_not_configured' };
    try {
        const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
        });
        if (response.ok) return { ok: true };
        const body = (await response.json().catch(() => ({}))) as { description?: string };
        // Telegram's description never contains the token
        return { ok: false, error: `telegram_${response.status}: ${body.description ?? 'error'}` };
    } catch (_error) {
        return { ok: false, error: 'telegram_network_error' };
    }
}

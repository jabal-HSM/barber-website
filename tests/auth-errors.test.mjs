// Sign-up / sign-in errors returned by Supabase Auth → a clear message, never the generic one when the cause is known.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorCode } from '../Zeyd/api.js';
import { translations } from '../Zeyd/i18n.js';

const cases = [
    [{ code: 'user_already_exists', message: 'User already registered' }, 'email_taken'],
    [{ code: 'email_exists', message: 'Email address already exists' }, 'email_taken'],
    [{ code: 'weak_password', message: 'Password should be at least 8 characters.' }, 'weak_password'],
    [{ code: 'email_address_invalid', message: 'Email address "a@b" is invalid' }, 'invalid_email'],
    [{ message: 'Unable to validate email address: invalid format' }, 'invalid_email'],
    [{ code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' }, 'rate_limited'],
    [{ code: 'unexpected_failure', status: 500, message: 'Error sending confirmation email' }, 'email_send_failed'],
    [{ code: 'signup_disabled', message: 'Signups not allowed for this instance' }, 'signup_disabled'],
    [{ name: 'AuthRetryableFetchError', message: 'Failed to fetch' }, 'network'],
    [{ code: 'invalid_credentials', message: 'Invalid login credentials' }, 'invalid_credentials'],
    [{ code: 'email_not_confirmed', message: 'Email not confirmed' }, 'email_not_confirmed'],
    [{ message: 'something new' }, 'unknown'],
];

test('each Supabase Auth error gets its own message', () => {
    for (const [error, expected] of cases) assert.equal(errorCode(error), expected, JSON.stringify(error));
});

test('booking errors from the database keep their meaning', () => {
    assert.equal(errorCode({ message: 'slot_unavailable' }), 'slot_unavailable');
    assert.equal(errorCode({ code: '42501', message: 'permission denied for function x' }), 'auth_required');
});

test('every auth message exists in French and Arabic, and none points to WhatsApp', () => {
    for (const [, key] of cases) {
        for (const lang of ['fr', 'ar']) {
            const text = translations[lang][`error.${key}`];
            assert.ok(text, `error.${key} missing in ${lang}`);
            assert.doesNotMatch(text, /whatsapp/i, `error.${key} (${lang}) mentions WhatsApp`);
        }
    }
});

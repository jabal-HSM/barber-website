// Return from the confirmation email: the URLs below are the exact shapes Supabase sends back
// (the error one was captured from zeyd-dev-1 /auth/v1/verify on 2026-10-31).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanAuthUrl, parseAuthRedirect } from '../Zeyd/authRedirect.js';

test('an expired or already used link is recognised', () => {
    const hash =
        '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=';
    assert.deepEqual(parseAuthRedirect(hash, ''), { kind: 'error', reason: 'link_expired' });
});

test('any other error, in the hash or the query string, is a failed link', () => {
    assert.deepEqual(parseAuthRedirect('#error=server_error&error_description=x', ''), {
        kind: 'error',
        reason: 'link_failed',
    });
    assert.deepEqual(parseAuthRedirect('', '?error=access_denied&error_code=unexpected_failure'), {
        kind: 'error',
        reason: 'link_failed',
    });
});

test('a successful confirmation carries a session to restore', () => {
    const hash = '#access_token=a.b.c&expires_in=3600&refresh_token=r&token_type=bearer&type=signup';
    assert.deepEqual(parseAuthRedirect(hash, ''), { kind: 'session', type: 'signup' });
    assert.deepEqual(parseAuthRedirect('', '?code=123'), { kind: 'session', type: 'signup' });
});

test('normal visits and section links are ignored', () => {
    assert.equal(parseAuthRedirect('', ''), null);
    assert.equal(parseAuthRedirect('#reservation', ''), null);
    assert.equal(parseAuthRedirect('#services', '?lang=ar'), null);
});

test('the cleaned address keeps the page and its other parameters only', () => {
    assert.equal(cleanAuthUrl('/Zeyd/index.html', ''), '/Zeyd/index.html');
    assert.equal(cleanAuthUrl('/index.html', '?error=x&error_code=otp_expired&sb='), '/index.html');
    assert.equal(cleanAuthUrl('/index.html', '?lang=ar&code=abc'), '/index.html?lang=ar');
});

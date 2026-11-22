// Password change of the dashboard (Zeyd/passwordChange.js). These tests use a FAKE Supabase Auth object: they
// check the order of the calls and that the password is never changed before the code is verified. They do not
// prove that Supabase sends or checks the code; that needs a real account (see PROJECT_STATUS.md).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { confirmPasswordChange, passwordProblem, sendPasswordCode } from '../Zeyd/passwordChange.js';

function fakeAuth({ verify = { data: { user: { id: 'u1' } }, error: null }, update = { error: null } } = {}) {
    const calls = [];
    return {
        calls,
        async signInWithOtp(args) {
            calls.push(['signInWithOtp', args]);
            return { data: {}, error: null };
        },
        async verifyOtp(args) {
            calls.push(['verifyOtp', args]);
            return verify;
        },
        async updateUser(args) {
            calls.push(['updateUser', args]);
            return update;
        },
    };
}

const valid = {
    email: 'zeyd@example.test',
    userId: 'u1',
    code: ' 123456 ',
    password: 'nouveau-mdp-1',
    repeat: 'nouveau-mdp-1',
};

describe('password change (fake Supabase Auth)', () => {
    test('the code is asked for the account e-mail, without ever creating a user', async () => {
        const auth = fakeAuth();
        await sendPasswordCode(auth, 'zeyd@example.test');
        assert.deepEqual(auth.calls, [
            ['signInWithOtp', { email: 'zeyd@example.test', options: { shouldCreateUser: false } }],
        ]);
    });

    test('form checks: code format, 8 characters, same password twice', () => {
        assert.equal(
            passwordProblem({ code: '12ab', password: 'abcdefgh', repeat: 'abcdefgh' }),
            'password.error.code_format',
        );
        assert.equal(
            passwordProblem({ code: '123456', password: 'short', repeat: 'short' }),
            'password.error.too_short',
        );
        assert.equal(
            passwordProblem({ code: '123456', password: 'abcdefgh', repeat: 'abcdefgX' }),
            'password.error.mismatch',
        );
        assert.equal(passwordProblem({ code: '123456', password: 'abcdefgh', repeat: 'abcdefgh' }), null);
    });

    test('a refused form calls nothing', async () => {
        const auth = fakeAuth();
        const result = await confirmPasswordChange(auth, { ...valid, repeat: 'autre' });
        assert.deepEqual(result, { errorKey: 'password.error.mismatch' });
        assert.deepEqual(auth.calls, []);
    });

    test('a wrong or expired code: the password is NOT changed', async () => {
        const error = { code: 'otp_expired', message: 'Token has expired or is invalid' };
        const auth = fakeAuth({ verify: { data: { user: null }, error } });
        const result = await confirmPasswordChange(auth, valid);
        assert.equal(result.error, error);
        assert.deepEqual(
            auth.calls.map(([name]) => name),
            ['verifyOtp'],
        );
    });

    test('a code that belongs to another account: the password is NOT changed', async () => {
        const auth = fakeAuth({ verify: { data: { user: { id: 'someone-else' } }, error: null } });
        assert.deepEqual(await confirmPasswordChange(auth, valid), { errorKey: 'password.error.other' });
        assert.ok(!auth.calls.some(([name]) => name === 'updateUser'));
    });

    test('a valid code: verified first, then the new password is set', async () => {
        const auth = fakeAuth();
        assert.deepEqual(await confirmPasswordChange(auth, valid), { ok: true });
        assert.deepEqual(auth.calls, [
            ['verifyOtp', { email: 'zeyd@example.test', token: '123456', type: 'email' }],
            ['updateUser', { password: 'nouveau-mdp-1' }],
        ]);
    });

    test('Supabase refusing the new password is reported, not hidden', async () => {
        const error = { code: 'same_password', message: 'New password should be different' };
        const auth = fakeAuth({ update: { error } });
        assert.equal((await confirmPasswordChange(auth, valid)).error, error);
    });
});

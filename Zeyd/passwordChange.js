// Password change of the signed-in staff member (dashboard → Réglages), in two steps checked by Supabase Auth:
//   1. sendPasswordCode: signInWithOtp sends a one-time code to the account's own e-mail (never creates a user);
//   2. confirmPasswordChange: verifyOtp checks the code on the server; only when it is valid, and for the same
//      user, updateUser sets the new password.
// The e-mail template « Magic Link » of Supabase must show {{ .Token }} for the code to appear in the message.
// The code and the passwords are never stored, logged or sent anywhere else.

export const MIN_PASSWORD_LENGTH = 8;

// Message key of admin-i18n.js, or null when the form can be sent
export function passwordProblem({ code, password, repeat }) {
    if (!/^\d{6,10}$/.test(String(code ?? '').trim())) return 'password.error.code_format';
    if (String(password ?? '').length < MIN_PASSWORD_LENGTH) return 'password.error.too_short';
    if (password !== repeat) return 'password.error.mismatch';
    return null;
}

export async function sendPasswordCode(auth, email) {
    const { error } = await auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    return { error: error ?? null };
}

// { ok: true } | { errorKey } (checked here) | { error } (answer of Supabase)
export async function confirmPasswordChange(auth, { email, userId, code, password, repeat }) {
    const problem = passwordProblem({ code, password, repeat });
    if (problem) return { errorKey: problem };
    const { data, error } = await auth.verifyOtp({ email, token: String(code).trim(), type: 'email' });
    if (error) return { error };
    if (!data?.user || data.user.id !== userId) return { errorKey: 'password.error.other' };
    const { error: updateError } = await auth.updateUser({ password });
    return updateError ? { error: updateError } : { ok: true };
}

import { useLayoutEffect, useState } from 'react';
import pageCss from '../styles/register.page.css?raw';

const MailIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" />
    </svg>
);

export default function ForgotPasswordPage() {
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');
    const [sent, setSent] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    useLayoutEffect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-page', 'forgot');
        styleEl.textContent = pageCss;
        document.head.appendChild(styleEl);
        const prevTitle = document.title;
        document.title = 'Reset password · DriveSync';
        return () => { styleEl.remove(); document.title = prevTitle; };
    }, []);

    async function handleSubmit(ev) {
        ev.preventDefault();
        if (submitting) return;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Enter a valid email.'); return; }
        setSubmitting(true);
        setError('');
        try {
            const response = await fetch('/api/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim() })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) { setError(data.error || 'Something went wrong.'); return; }
            setSent(true);
        } catch {
            setError('Network error.');
        } finally {
            setSubmitting(false);
        }
    }

    const logo = <div className="rg-icon"><img src="/android-chrome-192x192.png?v=3" alt="DriveSync" /></div>;

    if (sent) {
        return (
            <div className="register-page">
                <div className="rg-card">
                    <div className="rg-status info"><MailIcon /></div>
                    <div className="rg-title">
                        <h2>Check your email</h2>
                        <p>We've sent a reset link to <strong>{email.trim()}</strong>.</p>
                    </div>
                    <p className="rg-note">The link is valid for <strong>10 minutes</strong> and works only once. Also check your spam folder.</p>
                    <button type="button" className="rg-btn rg-btn-ghost" onClick={() => setSent(false)}>Use a different email</button>
                    <div className="rg-foot"><a href="/">Back to sign in</a></div>
                </div>
            </div>
        );
    }

    return (
        <div className="register-page">
            <form className="rg-card" onSubmit={handleSubmit} noValidate>
                {logo}
                <div className="rg-title">
                    <h2>Forgot password?</h2>
                    <p>Enter your account email and we'll send you a link to reset your password.</p>
                </div>
                <input className="rg-input" type="email" placeholder="Email" maxLength={254}
                    autoComplete="username" autoCapitalize="off" spellCheck={false} autoFocus
                    value={email} onChange={e => { setEmail(e.target.value); if (error) setError(''); }} />
                {error && <div className="rg-error" role="alert">{error}</div>}
                <button type="submit" className="rg-btn" disabled={submitting}>
                    {submitting ? 'Sending…' : 'Send reset link'}
                </button>
                <div className="rg-foot"><a href="/">Back to sign in</a></div>
            </form>
        </div>
    );
}

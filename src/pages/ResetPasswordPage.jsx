import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import pageCss from '../styles/register.page.css?raw';
import { getLastAvatar } from '../lib/rememberedAccount.js';

const Svg = ({ children }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const CheckIcon = () => <Svg><path d="M20 6 9 17l-5-5" /></Svg>;
const ClockIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
const EyeIcon = () => <Svg><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Svg>;
const EyeOffIcon = () => <Svg><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-6.5 0-10-7-10-7a17.6 17.6 0 0 1 4.1-4.9M9.9 5.2A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a17.7 17.7 0 0 1-2.2 3.1M3 3l18 18" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></Svg>;

const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function strength(pw) {
    if (!pw) return 0;
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
    return Math.max(1, score);
}
const LABELS = ['', 'Weak', 'Okay', 'Good', 'Strong'];

function PasswordField({ value, onChange, placeholder, autoFocus }) {
    const [show, setShow] = useState(false);
    return (
        <div className="rg-field">
            <input className="rg-input" type={show ? 'text' : 'password'} placeholder={placeholder}
                autoComplete="new-password" autoFocus={autoFocus} value={value} onChange={onChange} />
            <button type="button" className="rg-eye" onClick={() => setShow(s => !s)}
                aria-label={show ? 'Hide password' : 'Show password'}>
                {show ? <EyeOffIcon /> : <EyeIcon />}
            </button>
        </div>
    );
}

export default function ResetPasswordPage() {
    const token = useMemo(() => new URLSearchParams(window.location.search).get('token') || '', []);
    const [valid, setValid] = useState(null); // null = checking
    const [secondsLeft, setSecondsLeft] = useState(0);
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [done, setDone] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    useLayoutEffect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-page', 'reset');
        styleEl.textContent = pageCss;
        document.head.appendChild(styleEl);
        const prevTitle = document.title;
        document.title = 'New password · DriveSync';
        return () => { styleEl.remove(); document.title = prevTitle; };
    }, []);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/reset-password?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
            .then(r => r.json())
            .then(d => {
                if (cancelled) return;
                setValid(Boolean(d.valid));
                setSecondsLeft(Number(d.expiresIn) || 0);
            })
            .catch(() => { if (!cancelled) setValid(false); });
        return () => { cancelled = true; };
    }, [token]);

    // Live countdown; flips the page to "expired" the moment time runs out.
    useEffect(() => {
        if (!valid || done) return undefined;
        const id = setInterval(() => {
            setSecondsLeft(s => {
                if (s <= 1) { setValid(false); return 0; }
                return s - 1;
            });
        }, 1000);
        return () => clearInterval(id);
    }, [valid, done]);

    // Once the password is changed, take the (now dead) token out of the address bar
    // and send the person to sign in.
    useEffect(() => {
        if (!done) return undefined;
        window.history.replaceState(null, '', '/reset-password');
        const id = setTimeout(() => { window.location.href = '/'; }, 4000);
        return () => clearTimeout(id);
    }, [done]);

    async function handleSubmit(ev) {
        ev.preventDefault();
        if (submitting) return;
        if (!password) { setError('Enter a new password.'); return; }
        if (password !== confirm) { setError('Passwords do not match.'); return; }
        setSubmitting(true);
        setError('');
        try {
            const response = await fetch('/api/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, password })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (/invalid|expired|used/i.test(data.error || '')) { setValid(false); return; }
                setError(data.error || 'Something went wrong.');
                return;
            }
            setDone(true);
        } catch {
            setError('Network error.');
        } finally {
            setSubmitting(false);
        }
    }

    const savedAvatar = getLastAvatar();
    const logo = (
        <div className={`rg-icon${savedAvatar ? ' rg-icon-photo' : ''}`}>
            <img src={savedAvatar || '/android-chrome-192x192.png?v=3'} alt={savedAvatar ? 'Profile photo' : 'DriveSync'} />
        </div>
    );

    if (done) {
        return (
            <div className="register-page">
                <div className="rg-card">
                    <div className="rg-status ok"><CheckIcon /></div>
                    <div className="rg-title">
                        <h2>Password updated</h2>
                        <p>Your password has been changed and this reset link no longer works.</p>
                    </div>
                    <a className="rg-btn" href="/">Sign in</a>
                    <p className="rg-note">Redirecting to sign in…</p>
                </div>
            </div>
        );
    }

    if (valid === null) {
        return (
            <div className="register-page">
                <div className="rg-card" aria-busy="true">
                    <div className="rg-spinner" />
                    <p className="rg-note">Checking your reset link…</p>
                </div>
            </div>
        );
    }

    if (valid === false) {
        return (
            <div className="register-page">
                <div className="rg-card">
                    <div className="rg-status warn"><ClockIcon /></div>
                    <div className="rg-title">
                        <h2>Link expired</h2>
                        <p>This reset link is invalid, has expired (links last 10 minutes), or was already used.</p>
                    </div>
                    <a className="rg-btn" href="/forgot-password">Send a new link</a>
                    <div className="rg-foot"><a href="/">Back to sign in</a></div>
                </div>
            </div>
        );
    }

    const level = strength(password);
    const mismatch = confirm.length > 0 && password !== confirm;
    const match = confirm.length > 0 && password === confirm;

    return (
        <div className="register-page">
            <form className="rg-card" onSubmit={handleSubmit} noValidate>
                {logo}
                <div className="rg-title">
                    <h2>Set a new password</h2>
                    <p>Choose any password you like.</p>
                </div>
                <div className={`rg-timer${secondsLeft <= 60 ? ' low' : ''}`} role="timer" aria-live="off">
                    <ClockIcon /> Link expires in {fmt(secondsLeft)}
                </div>
                <PasswordField placeholder="New password" autoFocus value={password}
                    onChange={e => { setPassword(e.target.value); if (error) setError(''); }} />
                {password && (
                    <div className="rg-meter" data-level={level}>
                        <div className="rg-meter-bars"><span /><span /><span /><span /></div>
                        <span className="rg-meter-label">Strength: {LABELS[level]}</span>
                    </div>
                )}
                <PasswordField placeholder="Confirm password" value={confirm}
                    onChange={e => { setConfirm(e.target.value); if (error) setError(''); }} />
                {mismatch && <div className="rg-hint bad">Passwords don't match yet.</div>}
                {match && <div className="rg-hint ok">Passwords match.</div>}
                {error && <div className="rg-error" role="alert">{error}</div>}
                <button type="submit" className="rg-btn" disabled={submitting}>
                    {submitting ? 'Saving…' : 'Reset password'}
                </button>
            </form>
        </div>
    );
}

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import pageCss from '../styles/register.page.css?raw';
import { buildDriveScript, looksLikeFolderId } from '../lib/driveScript.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MACRO_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/.+/i;

// Accepts a bare folder ID or a full Drive folder URL and returns just the ID.
function extractFolderId(value) {
    const v = value.trim();
    const m = v.match(/\/folders\/([A-Za-z0-9_-]+)/) || v.match(/[?&]id=([A-Za-z0-9_-]+)/);
    return m ? m[1] : v;
}

function validate(v) {
    if (!v.label.trim()) return 'Enter your name.';
    if (!EMAIL_RE.test(v.email.trim()) || v.email.trim().length > 254) return 'Enter a valid email.';
    if (!v.password) return 'Enter a password.';
    if (v.password !== v.confirm) return 'Passwords do not match.';
    if (!MACRO_URL_RE.test(v.macroUrl.trim())) return 'Enter a valid Apps Script URL.';
    if (!v.rootFolderId.trim()) return 'Paste your Google Drive folder link.';
    return '';
}

const ICONS = {
    user: <><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
    mail: <><rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></>,
    lock: <><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
    folder: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
    eyeOff: <><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><line x1="2" x2="22" y1="2" y2="22" /></>,
    copy: <><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>,
    check: <path d="M20 6 9 17l-5-5" />,
    alert: <><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></>
};

function Icon({ name, className }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {ICONS[name]}
        </svg>
    );
}

export default function RegisterPage() {
    const [values, setValues] = useState({ label: '', email: '', password: '', confirm: '', macroUrl: '', rootFolderId: '' });
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [enabled, setEnabled] = useState(null);
    const [done, setDone] = useState(false);
    const [copied, setCopied] = useState(false);
    const [showPw, setShowPw] = useState(false);
    const [showPw2, setShowPw2] = useState(false);

    const folderId = values.rootFolderId.trim();
    const script = useMemo(
        () => (looksLikeFolderId(folderId) ? buildDriveScript(folderId) : ''),
        [folderId]
    );

    async function copyScript() {
        try {
            await navigator.clipboard.writeText(script);
        } catch {
            // Fallback for browsers/contexts without the async clipboard API
            const ta = document.createElement('textarea');
            ta.value = script;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch { /* ignore */ }
            ta.remove();
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    useLayoutEffect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-page', 'register');
        styleEl.textContent = pageCss;
        document.head.appendChild(styleEl);
        const prevTitle = document.title;
        document.title = 'Register · DriveSync';
        return () => {
            styleEl.remove();
            document.title = prevTitle;
        };
    }, []);

    // After a successful registration, send the user to the login page.
    useEffect(() => {
        if (!done) return undefined;
        const t = setTimeout(() => { window.location.assign('/'); }, 2000);
        return () => clearTimeout(t);
    }, [done]);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/register')
            .then(r => r.json())
            .then(d => { if (!cancelled) setEnabled(Boolean(d.enabled)); })
            .catch(() => { if (!cancelled) setEnabled(true); });
        return () => { cancelled = true; };
    }, []);

    const set = (name) => (e) => {
        const val = name === 'rootFolderId' ? extractFolderId(e.target.value) : e.target.value;
        setValues(v => ({ ...v, [name]: val }));
        if (error) setError('');
    };

    async function handleSubmit(ev) {
        ev.preventDefault();
        if (submitting) return;

        const cleaned = { ...values, rootFolderId: extractFolderId(values.rootFolderId) };
        setValues(cleaned);
        const msg = validate(cleaned);
        if (msg) { setError(msg); return; }

        setSubmitting(true);
        setError('');
        try {
            const response = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    label: cleaned.label.trim(),
                    email: cleaned.email.trim(),
                    password: cleaned.password,
                    macroUrl: cleaned.macroUrl.trim(),
                    rootFolderId: cleaned.rootFolderId.trim()
                })
            });
            let data;
            try { data = await response.json(); } catch { throw new Error('Invalid server response.'); }

            if (!response.ok || !data.success) {
                if (response.status === 403) setEnabled(false);
                else setError(data.error || 'Registration failed.');
                return;
            }
            const email = data.email || cleaned.email.trim().toLowerCase();
            try { sessionStorage.setItem('drivesync_registered_email', email); } catch { /* storage may be blocked */ }
            setDone(true);
        } catch (err) {
            setError(err.message || 'Network error.');
        } finally {
            setSubmitting(false);
        }
    }

    const logo = (
        <div className="rg-icon"><img src="/android-chrome-192x192.png?v=3" alt="DriveSync" /></div>
    );

    if (done) {
        return (
            <div className="register-page">
                <div className="rg-card rg-reg rg-reg-center">
                    <div className="rg-status ok"><Icon name="check" /></div>
                    <h2>Account created</h2>
                    <p className="rg-reg-sub">Your Drive is connected and your account is ready.</p>
                    <div className="rg-redirect"><span className="rg-spinner sm" />Redirecting to login…</div>
                </div>
            </div>
        );
    }

    if (enabled === false) {
        return (
            <div className="register-page">
                <div className="rg-card rg-reg rg-reg-center">
                    {logo}
                    <h2>Registration is closed</h2>
                    <p className="rg-reg-sub">New accounts can't be created right now.</p>
                </div>
            </div>
        );
    }

    const folderTyped = folderId.length > 0;

    const mismatch = values.confirm.length > 0 && values.password !== values.confirm;

    return (
        <div className="register-page">
            <form className="rg-card rg-reg rg-wide" onSubmit={handleSubmit} noValidate>
                <aside className="rg-side">
                    {logo}
                    <div className="rg-title">
                        <h2>Create account</h2>
                        <p>Connect your own Google Drive folder to DriveSync</p>
                    </div>
                </aside>

                <div className="rg-main">
                    <div className="rg-grid">
                        <div className="rg-ifield">
                            <input className="rg-input" type="text" placeholder="Name" maxLength={80}
                                autoComplete="name" autoFocus value={values.label} onChange={set('label')} />
                        </div>
                        <div className="rg-ifield">
                            <input className="rg-input" type="email" placeholder="Email" maxLength={254}
                                autoComplete="username" autoCapitalize="off" spellCheck={false}
                                value={values.email} onChange={set('email')} />
                        </div>
                        <div className="rg-ifield">
                            <input className="rg-input rg-has-eye" type={showPw ? 'text' : 'password'} placeholder="Password"
                                autoComplete="new-password" value={values.password} onChange={set('password')} />
                            <button type="button" className="rg-eye" onClick={() => setShowPw(v => !v)}
                                aria-label={showPw ? 'Hide password' : 'Show password'}>
                                <Icon name={showPw ? 'eyeOff' : 'eye'} />
                            </button>
                        </div>
                        <div className="rg-ifield">
                            <input className={'rg-input rg-has-eye' + (mismatch ? ' rg-invalid' : '')} type={showPw2 ? 'text' : 'password'}
                                placeholder="Confirm password" autoComplete="new-password"
                                value={values.confirm} onChange={set('confirm')} />
                            <button type="button" className="rg-eye" onClick={() => setShowPw2(v => !v)}
                                aria-label={showPw2 ? 'Hide password' : 'Show password'}>
                                <Icon name={showPw2 ? 'eyeOff' : 'eye'} />
                            </button>
                        </div>

                        <div className={'rg-folder-row rg-span' + (script ? ' has-copy' : '')}>
                            <div className="rg-ifield">
                                <input className="rg-input" type="text" placeholder="Paste Google Drive folder link"
                                    autoComplete="off" autoCapitalize="off" spellCheck={false}
                                    value={values.rootFolderId} onChange={set('rootFolderId')} />
                            </div>
                            {script && (
                                <button type="button" className={'rg-btn rg-copy-only' + (copied ? ' done' : '')} onClick={copyScript}>
                                    <Icon name={copied ? 'check' : 'copy'} />
                                    {copied ? 'Copied' : 'Copy Script code'}
                                </button>
                            )}
                        </div>

                        {folderTyped && !script && (
                            <div className="rg-hint-line bad rg-span">That doesn't look like a Drive folder link or ID.</div>
                        )}

                        <div className="rg-ifield rg-span">
                            <input className="rg-input" type="text" placeholder="Apps Script URL"
                                autoComplete="off" autoCapitalize="off" spellCheck={false}
                                value={values.macroUrl} onChange={set('macroUrl')} />
                        </div>
                    </div>

                    {error && (
                        <div className="rg-alert" role="alert">
                            <Icon name="alert" />
                            <span>{error}</span>
                        </div>
                    )}

                    <button type="submit" className="rg-btn rg-submit" disabled={submitting || enabled === null}>
                        {submitting ? <><span className="rg-spinner sm" />Creating account…</> : 'Create account'}
                    </button>
                    <div className="rg-foot">Already have an account? <a href="/">Sign in</a></div>
                </div>
            </form>
        </div>
    );
}

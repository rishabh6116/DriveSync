import { useEffect, useLayoutEffect, useState } from 'react';
import installPromptCss from '../styles/install-prompt.css?raw';

// Set the moment the banner actually becomes visible (not just on mount),
// so it only ever shows once — on whichever visit it first has something to show.
const SEEN_KEY = 'drivesync_install_prompt_seen';

function isStandalone() {
    return (
        window.matchMedia?.('(display-mode: standalone)').matches ||
        window.navigator.standalone === true
    );
}

function isIOS() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

/**
 * Small "Install App" banner shown on mobile browsers.
 * - Android/Chrome: captures the native beforeinstallprompt event and triggers it.
 * - iOS Safari: doesn't support that event, so shows manual "Add to Home Screen" steps instead.
 * Stays hidden if already installed, on desktop, or after the first time it's been shown —
 * this is a one-time, first-visit prompt, not a per-session one.
 */
export default function InstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState(null);
    const [showIOSHint, setShowIOSHint] = useState(false);
    const [visible, setVisible] = useState(false);

    useLayoutEffect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-component', 'install-prompt');
        styleEl.textContent = installPromptCss;
        document.head.appendChild(styleEl);
        return () => styleEl.remove();
    }, []);

    useEffect(() => {
        if (isStandalone() || localStorage.getItem(SEEN_KEY)) return;
        if (window.innerWidth >= 768) return; // mobile/PWA banner only

        const markSeen = () => localStorage.setItem(SEEN_KEY, '1');

        const handleBeforeInstall = (e) => {
            e.preventDefault();
            setDeferredPrompt(e);
            setVisible(true);
            markSeen();
        };
        window.addEventListener('beforeinstallprompt', handleBeforeInstall);

        // iOS never fires beforeinstallprompt — show manual instructions instead.
        if (isIOS()) {
            setShowIOSHint(true);
            setVisible(true);
            markSeen();
        }

        return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
    }, []);

    const dismiss = () => setVisible(false);

    const handleInstall = async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        setDeferredPrompt(null);
        setVisible(false);
    };

    if (!visible) return null;

    return (
        <div className="install-prompt">
            <div className="install-prompt-card">
                <div className="install-prompt-icon">
                    <img src="/android-chrome-192x192.png?v=3" alt="DriveSync" />
                </div>
                <div className="install-prompt-body">
                    <p className="install-prompt-title">Install DriveSync</p>
                    {showIOSHint ? (
                        <p className="install-prompt-sub">
                            Tap <i className="ti ti-share-2" aria-hidden="true"></i> Share, then "Add to Home Screen".
                        </p>
                    ) : (
                        <p className="install-prompt-sub">Add the app for quicker, full-screen access to your drive.</p>
                    )}
                    {!showIOSHint && (
                        <button type="button" className="install-prompt-btn" onClick={handleInstall}>
                            <i className="ti ti-download" aria-hidden="true"></i> Install
                        </button>
                    )}
                </div>
                <button type="button" className="install-prompt-close" onClick={dismiss} aria-label="Dismiss">
                    <i className="ti ti-x" aria-hidden="true"></i>
                </button>
            </div>
        </div>
    );
}

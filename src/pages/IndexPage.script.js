import { markTabActive, isSameTabSession, clearTabMarker } from '../lib/tabSession.js';
import { getMaskedValue, clearMaskedInput } from '../lib/maskedInput.js';
import {
    ensureNotesFolder, listNotes, loadNoteContent, createNote, saveNoteContent, deleteNote,
} from '../lib/notes.js';

export function initIndexPage() {
        // Config settings fetched seamlessly from upstream runtime memory
        let MACRO_WEBAPP_URL = '';
        let ROOT_FOLDER_ID = '';

        let driveItems = [];
        let currentPreviewList = [];
        let currentPreviewIndex = -1;
        let currentFolderId = null;
        let parentFolderId = null;
        let activeFilterGroup = 'all';
        let folderPathStack = [];
        let folderForwardStack = [];
        let pendingDeleteTarget = null;
        let pendingRenameTarget = null;
        let notesFolderId = null;
        let currentMainMode = 'drive';

        // --- Deep (recursive) search across subfolders ---
        // deepSearchResults stays null while not actively showing crawled
        // results (normal current-folder view); once populated it's the flat
        // list of matches gathered from the current folder and everything
        // beneath it.
        let deepSearchToken = 0;
        let deepSearchResults = null;
        let deepSearchLoading = false;
        let deepSearchDebounceTimer = null;

        // --- Fast load-up: folder listing cache ---
        // Keyed by folderId -> { items, currentFolderId, parentFolderId, timestamp }.
        // A cached entry is shown instantly (no spinner) while a fresh copy is
        // fetched quietly in the background ("stale-while-revalidate"), so
        // revisiting a folder (back/forward, re-opening) feels instant instead
        // of re-running the full Drive round trip every time.
        const folderCache = new Map();
        const FOLDER_CACHE_TTL_MS = 2 * 60 * 1000; // treat cache as fresh enough to skip a background refetch for this long
        const prefetchInFlight = new Set();
        let activeLoadRequestId = 0; // guards against a slow background response clobbering a newer navigation

        // Storage quota used to be re-fetched on every single folder
        // navigation. It now lives behind its own action and is only
        // refreshed occasionally.
        let lastStorageFetchAt = 0;
        const STORAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

        // Session/auto-logout behavior — controlled by the admin from the
        // "Feature Access" view in /admin.html (see /api/session-settings).
        // Defaults here are just a fail-safe until that fetch resolves.
        let SESSION_MODE = 'timeout';
        let PERSIST_ACROSS_TAB_CLOSE = false;
        let IDLE_TIMEOUT_MS = 2 * 60 * 1000;
        let idleTimer;
        let idleListenersAttached = false;

        async function refreshSessionSettingsAndArm() {
            try {
                const response = await fetch('/api/session-settings');
                const data = await response.json();
                SESSION_MODE = data.mode === 'never' ? 'never' : 'timeout';
                const minutes = Number(data.timeoutMinutes);
                IDLE_TIMEOUT_MS = (Number.isFinite(minutes) && minutes > 0 ? minutes : 2) * 60 * 1000;
                PERSIST_ACROSS_TAB_CLOSE = !!data.persistAcrossTabClose;
            } catch (err) {
                // Fail safe: keep the short default timeout if the setting can't be read.
                SESSION_MODE = 'timeout';
                IDLE_TIMEOUT_MS = 2 * 60 * 1000;
                PERSIST_ACROSS_TAB_CLOSE = false;
            }
            setupIdleTimer();
            syncPersistentAuthMirror();
        }

        // Mirrors the current tab-scoped session into localStorage so it can
        // survive a closed tab / reopened browser — but only while the admin
        // has "Stay logged in after closing the tab" turned on. If the admin
        // turns it back off, any stale copy here is wiped out the very next
        // time this runs (called after every login and session restore).
        function syncPersistentAuthMirror() {
            if (sessionStorage.getItem('drivesync_authenticated') !== 'true') return;
            if (PERSIST_ACROSS_TAB_CLOSE) {
                localStorage.setItem('drivesync_authenticated', 'true');
                localStorage.setItem('drivesync_macro', sessionStorage.getItem('drivesync_macro') || '');
                localStorage.setItem('drivesync_root', sessionStorage.getItem('drivesync_root') || '');
                const pc = sessionStorage.getItem('drivesync_token');
                if (pc) localStorage.setItem('drivesync_token', pc);
            } else {
                localStorage.removeItem('drivesync_authenticated');
                localStorage.removeItem('drivesync_macro');
                localStorage.removeItem('drivesync_root');
                localStorage.removeItem('drivesync_token');
            }
        }

        // Called when a fresh tab finds no active sessionStorage session — the
        // normal case for a closed-and-reopened tab. If the admin has "Stay
        // logged in after closing the tab" enabled and we have a persisted
        // copy in localStorage, silently restore it instead of showing the
        // gate. Always re-checks the LIVE admin setting first, so turning the
        // feature off immediately stops honoring old persisted sessions.
        async function tryRestorePersistentLogin() {
            const savedAuth = localStorage.getItem('drivesync_authenticated');
            let savedMacro = localStorage.getItem('drivesync_macro');
            let savedRoot = localStorage.getItem('drivesync_root');
            if (savedAuth !== 'true' || !savedMacro || !savedRoot || !localStorage.getItem('drivesync_token')) return false;

            try {
                const resp = await fetch('/api/session-settings');
                const settings = await resp.json();
                if (!settings.persistAcrossTabClose) {
                    localStorage.removeItem('drivesync_authenticated');
                    localStorage.removeItem('drivesync_macro');
                    localStorage.removeItem('drivesync_root');
                    localStorage.removeItem('drivesync_token');
                    return false;
                }
            } catch (err) {
                return false; // can't verify the live setting — fail safe, stay on the gate
            }

            // Confirm the persisted session is still valid server-side (token not
            // expired, account still exists, password not changed since) and pick up
            // the account's current Drive config.
            try {
                const meResp = await fetch('/api/me', {
                    headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('drivesync_token') || '') }
                });
                if (meResp.status === 401) {
                    ['drivesync_authenticated', 'drivesync_macro', 'drivesync_root', 'drivesync_token']
                        .forEach(k => localStorage.removeItem(k));
                    return false;
                }
                if (!meResp.ok) return false;
                const me = await meResp.json();
                window.__drivesyncAccount = me.account || null;
                savedMacro = me.config.macroUrl;
                savedRoot = me.config.rootFolderId;
                localStorage.setItem('drivesync_macro', savedMacro);
                localStorage.setItem('drivesync_root', savedRoot);
            } catch (err) {
                return false;
            }

            MACRO_WEBAPP_URL = savedMacro;
            ROOT_FOLDER_ID = savedRoot;
            sessionStorage.setItem('drivesync_authenticated', 'true');
            sessionStorage.setItem('drivesync_macro', savedMacro);
            sessionStorage.setItem('drivesync_root', savedRoot);
            const savedToken = localStorage.getItem('drivesync_token');
            if (savedToken) sessionStorage.setItem('drivesync_token', savedToken);
            markTabActive();

            hideAuthGate();
            document.getElementById('app').classList.add('authenticated');
            applyProfile(window.__drivesyncAccount);

            Promise.resolve(loadDriveContents(ROOT_FOLDER_ID)).then(() => replaceNavState());
            refreshSessionSettingsAndArm();
            checkAddAccountVisibility();
            return true;
        }

        // Security Lockout Configuration
        let lockoutTimerInterval = null; // Reference for the live countdown interval

        // Theme Configuration Manager
        function initTheme() {
            const savedTheme = localStorage.getItem('drivesync_theme');
            const currentTheme = (savedTheme === 'light' || savedTheme === 'dark')
                ? savedTheme
                : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
            document.documentElement.setAttribute('data-theme', currentTheme);
            const iconNodes = document.querySelectorAll('.theme-icon-glyph');
            iconNodes.forEach((iconNode) => {
                iconNode.className = currentTheme === 'light' ? 'ti ti-moon theme-icon-glyph' : 'ti ti-sun theme-icon-glyph';
            });
        }

        function toggleTheme() {
            const htmlNode = document.documentElement;
            const iconNodes = document.querySelectorAll('.theme-icon-glyph');
            let nextTheme = 'dark';

            if (htmlNode.getAttribute('data-theme') === 'dark') {
                nextTheme = 'light';
                iconNodes.forEach((iconNode) => { iconNode.className = 'ti ti-moon theme-icon-glyph'; });
            } else {
                iconNodes.forEach((iconNode) => { iconNode.className = 'ti ti-sun theme-icon-glyph'; });
            }

            htmlNode.setAttribute('data-theme', nextTheme);
            localStorage.setItem('drivesync_theme', nextTheme);
        }

        // Check and enforce device lockout state with real-time minutes and seconds countdown
        function setGateInputsDisabled(flag) {
            ['gateEmail', 'gatePassword'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.disabled = flag;
            });
        }

        function checkLockoutState() {
            // Client-side lockout removed: clear any stale lock left in this browser.
            clearInterval(lockoutTimerInterval);
            localStorage.removeItem('drivesync_lockout_expiry');
            localStorage.removeItem('drivesync_failed_attempts');
            setGateInputsDisabled(false);
            const unlockBtn = document.querySelector('#authGate .btn-primary');
            if (unlockBtn) unlockBtn.disabled = false;
            return false;
        }

        // The auth gate is hidden by default (see index.page.css) so it never
        // flashes on screen while we're still figuring out whether the user
        // is already logged in. These two helpers are the only place that
        // toggles it.
        function showAuthGate() {
            const gateOverlay = document.getElementById('authGate');
            if (gateOverlay) gateOverlay.classList.add('visible');
            const emailField = document.getElementById('gateEmail');
            if (emailField && !emailField.disabled) emailField.focus();
        }

        function hideAuthGate() {
            const gateOverlay = document.getElementById('authGate');
            if (gateOverlay) gateOverlay.classList.remove('visible');
        }

        function updateSearchPlaceholder() {
            const input = document.getElementById('searchInput');
            if (!input) return;
            input.placeholder = window.innerWidth <= 767 ? 'Search elements' : 'Search elements inside DriveSync...';
        }

        window.addEventListener('resize', updateSearchPlaceholder);

        // Runs immediately (synchronously, as soon as the page markup exists)
        // instead of waiting for window "load" — "load" only fires once every
        // image/font/script has finished, which is late enough that the
        // already-visible auth gate would flash on screen for an already
        // logged-in user before this check ran and hid it again. Since the
        // gate is hidden by default now, there's nothing left to hide/flash
        // for the common "already logged in" case — we only ever reveal it
        // once we've actually confirmed a login is required.
        (async () => {
            initTheme();
            updateSearchPlaceholder();

            // First step verification enforcement check on load
            checkLockoutState();

            if (sessionStorage.getItem('drivesync_authenticated') === 'true' && isSameTabSession()) {
                // Rehydrate hidden endpoints from local execution session context memory safely
                MACRO_WEBAPP_URL = sessionStorage.getItem('drivesync_macro');
                ROOT_FOLDER_ID = sessionStorage.getItem('drivesync_root');

                if (MACRO_WEBAPP_URL && ROOT_FOLDER_ID && sessionStorage.getItem('drivesync_token')) {
                    document.getElementById('app').classList.add('authenticated');

                    // Refresh fix: restore the sidebar name + photo. Paint the cached
                    // profile instantly (no flash of the default DriveSync logo),
                    // then re-fetch the live profile from the server.
                    try {
                        const cachedAcct = JSON.parse(sessionStorage.getItem('drivesync_account') || 'null');
                        if (cachedAcct) applyProfile(cachedAcct);
                    } catch (err) { /* ignore a corrupt cache */ }
                    refreshProfileFromServer();

                    // Restore last-visited folder/view after a hard refresh,
                    // instead of always snapping back to the root directory.
                    let restoredFolderId = ROOT_FOLDER_ID;
                    const savedNavRaw = sessionStorage.getItem('drivesync_navstate');
                    if (savedNavRaw) {
                        try {
                            const savedNav = JSON.parse(savedNavRaw);
                            folderPathStack = (savedNav.path || []).map(f => ({ id: f.id, name: f.name }));
                            currentMainMode = savedNav.mode || 'drive';
                            activeFilterGroup = savedNav.filter || 'all';
                            restoredFolderId = savedNav.folderId || ROOT_FOLDER_ID;
                            applySidebarUIForState(savedNav);
                        } catch (err) {
                            console.error('Failed to restore saved navigation state:', err);
                        }
                    }

                    Promise.resolve(loadDriveContents(restoredFolderId)).then(() => replaceNavState());
                    refreshSessionSettingsAndArm();
                    checkAddAccountVisibility();
                } else {
                    executeAppLogout();
                }
            } else {
                // Stale sessionStorage from a reopened/restored tab (or no
                // prior session at all) — wipe any leftovers.
                sessionStorage.removeItem('drivesync_authenticated');
                sessionStorage.removeItem('drivesync_macro');
                sessionStorage.removeItem('drivesync_root');
                sessionStorage.removeItem('drivesync_navstate');
                sessionStorage.removeItem('drivesync_token');
                sessionStorage.removeItem('drivesync_account');

                // Try a silent persistent-login restore (e.g. a brand new tab
                // when the admin has "stay logged in" enabled) before ever
                // showing the password gate. Only reveal the gate once we
                // know for certain no valid session can be restored.
                const restored = await tryRestorePersistentLogin();
                if (!restored) {
                    showAuthGate();
                }
            }
        })();

        function extractFolderId(value) {
            const v = String(value || '').trim();
            const m = v.match(/\/folders\/([A-Za-z0-9_-]+)/) || v.match(/[?&]id=([A-Za-z0-9_-]+)/);
            return m ? m[1] : v;
        }

        function setupIdleTimer() {
            const resetTimer = () => {
                clearTimeout(idleTimer);
                if (SESSION_MODE === 'never') return; // admin has disabled auto-logout entirely
                idleTimer = setTimeout(triggerAutoLock, IDLE_TIMEOUT_MS);
            };
            if (!idleListenersAttached) {
                ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart'].forEach(evtName => {
                    document.addEventListener(evtName, resetTimer, false);
                });
                idleListenersAttached = true;
            }
            resetTimer();
        }

        function triggerAutoLock() {
            executeAppLogout();
        }

        function handleGateKey(e) { if (e.key === "Enter") verifyLogin(); }

        // Tapping the lock icon on the password screen 10+ times in quick
        // succession opens the admin panel in a new tab — a hidden shortcut
        // so the admin URL doesn't need to be shared/bookmarked separately.
        let authIconTapCount = 0;
        let authIconTapResetTimer = null;

        function handleAuthIconTap() {
            authIconTapCount++;
            clearTimeout(authIconTapResetTimer);
            authIconTapResetTimer = setTimeout(() => { authIconTapCount = 0; }, 2000);

            if (authIconTapCount >= 10) {
                authIconTapCount = 0;
                clearTimeout(authIconTapResetTimer);
                window.location.href = '/adminaccount';
            }
        }

        async function verifyLogin() {
            // Prevent execution loop workflows if locked out
            if (checkLockoutState()) return;

            const emailField = document.getElementById('gateEmail');
            const pwField = document.getElementById('gatePassword');
            const errorEl = document.getElementById('authError');
            const appContainer = document.getElementById('app');
            const authCard = document.querySelector('.auth-card');
            const email = emailField.value.trim();
            const password = pwField.value;
            errorEl.style.color = '';

            if (!email || !password) {
                errorEl.style.display = 'block';
                errorEl.innerText = 'Please enter your email and password.';
                (email ? pwField : emailField).focus();
                return;
            }

            try {
                // Remote verification request targeting Vercel Node Serverless engine
                const response = await fetch('/api/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });

                let data;
                try {
                    data = await response.json();
                } catch {
                    throw new Error('Server did not return a valid response. Is the API running? (see /api/auth)');
                }

                if (response.ok && data.authenticated === true && data.token) {
                    // Clear structural tracking variables on successful login validation pass
                    localStorage.removeItem('drivesync_failed_attempts');
                    localStorage.removeItem('drivesync_lockout_expiry');

                    MACRO_WEBAPP_URL = data.config.macroUrl;
                    ROOT_FOLDER_ID = data.config.rootFolderId;

                    sessionStorage.setItem('drivesync_macro', MACRO_WEBAPP_URL);
                    sessionStorage.setItem('drivesync_root', ROOT_FOLDER_ID);
                    sessionStorage.setItem('drivesync_token', data.token);
                    sessionStorage.setItem('drivesync_authenticated', 'true');
                    markTabActive();

                    pwField.value = '';
                    errorEl.style.display = 'none';
                    hideAuthGate();
                    appContainer.classList.add('authenticated');
                    applyProfile(data.account);
                    Promise.resolve(loadDriveContents(ROOT_FOLDER_ID)).then(() => replaceNavState());
                    refreshSessionSettingsAndArm();
                    checkAddAccountVisibility();
                } else {
                    throw new Error(data.error || "Login failed. Please try again.");
                }
            } catch (err) {
                // Trigger shake visualization block response feedback loops safely
                if (authCard) {
                    authCard.classList.remove('shake');
                    void authCard.offsetWidth; // Force DOM reflow natively to restart keyframe
                    authCard.classList.add('shake');
                }

                errorEl.style.display = 'block';
                errorEl.innerText = err.message || "Invalid email or password.";

                pwField.value = '';
                pwField.focus();
            }
        }

        // =============================================
        // PROFILE (sidebar photo + time-of-day greeting)
        // =============================================
        let greetingTimer = null;

        function greetingForHour(h) {
            if (h >= 5 && h < 12) return 'Good Morning';
            if (h >= 12 && h < 17) return 'Good Afternoon';
            if (h >= 17 && h < 21) return 'Good Evening';
            return 'Good Night';
        }

        function applyProfile(account) {
            const avatarEl = document.getElementById('sidebarAvatar');
            const greetEl = document.getElementById('sidebarGreeting');
            if (!avatarEl || !greetEl || !account) return;
            window.__drivesyncAccount = account;
            try { sessionStorage.setItem('drivesync_account', JSON.stringify(account)); } catch (err) { /* quota */ }

            const fullName = String(account.label || '').trim();
            // A label that is just an email address (older accounts) -> use the part before "@".
            const base = fullName.includes('@') ? fullName.split('@')[0] : fullName;
            const firstName = base.split(/\s+/)[0] || '';

            avatarEl.textContent = '';
            if (account.avatar && /^data:image\/jpeg;base64,/.test(account.avatar)) {
                const img = document.createElement('img');
                img.src = account.avatar;
                img.alt = fullName || 'Profile photo';
                avatarEl.appendChild(img);
                avatarEl.classList.add('has-photo');
            } else if (firstName) {
                const span = document.createElement('span');
                span.className = 'avatar-initial';
                span.textContent = firstName.charAt(0).toUpperCase();
                avatarEl.appendChild(span);
                avatarEl.classList.add('has-photo');
            }

            const render = () => {
                const hello = greetingForHour(new Date().getHours());
                greetEl.textContent = '';
                const helloEl = document.createElement('span');
                helloEl.className = 'greet-hello';
                helloEl.textContent = firstName ? hello + ',' : hello;
                greetEl.appendChild(helloEl);
                if (firstName) {
                    const nameEl = document.createElement('span');
                    nameEl.className = 'greet-name';
                    nameEl.textContent = firstName;
                    nameEl.title = fullName || firstName;
                    greetEl.appendChild(nameEl);
                }
            };
            render();
            clearInterval(greetingTimer);
            greetingTimer = setInterval(render, 60 * 1000);
        }

        async function refreshProfileFromServer() {
            try {
                const resp = await fetch('/api/me', {
                    headers: { 'Authorization': 'Bearer ' + (sessionStorage.getItem('drivesync_token') || '') }
                });
                if (resp.status === 401) { executeAppLogout(); return; }
                if (!resp.ok) return;
                const me = await resp.json();
                if (me.account) applyProfile(me.account);
            } catch (err) {
                // Offline / network blip: keep whatever is already shown.
            }
        }

        function executeAppLogout() {
            sessionStorage.removeItem('drivesync_authenticated');
            sessionStorage.removeItem('drivesync_macro');
            sessionStorage.removeItem('drivesync_root');
            sessionStorage.removeItem('drivesync_navstate');
            sessionStorage.removeItem('drivesync_token');
            sessionStorage.removeItem('drivesync_account');
            // Manual logout always fully clears the persistent mirror too,
            // regardless of the "stay logged in" admin setting.
            localStorage.removeItem('drivesync_authenticated');
            localStorage.removeItem('drivesync_macro');
            localStorage.removeItem('drivesync_root');
            localStorage.removeItem('drivesync_token');
            clearTabMarker();
            window.location.reload();
        }

        // =============================================
        // EDIT PROFILE (name, photo, email, Drive folder)
        // =============================================
        const AVATAR_SIZE = 320;
        let epAvatar = '';          // JPEG data URL, or '' for "no photo"
        let epAvatarTouched = false;

        function fileToAvatar(file) {
            return new Promise((resolve, reject) => {
                if (!file.type.startsWith('image/')) { reject(new Error('Please choose an image file.')); return; }
                if (file.size > 15 * 1024 * 1024) { reject(new Error('That photo is too large (max 15 MB).')); return; }
                const url = URL.createObjectURL(file);
                const img = new Image();
                img.onload = () => {
                    try {
                        const side = Math.min(img.naturalWidth, img.naturalHeight);
                        const sx = (img.naturalWidth - side) / 2;
                        const sy = (img.naturalHeight - side) / 2;
                        const canvas = document.createElement('canvas');
                        canvas.width = canvas.height = AVATAR_SIZE;
                        const ctx = canvas.getContext('2d');
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
                        ctx.imageSmoothingQuality = 'high';
                        ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
                        resolve(canvas.toDataURL('image/jpeg', 0.85));
                    } catch {
                        reject(new Error('Could not process that photo.'));
                    } finally {
                        URL.revokeObjectURL(url);
                    }
                };
                img.onerror = () => {
                    URL.revokeObjectURL(url);
                    reject(new Error('Could not read that photo. Try a JPG or PNG.'));
                };
                img.src = url;
            });
        }

        function renderProfilePhotoPreview() {
            const box = document.getElementById('epAvatarPreview');
            const input = document.getElementById('epPhotoInput');
            // keep the hidden file input, replace everything else
            Array.from(box.childNodes).forEach(n => { if (n !== input) box.removeChild(n); });
            if (epAvatar) {
                const img = document.createElement('img');
                img.src = epAvatar;
                img.alt = 'Profile photo';
                box.insertBefore(img, input);
            } else {
                const name = document.getElementById('epName').value.trim();
                const base = name.includes('@') ? name.split('@')[0] : name;
                const span = document.createElement('span');
                span.className = 'avatar-initial';
                if (base.charAt(0)) span.textContent = base.charAt(0).toUpperCase();
                else span.innerHTML = '<i class="ti ti-user"></i>';
                box.insertBefore(span, input);
            }
            document.getElementById('epRemoveBtn').style.display = epAvatar ? 'inline' : 'none';
            document.getElementById('epUploadBtn').textContent = epAvatar ? 'Change photo' : 'Upload photo';
        }

        async function handleProfilePhotoPick(e) {
            const file = e.target.files && e.target.files[0];
            e.target.value = '';
            if (!file) return;
            const errEl = document.getElementById('editProfileError');
            try {
                epAvatar = await fileToAvatar(file);
                epAvatarTouched = true;
                errEl.style.display = 'none';
                renderProfilePhotoPreview();
            } catch (err) {
                errEl.innerText = err.message || 'Could not use that photo.';
                errEl.style.display = 'block';
            }
        }

        function removeProfilePhoto() {
            epAvatar = '';
            epAvatarTouched = true;
            renderProfilePhotoPreview();
        }

        function openEditProfileModal() {
            const acct = window.__drivesyncAccount || {};
            epAvatar = acct.avatar || '';
            epAvatarTouched = false;

            document.getElementById('epName').value = acct.label || '';
            document.getElementById('epEmail').value = acct.email || '';
            document.getElementById('epFolder').value = ROOT_FOLDER_ID || '';
            document.getElementById('epMacroUrl').value = MACRO_WEBAPP_URL || '';
            document.getElementById('epNewPassword').value = '';
            document.getElementById('epConfirmPassword').value = '';
            document.getElementById('epCurrentPassword').value = '';

            const errEl = document.getElementById('editProfileError');
            errEl.style.display = 'none';
            errEl.innerText = '';

            renderProfilePhotoPreview();
            document.getElementById('editProfileModal').classList.add('open');
            pushNavState();
        }

        function closeEditProfileModal() {
            document.getElementById('editProfileModal').classList.remove('open');
        }

        async function submitEditProfile() {
            const acct = window.__drivesyncAccount || {};
            const label = document.getElementById('epName').value.trim();
            const email = document.getElementById('epEmail').value.trim();
            const folderId = extractFolderId(document.getElementById('epFolder').value);
            const macroUrl = document.getElementById('epMacroUrl').value.trim();
            const newPassword = document.getElementById('epNewPassword').value;
            const confirmPassword = document.getElementById('epConfirmPassword').value;
            const currentPassword = document.getElementById('epCurrentPassword').value;
            const errEl = document.getElementById('editProfileError');
            const submitBtn = document.getElementById('submitEditProfileBtn');

            const fail = (msg) => { errEl.innerText = msg; errEl.style.display = 'block'; };
            errEl.style.display = 'none';

            if (!label) return fail('Please enter your name.');
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email.');
            if (!folderId) return fail('Paste your Google Drive folder link.');
            if (!/^https:\/\/script\.google\.com\/macros\/s\/.+/i.test(macroUrl)) return fail('Enter a valid Apps Script URL.');

            const emailChanged = email.toLowerCase() !== String(acct.email || '').toLowerCase();
            const macroChanged = macroUrl !== MACRO_WEBAPP_URL;
            const wantsPasswordChange = !!(newPassword || confirmPassword);

            if (wantsPasswordChange) {
                if (!newPassword || !confirmPassword) return fail('Please fill in both new password fields.');
                if (newPassword !== confirmPassword) return fail('New password and confirmation do not match.');
                if (newPassword === currentPassword) return fail('New password must be different from the current one.');
            }
            const anyChange = label !== String(acct.label || '') || emailChanged || folderId !== ROOT_FOLDER_ID
                || macroChanged || epAvatarTouched || wantsPasswordChange;
            if (!anyChange) {
                closeEditProfileModal();
                showToast('No changes to save.');
                return;
            }
            if (!currentPassword) return fail('Enter your current password to save changes.');

            const payload = { label, email, rootFolderId: folderId, macroUrl, currentPassword };
            if (epAvatarTouched) payload.avatar = epAvatar;
            if (wantsPasswordChange) payload.newPassword = newPassword;

            submitBtn.disabled = true;
            submitBtn.innerText = 'Saving...';

            try {
                const response = await fetch('/api/me', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + (sessionStorage.getItem('drivesync_token') || '')
                    },
                    body: JSON.stringify(payload)
                });

                let data;
                try { data = await response.json(); } catch { throw new Error('Server did not return a valid response.'); }
                if (!response.ok || !data.success) throw new Error(data.error || 'Failed to save profile.');

                closeEditProfileModal();

                if (data.passwordChanged) {
                    // Password changed -> every old session token is invalid, so sign in again.
                    executeAppLogout();
                    return;
                }

                applyProfile(data.account);

                if (data.config && data.config.macroUrl && data.config.macroUrl !== MACRO_WEBAPP_URL) {
                    MACRO_WEBAPP_URL = data.config.macroUrl;
                    sessionStorage.setItem('drivesync_macro', MACRO_WEBAPP_URL);
                    if (localStorage.getItem('drivesync_macro')) localStorage.setItem('drivesync_macro', MACRO_WEBAPP_URL);
                    reloadCurrentFolder();
                }

                if (data.config && data.config.rootFolderId && data.config.rootFolderId !== ROOT_FOLDER_ID) {
                    ROOT_FOLDER_ID = data.config.rootFolderId;
                    sessionStorage.setItem('drivesync_root', ROOT_FOLDER_ID);
                    if (localStorage.getItem('drivesync_root')) localStorage.setItem('drivesync_root', ROOT_FOLDER_ID);
                    goToHomeView();
                    loadDriveContents(ROOT_FOLDER_ID);
                }
                showToast(data.changed ? 'Profile updated.' : 'No changes to save.');
            } catch (err) {
                fail(err.message);
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerText = 'Save';
            }
        }

        // =============================================
        // CHANGE PASSWORD (self-service, from sidebar)
        // =============================================
        function openChangePasswordModal() {
            clearMaskedInput(document.getElementById('currentPasswordInput'));
            clearMaskedInput(document.getElementById('newPasswordInput'));
            clearMaskedInput(document.getElementById('confirmPasswordInput'));

            document.getElementById('toggleScriptUrlInput').checked = false;
            document.getElementById('newMacroUrlInput').style.display = 'none';
            document.getElementById('newMacroUrlInput').value = '';

            const errEl = document.getElementById('changePasswordError');
            errEl.style.display = 'none';
            errEl.innerText = '';

            document.getElementById('changePasswordModal').classList.add('open');
            pushNavState();
        }

        function closeChangePasswordModal() {
            document.getElementById('changePasswordModal').classList.remove('open');
        }

        function toggleScriptUrlField() {
            const checked = document.getElementById('toggleScriptUrlInput').checked;
            const field = document.getElementById('newMacroUrlInput');
            field.style.display = checked ? 'block' : 'none';
            if (!checked) field.value = '';
        }

        async function submitChangePassword() {
            const currentPassword = getMaskedValue(document.getElementById('currentPasswordInput')).trim();
            const newPassword = getMaskedValue(document.getElementById('newPasswordInput')).trim();
            const confirmPassword = getMaskedValue(document.getElementById('confirmPasswordInput')).trim();
            const wantsScriptUrlChange = document.getElementById('toggleScriptUrlInput').checked;
            const newMacroUrl = document.getElementById('newMacroUrlInput').value.trim();
            const errEl = document.getElementById('changePasswordError');
            const submitBtn = document.getElementById('submitChangePasswordBtn');

            errEl.style.display = 'none';

            if (!currentPassword) {
                errEl.innerText = 'Please enter your current password.';
                errEl.style.display = 'block';
                return;
            }

            const wantsPasswordChange = !!(newPassword || confirmPassword);

            if (!wantsPasswordChange && !(wantsScriptUrlChange && newMacroUrl)) {
                errEl.innerText = 'Enter a new password and/or check "Also update my Script URL".';
                errEl.style.display = 'block';
                return;
            }

            if (wantsPasswordChange) {
                if (!newPassword || !confirmPassword) {
                    errEl.innerText = 'Please fill in both new password fields.';
                    errEl.style.display = 'block';
                    return;
                }
                if (newPassword !== confirmPassword) {
                    errEl.innerText = 'New password and confirmation do not match.';
                    errEl.style.display = 'block';
                    return;
                }
                if (newPassword === currentPassword) {
                    errEl.innerText = 'New password must be different from the current one.';
                    errEl.style.display = 'block';
                    return;
                }
            }

            if (wantsScriptUrlChange && !newMacroUrl) {
                errEl.innerText = 'Enter the new Script URL, or uncheck that option.';
                errEl.style.display = 'block';
                return;
            }

            submitBtn.disabled = true;
            submitBtn.innerText = 'Updating...';

            try {
                const response = await fetch('/api/account-password', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + (sessionStorage.getItem('drivesync_token') || '')
                    },
                    body: JSON.stringify({
                        currentPassword,
                        newPassword: wantsPasswordChange ? newPassword : undefined,
                        newMacroUrl: wantsScriptUrlChange ? newMacroUrl : undefined
                    })
                });

                let data;
                try {
                    data = await response.json();
                } catch {
                    throw new Error('Server did not return a valid response.');
                }

                if (!response.ok || !data.success) {
                    throw new Error(data.error || 'Failed to update.');
                }

                closeChangePasswordModal();

                if (data.passwordChanged) {
                    // Password just changed — force re-authentication with the new one.
                    executeAppLogout();
                } else if (data.macroUrlChanged) {
                    // Only the script URL changed — apply it to this session right
                    // away, no need to log out.
                    MACRO_WEBAPP_URL = data.macroUrl;
                    sessionStorage.setItem('drivesync_macro', MACRO_WEBAPP_URL);
                    showToast('Script URL updated.');
                    reloadCurrentFolder();
                }
            } catch (err) {
                errEl.innerText = err.message;
                errEl.style.display = 'block';
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerText = 'Update';
            }
        }

        // =============================================
        // ADD ACCOUNT (self-service, from sidebar)
        //
        // Visibility is controlled by the admin from the "Feature Access"
        // view in /admin.html — off / all users / specific users. The nav
        // link stays hidden until the server confirms it's on for this user.
        // =============================================
        async function checkAddAccountVisibility() {
            const navBtn = document.getElementById('navAddAccountBtn');
            if (!navBtn) return;

            const sessionToken = sessionStorage.getItem('drivesync_token') || '';

            try {
                const response = await fetch('/api/self-add-account', {
                    method: 'GET',
                    headers: { 'Authorization': 'Bearer ' + sessionToken }
                });
                const data = await response.json().catch(() => ({}));
                navBtn.style.display = data.visible ? 'flex' : 'none';
            } catch (err) {
                navBtn.style.display = 'none';
            }
        }

        function openAddAccountModal() {
            document.getElementById('newAccountLabel').value = '';
            document.getElementById('newAccountEmail').value = '';
            document.getElementById('newAccountPassword').value = '';
            document.getElementById('newAccountMacroUrl').value = '';
            document.getElementById('newAccountRootFolderId').value = '';

            const errEl = document.getElementById('addAccountError');
            errEl.style.display = 'none';
            errEl.innerText = '';
            const successEl = document.getElementById('addAccountSuccess');
            successEl.style.display = 'none';
            successEl.innerText = '';

            document.getElementById('addAccountModal').classList.add('open');
            closeSidebar();
            pushNavState();
        }

        function closeAddAccountModal() {
            document.getElementById('addAccountModal').classList.remove('open');
        }

        async function submitAddAccount() {
            const label = document.getElementById('newAccountLabel').value.trim();
            const email = document.getElementById('newAccountEmail').value.trim();
            const password = document.getElementById('newAccountPassword').value;
            const macroUrl = document.getElementById('newAccountMacroUrl').value.trim();
            const rootFolderId = extractFolderId(document.getElementById('newAccountRootFolderId').value);
            const errEl = document.getElementById('addAccountError');
            const successEl = document.getElementById('addAccountSuccess');
            const submitBtn = document.getElementById('submitAddAccountBtn');

            errEl.style.display = 'none';
            successEl.style.display = 'none';

            if (!label || !email || !password || !macroUrl || !rootFolderId) {
                errEl.innerText = 'All fields are required.';
                errEl.style.display = 'block';
                return;
            }

            submitBtn.disabled = true;
            submitBtn.innerText = 'Adding...';

            try {
                const sessionToken = sessionStorage.getItem('drivesync_token') || '';
                const response = await fetch('/api/self-add-account', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + sessionToken
                    },
                    body: JSON.stringify({ label, email, password, macroUrl, rootFolderId })
                });

                let data;
                try {
                    data = await response.json();
                } catch {
                    throw new Error('Server did not return a valid response.');
                }

                if (!response.ok || !data.success) {
                    throw new Error(data.error || 'Failed to add account.');
                }

                successEl.innerText = 'Account added. Log out and sign in with its email and password to open that drive.';
                successEl.style.display = 'block';
                ['newAccountLabel', 'newAccountEmail', 'newAccountPassword', 'newAccountMacroUrl', 'newAccountRootFolderId']
                    .forEach(id => document.getElementById(id).value = '');
            } catch (err) {
                errEl.innerText = err.message;
                errEl.style.display = 'block';
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerText = 'Add Account';
            }
        }

        // =============================================
        // REGISTER (public, from the sign-in screen)
        //
        // The "Register" link on the sign-in card opens a popup so a new
        // user can create their own account. Posts to /api/register, which
        // does not need a session. The link stays hidden unless the server
        // says registration is enabled.
        // =============================================
        async function checkRegisterEnabled() {
            const line = document.getElementById('authRegisterLine');
            if (!line) return;
            try {
                const response = await fetch('/api/register');
                const data = await response.json().catch(() => ({}));
                line.style.display = data.enabled === false ? 'none' : 'block';
            } catch (err) {
                line.style.display = 'block';
            }
        }

        function openRegisterModal() {
            ['regLabel', 'regEmail', 'regPassword', 'regMacroUrl', 'regRootFolderId']
                .forEach(id => document.getElementById(id).value = '');
            const errEl = document.getElementById('registerError');
            errEl.style.display = 'none';
            errEl.innerText = '';
            document.getElementById('registerModal').classList.add('open');
            setTimeout(() => document.getElementById('regLabel').focus(), 50);
        }

        function closeRegisterModal() {
            document.getElementById('registerModal').classList.remove('open');
        }

        async function submitRegister() {
            const label = document.getElementById('regLabel').value.trim();
            const email = document.getElementById('regEmail').value.trim();
            const password = document.getElementById('regPassword').value;
            const macroUrl = document.getElementById('regMacroUrl').value.trim();
            const rootFolderId = extractFolderId(document.getElementById('regRootFolderId').value);
            const errEl = document.getElementById('registerError');
            const submitBtn = document.getElementById('submitRegisterBtn');

            errEl.style.display = 'none';

            if (!label || !email || !password || !macroUrl || !rootFolderId) {
                errEl.innerText = 'All fields are required.';
                errEl.style.display = 'block';
                return;
            }

            submitBtn.disabled = true;
            submitBtn.innerText = 'Creating...';

            try {
                const response = await fetch('/api/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ label, email, password, macroUrl, rootFolderId })
                });

                let data;
                try {
                    data = await response.json();
                } catch {
                    throw new Error('Server did not return a valid response.');
                }

                if (!response.ok || !data.success) {
                    throw new Error(data.error || 'Registration failed.');
                }

                // Close the popup and drop the new email into the sign-in form.
                closeRegisterModal();
                document.getElementById('gateEmail').value = data.email || email;
                document.getElementById('gatePassword').value = '';
                document.getElementById('gatePassword').focus();
                const authErr = document.getElementById('authError');
                authErr.style.color = '#22c55e';
                authErr.innerText = 'Account created. Enter your password to sign in.';
                authErr.style.display = 'block';
                setTimeout(() => { authErr.style.color = ''; }, 8000);
            } catch (err) {
                errEl.innerText = err.message;
                errEl.style.display = 'block';
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerText = 'Register';
            }
        }

        // =============================================
        // UPLOAD DROPDOWN
        // =============================================
        function toggleUploadDropdown(e) {
            e.stopPropagation();
            document.getElementById('uploadDropdownMenu').classList.toggle('open');
        }

        function triggerFileUpload() {
            document.getElementById('uploadDropdownMenu').classList.remove('open');
            document.getElementById('fi').click();
        }

        function triggerFolderUpload() {
            document.getElementById('uploadDropdownMenu').classList.remove('open');
            document.getElementById('fi-folder').click();
        }

        document.addEventListener('click', (e) => {
            const wrapper = document.getElementById('uploadDropdownWrapper');
            if (wrapper && !wrapper.contains(e.target)) {
                document.getElementById('uploadDropdownMenu').classList.remove('open');
            }

            // Generic outside-click-to-close for every modal popup on the page.
            // Only fires when the backdrop itself (not something inside the
            // box) was clicked, and only for modals that are currently open.
            if (e.target.classList && e.target.classList.contains('modal-overlay') && e.target.classList.contains('open')) {
                const closers = {
                    folderModal: closeFolderModal,
                    renameModal: closeRenameModal,
                    changePasswordModal: closeChangePasswordModal,
                    editProfileModal: closeEditProfileModal,
                    addAccountModal: closeAddAccountModal,
                    registerModal: closeRegisterModal,
                    deleteModal: closeDeleteModal,
                };
                const closer = closers[e.target.id];
                if (closer) closer();
            }
        });

        function toggleSidebar() {
            const sidebarNode = document.getElementById('sidebarNode');
            const isOpening = !sidebarNode.classList.contains('mobile-open');
            sidebarNode.classList.toggle('mobile-open');
            document.getElementById('sidebarBackdrop').classList.toggle('show');
            if (isOpening) pushNavState();
        }

        document.addEventListener('keydown', e => {
            if (!document.getElementById('previewOverlay').classList.contains('open')) return;
            if (e.key === 'Escape') closePreview();
            else if (e.key === 'ArrowLeft') previewPrev();
            else if (e.key === 'ArrowRight') previewNext();
        });

        function closeSidebar() {
            document.getElementById('sidebarNode').classList.remove('mobile-open');
            document.getElementById('sidebarBackdrop').classList.remove('show');
        }

        window.addEventListener('resize', () => { if (window.innerWidth >= 1024) closeSidebar(); });

        function goToHomeView() {
            closeSidebar();
            const driveRootBtn = document.getElementById('cat-all');
            if (driveRootBtn) {
                switchCategoryView('all', driveRootBtn);
            }
        }

        function showDriveContent() {
            const drive = document.getElementById('driveContent');
            const notes = document.getElementById('notesSection');
            if (drive) drive.style.display = 'block';
            if (notes) notes.style.display = 'none';
        }

        function switchToNotesSection(element) {
            closeSidebar();
            clearSearchState({ clearInput: true });
            currentMainMode = 'notes';
            document.querySelectorAll('.sidebar .nav-btn').forEach(b => b.classList.remove('active'));
            if (element) element.classList.add('active');

            const drive = document.getElementById('driveContent');
            const notes = document.getElementById('notesSection');
            if (drive) drive.style.display = 'none';
            if (notes) {
                notes.style.display = 'block';
                replayFade(notes);
            }
            document.getElementById('notesGridView').style.display = 'block';
            document.getElementById('noteEditorSectionView').style.display = 'none';

            const mainEl = document.querySelector('.main');
            if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });

            pushNavState();
            refreshNotesGrid();
        }

        function switchCategoryView(mode, element) {
            closeSidebar();
            showDriveContent();
            clearSearchState({ clearInput: true });
            currentMainMode = mode;
            document.querySelectorAll('.sidebar .nav-btn').forEach(b => b.classList.remove('active'));
            element.classList.add('active');

            const mainEl = document.querySelector('.main');
            if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });

            const titleEl = document.getElementById('viewTitle');
            if (mode === 'recent') {
                titleEl.innerText = "Recent Activity Log";
                replayFade(titleEl);
                activeFilterGroup = 'all';
                document.querySelectorAll('.filter-tabs .tab-btn').forEach(b => b.classList.remove('active'));
                document.getElementById('tab-all').classList.add('active');
            } else {
                titleEl.innerText = "DriveSync Storage";
                replayFade(titleEl);
                navigateToRoot();
                return;
            }
            render();
            pushNavState();
        }

        function switchSidebarFilter(filterType, element) {
            closeSidebar();
            showDriveContent();
            currentMainMode = 'drive';
            const driveRootBtn = document.getElementById('cat-all');
            document.querySelectorAll('.sidebar .nav-btn').forEach(b => b.classList.remove('active'));
            driveRootBtn.classList.add('active');
            element.classList.add('active');
            const titleEl = document.getElementById('viewTitle');
            titleEl.innerText = "DriveSync Storage";
            replayFade(titleEl);
            const mainEl = document.querySelector('.main');
            if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });
            switchTabFilter(filterType);
            pushNavState();
        }

        // ---- Mobile back-button navigation fix ----
        // Instead of letting the browser/OS back gesture exit the app, we push a
        // history entry for every in-app navigation step (folder, root, recent,
        // category filter). Pressing back then just pops us one step within the app.
        let suppressHistoryPush = false;

        function currentNavSnapshot() {
            return {
                mode: currentMainMode,
                folderId: currentFolderId,
                path: folderPathStack.map(f => ({ id: f.id, name: f.name })),
                filter: activeFilterGroup
            };
        }

        function pushNavState() {
            if (suppressHistoryPush) return;
            const snapshot = currentNavSnapshot();
            history.pushState(snapshot, '', location.href);
            sessionStorage.setItem('drivesync_navstate', JSON.stringify(snapshot));
        }

        function replaceNavState() {
            const snapshot = currentNavSnapshot();
            history.replaceState(snapshot, '', location.href);
            sessionStorage.setItem('drivesync_navstate', JSON.stringify(snapshot));
        }

        function applySidebarUIForState(state) {
            document.querySelectorAll('.sidebar .nav-btn').forEach(b => b.classList.remove('active'));
            const titleEl = document.getElementById('viewTitle');

            if (state.mode === 'notes') {
                const notesBtn = document.getElementById('cat-notes');
                if (notesBtn) notesBtn.classList.add('active');
                showDriveContent();
                document.getElementById('driveContent').style.display = 'none';
                document.getElementById('notesSection').style.display = 'block';
                return;
            }

            if (state.mode === 'recent') {
                const recentBtn = document.getElementById('cat-recent');
                if (recentBtn) recentBtn.classList.add('active');
                if (titleEl) { titleEl.innerText = "Recent Activity Log"; replayFade(titleEl); }
            } else {
                const filterBtnId = state.filter && state.filter !== 'all' ? `cat-${state.filter}` : 'cat-all';
                const activeBtn = document.getElementById(filterBtnId) || document.getElementById('cat-all');
                if (activeBtn) activeBtn.classList.add('active');
                if (titleEl) { titleEl.innerText = "DriveSync Storage"; replayFade(titleEl); }
            }

            document.querySelectorAll('.filter-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            const activeTab = document.getElementById(`tab-${state.filter || 'all'}`);
            if (activeTab) activeTab.classList.add('active');
        }

        window.addEventListener('popstate', (e) => {
            // If a file preview is open, treat back as "close the preview" first,
            // rather than leaving the current folder/view.
            const overlay = document.getElementById('previewOverlay');
            if (overlay && overlay.classList.contains('open')) {
                closePreview();
                replaceNavState();
                return;
            }

            if (!document.getElementById('app').classList.contains('authenticated')) return;

            const state = e.state;
            if (!state) return;

            suppressHistoryPush = true;
            folderPathStack = (state.path || []).map(f => ({ id: f.id, name: f.name }));
            currentMainMode = state.mode || 'drive';
            activeFilterGroup = state.filter || 'all';

            applySidebarUIForState(state);

            const mainEl = document.querySelector('.main');
            if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });

            if (state.mode === 'notes') {
                document.getElementById('notesGridView').style.display = 'block';
                document.getElementById('noteEditorSectionView').style.display = 'none';
                Promise.resolve(refreshNotesGrid()).finally(() => {
                    suppressHistoryPush = false;
                });
                return;
            }

            updateBreadcrumbs();

            Promise.resolve(loadDriveContents(state.folderId || ROOT_FOLDER_ID)).finally(() => {
                suppressHistoryPush = false;
            });
        });

        function replayFade(el) {
            if (!el) return;
            el.classList.remove('content-fade');
            void el.offsetWidth;
            el.classList.add('content-fade');
        }

        function fmtSz(b) { if (!b) return '—'; b = Number(b); if (b < 1024) return b + 'B'; if (b < 1048576) return Math.round(b / 1024) + 'KB'; return (b / 1048576).toFixed(1) + 'MB'; }
        function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
        function showToast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3000); }

        function getFileCategory(name, type) {
            if (type === 'folder') return 'folder';
            const ext = name.split('.').pop().toLowerCase();
            if (ext === 'pdf' || type.includes('pdf')) return 'pdf';
            if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return 'doc';
            if (['txt', 'md', 'log'].includes(ext)) return 'text';
            if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 'sheet';
            if (['ppt', 'pptx', 'odp'].includes(ext)) return 'slide';
            if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico', 'heic', 'heif'].includes(ext) || type.includes('image')) return 'img';
            if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma'].includes(ext) || type.includes('audio')) return 'audio';
            if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp'].includes(ext) || type.includes('video')) return 'video';
            if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext) || type.includes('zip') || type.includes('compressed') || type.includes('archive')) return 'zip';
            if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'html', 'css', 'json', 'xml', 'php', 'rb', 'go', 'rs', 'sh'].includes(ext)) return 'code';
            return 'other';
        }

        function getBadgeLabel(name, type) {
            const ext = (name || '').split('.').pop();
            if (ext && ext.length <= 6 && ext !== name) return ext.toUpperCase();
            if (type && type.includes('/')) {
                const sub = type.split('/')[1] || '';
                return sub.length <= 8 ? sub.toUpperCase() : 'FILE';
            }
            return 'FILE';
        }

        function applyFolderData(searchId, data) {
            driveItems = data.items;
            currentFolderId = data.currentFolderId;
            parentFolderId = data.parentFolderId;

            // Piggyback on this listing to learn the Notes folder's ID for
            // free, instead of firing a second request to the (slow) Apps
            // Script backend just to check for it.
            if (!notesFolderId && searchId === ROOT_FOLDER_ID) {
                const notesFolder = driveItems.find(i => i.type === 'folder' && i.name === 'Notes');
                if (notesFolder) notesFolderId = notesFolder.id;
            }

            updateBreadcrumbs();
            render();
        }

        // Storage quota is now its own cheap, occasional call instead of
        // riding along on every folder navigation (see backend/Code.gs).
        async function refreshStorageStat(force) {
            const storageEl = document.getElementById('sStorage');
            if (!storageEl) return;
            if (!force && Date.now() - lastStorageFetchAt < STORAGE_REFRESH_INTERVAL_MS) return;

            try {
                const urlParams = new URLSearchParams({ action: 'getStorageInfo' });
                const response = await fetch(`${MACRO_WEBAPP_URL}?${urlParams.toString()}`);
                const data = await response.json();
                if (data.result === 'success') {
                    lastStorageFetchAt = Date.now();
                    storageEl.innerText = `${data.storageUsed} / ${data.storageTotal} GB`;
                }
            } catch (err) {
                // Non-critical — leave whatever was last shown (or the default markup).
                console.error('Failed to refresh storage stat:', err);
            }
        }

        // Quietly fetches a folder's contents into the cache without touching
        // the visible list — used both for background revalidation and for
        // hover-prefetch of a folder the user hasn't opened yet.
        function prefetchFolder(folderId) {
            if (!folderId || prefetchInFlight.has(folderId)) return;
            const cached = folderCache.get(folderId);
            if (cached && Date.now() - cached.timestamp < FOLDER_CACHE_TTL_MS) return;

            prefetchInFlight.add(folderId);
            const urlParams = new URLSearchParams({ action: 'fetchItems', folderId });
            fetch(`${MACRO_WEBAPP_URL}?${urlParams.toString()}`)
                .then(r => r.json())
                .then(data => {
                    if (data.result === 'success') {
                        folderCache.set(folderId, {
                            items: data.items,
                            currentFolderId: data.currentFolderId,
                            parentFolderId: data.parentFolderId,
                            timestamp: Date.now()
                        });
                    }
                })
                .catch(() => {})
                .finally(() => prefetchInFlight.delete(folderId));
        }

        // Any create/delete/rename/upload changes the current folder's real
        // contents, so its cached listing is now stale — drop it before
        // reloading so the reload always hits the network instead of quietly
        // re-showing what was cached from before the change.
        function reloadCurrentFolder() {
            folderCache.delete(currentFolderId);
            return loadDriveContents(currentFolderId);
        }

        // --- Deep search implementation ---
        // The Apps Script backend only exposes one folder's contents per
        // call (fetchItems), so "search inside subfolders too" is done by
        // crawling the folder tree client-side — one fetchItems call per
        // folder, reusing folderCache wherever possible — and collecting
        // every item whose name matches along the way.
        const DEEP_SEARCH_MAX_DEPTH = 8;

        async function fetchFolderItemsForSearch(folderId) {
            const cached = folderCache.get(folderId);
            if (cached && Date.now() - cached.timestamp < FOLDER_CACHE_TTL_MS) {
                return cached.items;
            }
            try {
                const urlParams = new URLSearchParams({ action: 'fetchItems', folderId });
                const response = await fetch(`${MACRO_WEBAPP_URL}?${urlParams.toString()}`);
                const data = await response.json();
                if (data.result === 'success') {
                    folderCache.set(folderId, {
                        items: data.items,
                        currentFolderId: data.currentFolderId,
                        parentFolderId: data.parentFolderId,
                        timestamp: Date.now()
                    });
                    return data.items;
                }
            } catch (err) {
                console.error('Deep search: failed to read folder', folderId, err);
            }
            return [];
        }

        async function collectSearchMatches(folderId, query, token, pathNames, depth) {
            if (depth > DEEP_SEARCH_MAX_DEPTH || token !== deepSearchToken) return [];

            const items = await fetchFolderItemsForSearch(folderId);
            if (token !== deepSearchToken) return []; // a newer search superseded this one

            const path = pathNames.join(' / ');
            const matches = [];
            const subfolders = [];

            items.forEach(item => {
                if (item.name.toLowerCase().includes(query)) matches.push({ ...item, _path: path });
                if (item.type === 'folder') subfolders.push(item);
            });

            const nestedResults = await Promise.all(
                subfolders.map(sf => collectSearchMatches(sf.id, query, token, [...pathNames, sf.name], depth + 1))
            );
            nestedResults.forEach(arr => matches.push(...arr));

            return matches;
        }

        function setSearchSpinnerVisible(visible) {
            const spinner = document.getElementById('searchSpinner');
            if (spinner) spinner.classList.toggle('hidden', !visible);
        }

        // Drops out of deep-search mode — called whenever the folder being
        // browsed changes, since a stale cross-folder result set no longer
        // makes sense once the user has navigated elsewhere.
        function clearSearchState({ clearInput = false } = {}) {
            deepSearchToken++;
            deepSearchResults = null;
            deepSearchLoading = false;
            setSearchSpinnerVisible(false);
            if (clearInput) {
                const input = document.getElementById('searchInput');
                if (input) input.value = '';
            }
        }

        function handleSearchInput() {
            clearTimeout(deepSearchDebounceTimer);
            const q = document.getElementById('searchInput').value.trim();

            if (!q) {
                clearSearchState();
                render();
                return;
            }

            // Show whatever's already loaded in the current folder right away,
            // then crawl subfolders in the background for the fuller results.
            deepSearchResults = null;
            render();

            deepSearchDebounceTimer = setTimeout(() => runDeepSearch(q), 350);
        }

        async function runDeepSearch(query) {
            if (currentMainMode !== 'drive') return;

            const token = ++deepSearchToken;
            deepSearchLoading = true;
            setSearchSpinnerVisible(true);

            const rootId = currentFolderId || ROOT_FOLDER_ID;
            const results = await collectSearchMatches(rootId, query.toLowerCase(), token, [], 0);

            if (token !== deepSearchToken) return; // superseded by a newer search

            deepSearchLoading = false;
            deepSearchResults = results;
            setSearchSpinnerVisible(false);
            render();
        }

        async function loadDriveContents(folderId = null) {
            if (!document.getElementById('app').classList.contains('authenticated')) return;

            const searchId = folderId || currentFolderId || ROOT_FOLDER_ID;
            const requestId = ++activeLoadRequestId;
            const cached = folderCache.get(searchId);
            const list = document.getElementById('list');

            if (cached) {
                // Stale-while-revalidate: paint the cached listing instantly
                // (no spinner), then quietly refetch in the background below.
                applyFolderData(searchId, cached);
            } else {
                list.innerHTML = `<div class="empty content-fade"><div class="sync-spinner"></div><div class="sync-loading-text">Syncing with Drive Folder<span class="sync-dots"><span>.</span><span>.</span><span>.</span></span></div></div>`;
            }

            // If we already have a fresh-enough cached copy, skip the network
            // round trip entirely instead of always refetching in the background.
            if (cached && Date.now() - cached.timestamp < FOLDER_CACHE_TTL_MS) {
                refreshStorageStat(false);
                return;
            }

            try {
                const urlParams = new URLSearchParams({ action: 'fetchItems' });
                urlParams.append('folderId', searchId);

                const response = await fetch(`${MACRO_WEBAPP_URL}?${urlParams.toString()}`);
                const data = await response.json();

                if (data.result === 'success') {
                    folderCache.set(searchId, {
                        items: data.items,
                        currentFolderId: data.currentFolderId,
                        parentFolderId: data.parentFolderId,
                        timestamp: Date.now()
                    });

                    // If the user has already navigated elsewhere while this
                    // was in flight, the cache is still updated above, but
                    // don't clobber the newer view they're now looking at.
                    if (requestId === activeLoadRequestId) {
                        applyFolderData(searchId, data);
                    }
                } else if (!cached) {
                    showToast("Error syncing data from Drive.");
                }
            } catch (err) {
                console.error(err);
                if (!cached) showToast("Failed to fetch data in real-time.");
            }

            refreshStorageStat(false);
        }

        async function navigateToFolder(id, name, keepForward) {
            clearSearchState({ clearInput: true });
            const idx = folderPathStack.findIndex(x => x.id === id);
            if (idx !== -1) {
                folderPathStack = folderPathStack.slice(0, idx + 1);
            } else {
                folderPathStack.push({ id, name });
            }
            if (!keepForward) folderForwardStack = [];
            const mainEl = document.querySelector('.main');
            if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });
            await loadDriveContents(id);
            pushNavState();
        }

        async function navigateToRoot() {
            clearSearchState({ clearInput: true });
            folderPathStack = [];
            folderForwardStack = [];
            const mainEl = document.querySelector('.main');
            if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });
            await loadDriveContents(ROOT_FOLDER_ID);
            pushNavState();
        }

        async function navigateUpOneLevel(parentId) {
            clearSearchState({ clearInput: true });
            folderPathStack.pop();
            const mainEl = document.querySelector('.main');
            if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });
            await loadDriveContents(parentId);
            pushNavState();
        }

        async function goBack() {
            if (!parentFolderId) return;
            const current = folderPathStack[folderPathStack.length - 1];
            if (current) folderForwardStack.push(current);
            await navigateUpOneLevel(parentFolderId);
        }

        async function goNext() {
            if (!folderForwardStack.length) return;
            const target = folderForwardStack.pop();
            await navigateToFolder(target.id, target.name, true);
        }

        function updateNavButtons() {
            const backBtn = document.getElementById('navBackBtn');
            const nextBtn = document.getElementById('navNextBtn');
            if (backBtn) backBtn.disabled = !parentFolderId;
            if (nextBtn) nextBtn.disabled = !folderForwardStack.length;
        }

        function updateBreadcrumbs() {
            const bc = document.getElementById('breadcrumbs');
            let html = `<span class="breadcrumb-item" onclick="navigateToRoot()">Drive Root</span>`;
            folderPathStack.forEach((f) => {
                html += ` <i class="ti ti-chevron-right" style="font-size:12px;"></i> <span class="breadcrumb-item" onclick="navigateToFolder('${f.id}', '${f.name}')">${esc(f.name)}</span>`;
            });
            bc.innerHTML = html;
            replayFade(bc);
        }

        function switchTabFilter(filter) {
            activeFilterGroup = filter;
            document.querySelectorAll('.filter-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            const activeTab = document.getElementById(`tab-${filter}`);
            if (activeTab) activeTab.classList.add('active');
            render();
        }

        function updateCounters() {
            let pdfCount = 0, imgCount = 0, totalFiles = 0;
            driveItems.forEach(f => {
                if (f.type !== 'folder') {
                    totalFiles++;
                    const cat = getFileCategory(f.name, f.type);
                    if (cat === 'pdf') pdfCount++;
                    else if (cat === 'img') imgCount++;
                }
            });
            document.getElementById('sTotal').innerText = totalFiles;
            document.getElementById('sPdf').innerText = pdfCount;
            document.getElementById('sImg').innerText = imgCount;
        }

        function setViewMode(mode) {
            const panel = document.getElementById('fileTablePanel');
            if (!panel) return;
            panel.classList.toggle('view-grid', mode === 'grid');
            panel.classList.toggle('view-list', mode === 'list');
            document.querySelectorAll('.view-toggle-btn').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-view') === mode);
            });
            try { localStorage.setItem('drivesync_view_mode', mode); } catch (e) {}
        }

        (function restoreViewMode() {
            let saved = 'grid';
            try { saved = localStorage.getItem('drivesync_view_mode') || 'grid'; } catch (e) {}
            setViewMode(saved);
        })();

        function render() {
            const list = document.getElementById('list');
            const q = document.getElementById('searchInput').value.toLowerCase().trim();
            const sortBy = document.getElementById('sortSelect').value;

            const searchingDeep = currentMainMode === 'drive' && !!q && deepSearchResults !== null;

            let filtered;
            if (searchingDeep) {
                filtered = deepSearchResults.filter(f => {
                    if (activeFilterGroup === 'all') return true;
                    return getFileCategory(f.name, f.type) === activeFilterGroup;
                });
            } else {
                filtered = driveItems.filter(f => {
                    const matchesQuery = f.name.toLowerCase().includes(q);
                    if (!matchesQuery) return false;
                    if (currentMainMode === 'recent' && f.type === 'folder') return false;
                    if (activeFilterGroup === 'all') return true;
                    return getFileCategory(f.name, f.type) === activeFilterGroup;
                });
            }

            filtered.sort((a, b) => {
                if (a.type === 'folder' && b.type !== 'folder') return -1;
                if (a.type !== 'folder' && b.type === 'folder') return 1;
                return sortBy === 'az' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
            });

            updateCounters();
            updateNavButtons();

            // Keep the ordered list of previewable (non-folder) files in sync with
            // whatever is currently on screen, so the preview popup's prev/next
            // arrows walk through exactly what the user sees.
            currentPreviewList = filtered.filter(f => getFileCategory(f.name, f.type) !== 'folder');

            let html = '';

            if (!filtered.length) {
                if (searchingDeep) {
                    if (!deepSearchLoading) {
                        list.innerHTML = `<div class="empty content-fade"><i class="ti ti-search"></i><div style="font-size:14px;color:var(--color-text-primary)">No matches found in this folder or its subfolders.</div></div>`;
                    }
                    return;
                }
                if (!parentFolderId) {
                    list.innerHTML = `<div class="empty content-fade"><i class="ti ti-folder-off"></i><div style="font-size:14px;color:var(--color-text-primary)">No elements found.</div></div>`;
                    return;
                }
            }

            html += filtered.map((f, idx) => {
                const cat = getFileCategory(f.name, f.type);
                let iconHtml = '<i class="ti ti-file"></i>';
                let badgeBg = 'var(--color-background-secondary)', badgeTxt = 'var(--color-text-secondary)';
                let actionCell = '—';
                let rowClickAction = '';
                let rowClass = '';

                if (cat === 'folder') {
                    iconHtml = '<i class="ti ti-folder"></i>';
                    badgeBg = 'rgba(59,130,246,0.15)'; badgeTxt = '#3b82f6';
                    actionCell = '';
                    rowClass = 'clickable-row';
                    rowClickAction = `onclick="navigateToFolder('${f.id}', '${f.name}')" onmouseenter="prefetchFolder('${f.id}')"`;
                } else {
                    const previewIdx = currentPreviewList.findIndex(x => x.id === f.id);
                    actionCell = `<button
                        class="btn"
                        style="padding:5px 10px;font-size:12px;height:30px;color:#22c55e;border-color:rgba(34,197,94,0.3);background:rgba(34,197,94,0.08);"
                        onclick="openPreview(${previewIdx})">
                        <i class="ti ti-eye"></i> View File
                    </button>`;

                    if (cat === 'pdf') { iconHtml = '<i class="ti ti-file-type-pdf"></i>'; badgeBg = 'rgba(239,68,68,0.15)'; badgeTxt = '#ef4444'; }
                    else if (cat === 'img') { iconHtml = '<i class="ti ti-photo"></i>'; badgeBg = 'rgba(225,29,72,0.15)'; badgeTxt = '#e11d48'; }
                    else if (cat === 'doc') { iconHtml = '<i class="ti ti-file-text"></i>'; badgeBg = 'rgba(59,130,246,0.15)'; badgeTxt = '#3b82f6'; }
                    else if (cat === 'text') { iconHtml = '<i class="ti ti-file-text"></i>'; badgeBg = 'rgba(100,116,139,0.15)'; badgeTxt = '#64748b'; }
                    else if (cat === 'sheet') { iconHtml = '<i class="ti ti-file-spreadsheet"></i>'; badgeBg = 'rgba(34,197,94,0.15)'; badgeTxt = '#22c55e'; }
                    else if (cat === 'slide') { iconHtml = '<i class="ti ti-presentation"></i>'; badgeBg = 'rgba(245,158,11,0.15)'; badgeTxt = '#f59e0b'; }
                    else if (cat === 'audio') { iconHtml = '<i class="ti ti-file-music"></i>'; badgeBg = 'rgba(168,85,247,0.15)'; badgeTxt = '#a855f7'; }
                    else if (cat === 'video') { iconHtml = '<i class="ti ti-video"></i>'; badgeBg = 'rgba(99,102,241,0.15)'; badgeTxt = '#6366f1'; }
                    else if (cat === 'zip') { iconHtml = '<i class="ti ti-file-zip"></i>'; badgeBg = 'rgba(217,119,6,0.15)'; badgeTxt = '#d97706'; }
                    else if (cat === 'code') { iconHtml = '<i class="ti ti-file-code"></i>'; badgeBg = 'rgba(20,184,166,0.15)'; badgeTxt = '#14b8a6'; }
                }

                const rowDelay = Math.min(idx * 25, 300);
                const pathSub = searchingDeep && f._path
                    ? `<div class="fname-sub search-path-sub">↳ ${esc(f._path)}</div>`
                    : (cat === 'folder' ? '' : `<div class="fname-sub">${fmtSz(f.size)}</div>`);
                return `
                <div class="trow ${rowClass} row-enter" style="animation-delay:${rowDelay}ms">
                    <div class="fname" ${rowClickAction}>
                        <div class="ficon" style="background:${badgeBg};color:${badgeTxt}">${iconHtml}</div>
                        <div>
                            <div class="fname-text${cat === 'folder' ? ' folder-pill' : ''}" title="${esc(f.name)}">${esc(f.name)}</div>
                            ${pathSub}
                        </div>
                    </div>
                    <div ${rowClickAction}><span class="badge" style="background:${badgeBg};color:${badgeTxt}">${cat === 'folder' ? 'Folder' : getBadgeLabel(f.name, f.type)}</span></div>
                    <div>${actionCell}</div>
                    <div style="display:flex;gap:4px;justify-content:flex-end;">
                        <button class="btn-delete" style="color:#a855f7;border-color:rgba(168,85,247,0.3);"
                            onclick="handleRenameItem('${f.id}','${cat === 'folder' ? 'folder' : 'file'}','${esc(f.name)}')" title="Rename">
                            <i class="ti ti-edit"></i>
                        </button>
                        ${cat === 'folder' ? '' : `<button class="btn-delete btn-download" style="color:#3b82f6;border-color:rgba(59,130,246,0.3);"
                            onclick="downloadDriveFile('${f.id}')" title="Download">
                            <i class="ti ti-download"></i>
                        </button>`}
                        <button class="btn-delete" title="Delete" onclick="handleDeleteItem('${f.id}','${cat === 'folder' ? 'folder' : 'file'}','${esc(f.name)}')">
                            <i class="ti ti-trash"></i>
                        </button>
                    </div>
                </div>`;
            }).join('');

            list.innerHTML = html;
            replayFade(list);
        }

        function extractDriveFileId(url) {
            const idMatch = url.match(/\/d\/([^\/]+)/) || url.match(/id=([^&]+)/);
            return idMatch ? idMatch[1] : null;
        }

        function resolvePreviewStrategy(url, mimeType) {
            const fileId = extractDriveFileId(url);
            if (!fileId) return { type: 'fallback' };
            const isImage = mimeType && mimeType.startsWith('image/');
            if (isImage) return { type: 'image', src: `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600` };
            return { type: 'iframe', src: `https://drive.google.com/file/d/${fileId}/preview` };
        }

        function getIconForMime(mimeType, name) {
            const cat = getFileCategory(name || '', mimeType || '');
            const map = {
                pdf: 'ti-file-type-pdf',
                img: 'ti-photo',
                doc: 'ti-file-text',
                text: 'ti-file-text',
                sheet: 'ti-file-spreadsheet',
                slide: 'ti-presentation',
                audio: 'ti-file-music',
                video: 'ti-video',
                zip: 'ti-file-zip',
                code: 'ti-file-code',
                folder: 'ti-folder'
            };
            return map[cat] || 'ti-file';
        }

        function loadPreviewFile(index) {
            const file = currentPreviewList[index];
            if (!file) return;
            currentPreviewIndex = index;

            const body = document.getElementById('previewBody');
            const loader = document.getElementById('previewLoader');
            const driveLink = document.getElementById('previewDriveLink');
            const downloadLink = document.getElementById('previewDownloadLink');
            const filename = document.getElementById('previewFilename');
            const fileIcon = document.getElementById('previewFileIcon');

            const rawUrl = file.url;
            const rawName = file.name;
            const rawMime = file.type || '';

            filename.textContent = rawName;
            fileIcon.className = `ti ${getIconForMime(rawMime, rawName)}`;
            driveLink.href = rawUrl;

            const fileId = extractDriveFileId(rawUrl);
            if (fileId) {
                downloadLink.href = `https://drive.google.com/uc?export=download&id=${fileId}`;
                downloadLink.setAttribute('download', rawName);
                downloadLink.classList.remove('hidden');
            } else {
                downloadLink.removeAttribute('href');
                downloadLink.classList.add('hidden');
            }

            loader.classList.remove('hidden');
            body.querySelectorAll('.preview-content').forEach(el => el.remove());

            const strategy = resolvePreviewStrategy(rawUrl, rawMime);

            if (strategy.type === 'iframe') {
                const iframe = document.createElement('iframe');
                iframe.className = 'preview-content';
                iframe.src = strategy.src;
                iframe.setAttribute('allowfullscreen', '');
                iframe.onload = () => loader.classList.add('hidden');
                body.appendChild(iframe);
            } else if (strategy.type === 'image') {
                const img = document.createElement('img');
                img.className = 'preview-content';
                img.src = strategy.src;
                img.alt = rawName;
                img.onload = () => loader.classList.add('hidden');
                // The public drive.google.com/thumbnail endpoint occasionally
                // fails on the first try (transient rate-limiting, especially
                // when flipping through several images quickly via prev/next)
                // or refuses files that aren't shared "Anyone with the link".
                // Retry once on the same host, then fall back to Google's other
                // public image host before giving up and showing "no preview".
                img.dataset.retryStage = '0';
                img.onerror = () => {
                    const stage = img.dataset.retryStage;
                    if (stage === '0' && fileId) {
                        img.dataset.retryStage = '1';
                        setTimeout(() => { img.src = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600&t=${Date.now()}`; }, 600);
                        return;
                    }
                    if (stage === '1' && fileId) {
                        img.dataset.retryStage = '2';
                        img.src = `https://lh3.googleusercontent.com/d/${fileId}=w1600`;
                        return;
                    }
                    loader.classList.add('hidden');
                    img.replaceWith(buildFallback(rawUrl, rawName));
                };
                body.appendChild(img);
            } else {
                loader.classList.add('hidden');
                body.appendChild(buildFallback(rawUrl, rawName));
            }

            updatePreviewNavButtons();
        }

        function openPreview(index) {
            loadPreviewFile(index);
            document.getElementById('previewOverlay').classList.add('open');
            document.body.style.overflow = 'hidden';
            pushNavState();
        }

        function previewPrev() {
            if (currentPreviewIndex > 0) loadPreviewFile(currentPreviewIndex - 1);
        }

        function previewNext() {
            if (currentPreviewIndex < currentPreviewList.length - 1) loadPreviewFile(currentPreviewIndex + 1);
        }

        function updatePreviewNavButtons() {
            const prevBtn = document.getElementById('previewPrevBtn');
            const nextBtn = document.getElementById('previewNextBtn');
            if (!prevBtn || !nextBtn) return;
            const hasMultiple = currentPreviewList.length > 1;
            prevBtn.classList.toggle('hidden', !hasMultiple);
            nextBtn.classList.toggle('hidden', !hasMultiple);
            prevBtn.classList.toggle('disabled', currentPreviewIndex <= 0);
            nextBtn.classList.toggle('disabled', currentPreviewIndex >= currentPreviewList.length - 1);
        }

        function buildFallback(url, name) {
            const div = document.createElement('div');
            div.className = 'preview-fallback preview-content';
            div.innerHTML = `
            <i class="ti ti-file-off"></i>
            <p>Preview is not available for this file type.<br>Open it directly in Google Drive to view its contents.</p>
            <a href="${url}" target="_blank" rel="noopener" class="btn btn-primary" style="display:inline-flex;text-decoration:none;">
                <i class="ti ti-external-link"></i> Open in Google Drive
            </a>`;
            return div;
        }

        function closePreview() {
            document.getElementById('previewOverlay').classList.remove('open');
            document.body.style.overflow = '';
            document.getElementById('previewBody').querySelectorAll('iframe').forEach(f => f.src = '');
            currentPreviewIndex = -1;
        }

        function handlePreviewOverlayClick(e) {
            if (e.target === document.getElementById('previewOverlay')) closePreview();
        }

        function openFolderModal() {
            document.getElementById('folderModal').classList.add('open');
            const input = document.getElementById('folderNameInput');
            input.value = '';
            input.focus();
            pushNavState();
        }

        function closeFolderModal() { document.getElementById('folderModal').classList.remove('open'); }

        async function submitFolderCreation() {
            const input = document.getElementById('folderNameInput');
            const folderName = input.value.trim();
            if (!folderName) { showToast("Folder name cannot be empty."); return; }

            closeFolderModal();
            showToast(`Creating folder "${folderName}"...`);

            try {
                const response = await fetch(MACRO_WEBAPP_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ action: 'createFolder', folderName, parentFolderId: currentFolderId || '' })
                });
                const data = await response.json();
                if (data.result === 'success') {
                    showToast("Folder successfully created!");
                    reloadCurrentFolder();
                } else {
                    showToast("Failed to create folder structure.");
                }
            } catch (err) {
                console.error(err);
                showToast("Syncing cloud folder tree structure...");
                setTimeout(() => reloadCurrentFolder(), 1500);
            }
        }

        function downloadDriveFile(id) {
            if (!id) return;
            // Hidden iframe: Drive answers with "Content-Disposition: attachment", so the
            // browser saves the file directly - no new tab, and this page stays put.
            const frame = document.createElement('iframe');
            frame.style.display = 'none';
            frame.setAttribute('aria-hidden', 'true');
            frame.src = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
            document.body.appendChild(frame);
            setTimeout(() => frame.remove(), 2 * 60 * 1000);
        }

        function handleDeleteItem(id, type, name) {
            pendingDeleteTarget = { id, type };
            const modal = document.getElementById('deleteModal');
            document.getElementById('deleteModalMessage').innerHTML = `Delete <strong>"${esc(name)}"</strong>?`;
            modal.classList.add('open');
            document.getElementById('confirmDeleteBtn').onclick = executeItemDeletion;
            pushNavState();
        }

        function closeDeleteModal() {
            document.getElementById('deleteModal').classList.remove('open');
            pendingDeleteTarget = null;
        }

        async function executeItemDeletion() {
            if (!pendingDeleteTarget) return;
            const { id, type } = pendingDeleteTarget;
            closeDeleteModal();
            showToast(`Purging ${type} resource...`);

            try {
                const response = await fetch(MACRO_WEBAPP_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ action: 'deleteItem', itemId: id, itemType: type })
                });
                const data = await response.json();
                if (data.result === 'success') {
                    showToast("Asset deleted safely.");
                    if (deepSearchResults) deepSearchResults = deepSearchResults.filter(x => x.id !== id);
                    reloadCurrentFolder();
                } else {
                    showToast("Failed to delete: " + (data.message || "Unknown error."));
                }
            } catch (err) {
                console.error(err);
                showToast("Failed to delete: " + err.message);
            }
        }

        // =============================================
        // RENAME (file or folder, from the row actions)
        // =============================================
        function handleRenameItem(id, type, currentName) {
            pendingRenameTarget = { id, type, currentName };
            const input = document.getElementById('renameInput');
            input.value = currentName;
            document.getElementById('renameError').style.display = 'none';
            document.getElementById('renameModal').classList.add('open');
            pushNavState();

            setTimeout(() => {
                input.focus();
                if (type === 'file') {
                    // Preselect just the base name so typing replaces it
                    // without disturbing the extension — matches most file managers.
                    const dot = currentName.lastIndexOf('.');
                    if (dot > 0) input.setSelectionRange(0, dot);
                    else input.select();
                } else {
                    input.select();
                }
            }, 50);
        }

        function closeRenameModal() {
            document.getElementById('renameModal').classList.remove('open');
            pendingRenameTarget = null;
        }

        async function submitRenameItem() {
            if (!pendingRenameTarget) return;
            const { id, type, currentName } = pendingRenameTarget;
            const errEl = document.getElementById('renameError');
            const newName = document.getElementById('renameInput').value.trim();

            errEl.style.display = 'none';

            if (!newName) {
                errEl.textContent = 'Name cannot be empty.';
                errEl.style.display = 'block';
                return;
            }
            if (newName === currentName) {
                closeRenameModal();
                return;
            }

            const btn = document.getElementById('confirmRenameBtn');
            btn.disabled = true;
            btn.innerText = 'Renaming...';

            try {
                const response = await fetch(MACRO_WEBAPP_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ action: 'renameItem', itemId: id, itemType: type, newName })
                });
                const data = await response.json();
                if (data.result === 'success') {
                    showToast('Renamed successfully.');
                    if (deepSearchResults) {
                        deepSearchResults = deepSearchResults.map(x => x.id === id ? { ...x, name: newName } : x);
                    }
                    closeRenameModal();
                    reloadCurrentFolder();
                } else {
                    errEl.textContent = data.message || 'Failed to rename.';
                    errEl.style.display = 'block';
                }
            } catch (err) {
                console.error(err);
                errEl.textContent = 'Network error — please try again.';
                errEl.style.display = 'block';
            } finally {
                btn.disabled = false;
                btn.innerText = 'Rename';
            }
        }

        // =============================================
        // NOTES (Google Keep-style, stored as .txt files
        // in a hidden "Notes" Drive folder)
        // =============================================
        let notesCache = [];
        let currentNoteId = null; // null while editing a brand-new, unsaved note
        let noteDeleteArmed = false;

        async function refreshNotesGrid() {
            const grid = document.getElementById('notesGrid');
            grid.innerHTML = `<div class="empty" style="padding:2rem;"><div class="sync-spinner"></div></div>`;
            try {
                if (!notesFolderId) notesFolderId = await ensureNotesFolder(MACRO_WEBAPP_URL, ROOT_FOLDER_ID);
                notesCache = await listNotes(MACRO_WEBAPP_URL, notesFolderId);

                if (!notesCache.length) {
                    grid.innerHTML = `<div class="empty" style="padding:2rem;grid-column:1/-1;">No notes yet — tap "New Note" to add one.</div>`;
                    return;
                }

                grid.innerHTML = notesCache.map(n => `
                    <div class="note-card" onclick="openNoteEditor('${n.id}')">
                        <div class="note-card-title">${esc(n.title)}</div>
                        <div class="note-card-date">${n.modifiedTime ? new Date(n.modifiedTime).toLocaleDateString() : ''}</div>
                    </div>
                `).join('');
            } catch (err) {
                console.error(err);
                grid.innerHTML = `<div class="empty" style="padding:2rem;grid-column:1/-1;color:#ef4444;">Couldn't load notes: ${esc(err.message)}</div>`;
            }
        }

        async function openNoteEditor(noteId) {
            currentNoteId = noteId;
            noteDeleteArmed = false;
            document.getElementById('notesGridView').style.display = 'none';
            document.getElementById('noteEditorSectionView').style.display = 'block';
            document.getElementById('noteEditorError').style.display = 'none';
            document.getElementById('noteSavedStatus').textContent = '';

            const titleInput = document.getElementById('noteTitleInput');
            const contentInput = document.getElementById('noteContentInput');
            const deleteBtn = document.getElementById('noteDeleteBtn');

            if (!noteId) {
                titleInput.value = '';
                contentInput.value = '';
                deleteBtn.style.display = 'none';
                setTimeout(() => titleInput.focus(), 50);
                return;
            }

            deleteBtn.style.display = 'inline-flex';
            deleteBtn.innerHTML = '<i class="ti ti-trash"></i>';
            titleInput.value = 'Loading…';
            contentInput.value = '';
            titleInput.disabled = true;
            contentInput.disabled = true;

            try {
                const meta = notesCache.find(n => n.id === noteId);
                const content = await loadNoteContent(MACRO_WEBAPP_URL, noteId);
                titleInput.value = meta ? meta.title : '';
                contentInput.value = content;
            } catch (err) {
                console.error(err);
                document.getElementById('noteEditorError').textContent = "Couldn't load this note: " + err.message;
                document.getElementById('noteEditorError').style.display = 'block';
            } finally {
                titleInput.disabled = false;
                contentInput.disabled = false;
            }
        }

        async function backToNotesList() {
            document.getElementById('noteEditorSectionView').style.display = 'none';
            document.getElementById('notesGridView').style.display = 'block';
            await refreshNotesGrid();
        }

        async function saveCurrentNote() {
            const errEl = document.getElementById('noteEditorError');
            const statusEl = document.getElementById('noteSavedStatus');
            const saveBtn = document.getElementById('noteSaveBtn');
            const title = document.getElementById('noteTitleInput').value.trim() || 'Untitled';
            const content = document.getElementById('noteContentInput').value;

            errEl.style.display = 'none';
            saveBtn.disabled = true;
            saveBtn.innerText = 'Saving...';

            try {
                if (!notesFolderId) notesFolderId = await ensureNotesFolder(MACRO_WEBAPP_URL, ROOT_FOLDER_ID);

                if (!currentNoteId) {
                    const created = await createNote(MACRO_WEBAPP_URL, notesFolderId, title, content);
                    currentNoteId = created.id;
                    document.getElementById('noteDeleteBtn').style.display = 'inline-flex';
                } else {
                    const result = await saveNoteContent(MACRO_WEBAPP_URL, currentNoteId, title, content);
                    currentNoteId = result.id;
                }
                statusEl.textContent = 'Saved just now';
                showToast('Note saved.');
                return true;
            } catch (err) {
                console.error(err);
                errEl.textContent = 'Failed to save: ' + err.message;
                errEl.style.display = 'block';
                return false;
            } finally {
                saveBtn.disabled = false;
                saveBtn.innerText = 'Save';
            }
        }

        async function handleDeleteNote() {
            if (!currentNoteId) return;
            const deleteBtn = document.getElementById('noteDeleteBtn');

            if (!noteDeleteArmed) {
                noteDeleteArmed = true;
                deleteBtn.innerHTML = '<i class="ti ti-alert-triangle"></i> Confirm?';
                setTimeout(() => { noteDeleteArmed = false; if (deleteBtn) deleteBtn.innerHTML = '<i class="ti ti-trash"></i>'; }, 3000);
                return;
            }

            deleteBtn.disabled = true;
            try {
                await deleteNote(MACRO_WEBAPP_URL, currentNoteId);
                showToast('Note deleted.');
                currentNoteId = null;
                await backToNotesList();
            } catch (err) {
                console.error(err);
                showToast('Failed to delete note: ' + err.message);
            } finally {
                if (deleteBtn) deleteBtn.disabled = false;
            }
        }

        async function handleFileUpload() {
            const fileSelector = document.getElementById('fi');
            if (!fileSelector.files.length) return;

            const panel = document.getElementById('uploadPanel');
            const panelList = document.getElementById('uploadPanelList');
            const title = document.getElementById('uploadPanelTitle');

            panelList.innerHTML = '';
            title.innerText = `Uploading ${fileSelector.files.length} file(s)`;
            panel.classList.add('open');

            const filesToUpload = Array.from(fileSelector.files);
            fileSelector.value = '';

            for (let i = 0; i < filesToUpload.length; i++) {
                const file = filesToUpload[i];
                const itemId = 'upload_item_' + Date.now() + '_' + i;

                panelList.insertAdjacentHTML('beforeend', `
                <div class="upload-item" id="${itemId}">
                    <div class="upload-item-meta">
                        <span style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><i class="ti ti-file"></i> ${esc(file.name)}</span>
                        <span id="${itemId}_pct">Processing...</span>
                    </div>
                    <div class="upload-progress-container">
                        <div class="upload-progress-bar" id="${itemId}_bar" style="width:15%;"></div>
                    </div>
                </div>`);

                await transmitFileToCloud(itemId, file, currentFolderId || '');
            }

            title.innerHTML = `<i class="ti ti-circle-check" style="color:#22c55e"></i> Upload Complete`;
            reloadCurrentFolder();
            setTimeout(() => { panel.classList.remove('open'); }, 2500);
        }

        async function handleFolderUpload() {
            const folderInput = document.getElementById('fi-folder');
            if (!folderInput.files.length) return;

            const files = Array.from(folderInput.files);
            folderInput.value = '';

            const tree = buildFolderTree(files);
            const rootFolderName = Object.keys(tree.children)[0];

            const panel = document.getElementById('uploadPanel');
            const panelList = document.getElementById('uploadPanelList');
            const title = document.getElementById('uploadPanelTitle');

            panelList.innerHTML = '';
            title.innerHTML = `<i class="ti ti-folder-up" style="color:#3b82f6;"></i> Uploading folder: <strong>${esc(rootFolderName)}</strong>`;
            panel.classList.add('open');

            showToast(`Preparing folder upload: ${rootFolderName}`);

            await uploadFolderTree(tree.children[rootFolderName], rootFolderName, currentFolderId || ROOT_FOLDER_ID, panelList);

            title.innerHTML = `<i class="ti ti-circle-check" style="color:#22c55e"></i> Folder Upload Complete`;
            showToast(`Folder "${rootFolderName}" uploaded successfully!`);
            reloadCurrentFolder();
            setTimeout(() => { panel.classList.remove('open'); }, 3000);
        }

        function buildFolderTree(files) {
            const root = { children: {}, files: [] };
            files.forEach(file => {
                const parts = file.webkitRelativePath.split('/');
                let node = root;
                for (let i = 0; i < parts.length - 1; i++) {
                    const part = parts[i];
                    if (!node.children[part]) {
                        node.children[part] = { children: {}, files: [] };
                    }
                    node = node.children[part];
                }
                node.files.push(file);
            });
            return root;
        }

        async function createDriveFolder(folderName, parentId) {
            const resp = await fetch(MACRO_WEBAPP_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ action: 'createFolder', folderName, parentFolderId: parentId })
            });
            const data = await resp.json();

            if (data.result !== 'success') {
                throw new Error(`createFolder failed for "${folderName}": ${JSON.stringify(data)}`);
            }
            if (data.folderId) return data.folderId;

            console.warn(`createFolder for "${folderName}" did not return folderId — looking up from listing.`);
            await new Promise(r => setTimeout(r, 600));

            const listResp = await fetch(`${MACRO_WEBAPP_URL}?${new URLSearchParams({ action: 'fetchItems', folderId: parentId })}`);
            const listData = await listResp.json();

            if (listData.result === 'success') {
                const match = listData.items.find(
                    item => item.type === 'folder' && item.name === folderName
                );
                if (match && match.id) return match.id;
            }
            throw new Error(`Could not resolve folderId for "${folderName}" after creation.`);
        }

        async function uploadFolderTree(node, folderName, parentId, panelList) {
            let newFolderId;
            const statusId = 'fstatus_' + Date.now();
            panelList.insertAdjacentHTML('beforeend', `
            <div class="upload-folder-header" id="${statusId}">
                <span class="sync-spinner-sm"></span> Creating folder: ${esc(folderName)}
            </div>`);
            panelList.scrollTop = panelList.scrollHeight;

            try {
                newFolderId = await createDriveFolder(folderName, parentId);
                document.getElementById(statusId).innerHTML =
                    `<i class="ti ti-folder" style="color:#22c55e;"></i> ${esc(folderName)}`;
            } catch (err) {
                console.error(err);
                document.getElementById(statusId).innerHTML =
                    `<i class="ti ti-alert-triangle" style="color:#ef4444;"></i> ${esc(folderName)} — folder creation failed, files skipped`;
                showToast(`⚠ Could not create folder "${folderName}". Check Apps Script response.`);
                return;
            }

            for (let i = 0; i < node.files.length; i++) {
                const file = node.files[i];
                const itemId = 'fup_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

                panelList.insertAdjacentHTML('beforeend', `
                <div class="upload-item" id="${itemId}" style="padding-left:28px;">
                    <div class="upload-item-meta">
                        <span style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                            <i class="ti ti-file"></i> ${esc(file.name)}
                        </span>
                        <span id="${itemId}_pct">Queued...</span>
                    </div>
                    <div class="upload-progress-container">
                        <div class="upload-progress-bar" id="${itemId}_bar" style="width:5%;"></div>
                    </div>
                </div>`);

                panelList.scrollTop = panelList.scrollHeight;
                await transmitFileToCloud(itemId, file, newFolderId);
            }

            for (const [subName, subNode] of Object.entries(node.children)) {
                await uploadFolderTree(subNode, subName, newFolderId, panelList);
            }
        }

        function transmitFileToCloud(elementId, file, targetFolderId) {
            return new Promise((resolve) => {
                const bar = document.getElementById(`${elementId}_bar`);
                const text = document.getElementById(`${elementId}_pct`);
                const reader = new FileReader();
                reader.onload = async function (e) {
                    if (bar) bar.style.width = '50%';
                    if (text) text.innerText = 'Transferring...';
                    const base64Data = e.target.result.split(',')[1];
                    try {
                        await fetch(MACRO_WEBAPP_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: new URLSearchParams({
                                fileData: base64Data, mimeType: file.type,
                                fileName: file.name, targetFolderId: targetFolderId || ''
                            })
                        });
                    } catch (_) { }
                    if (bar) bar.style.width = '100%';
                    if (text) text.innerHTML = `<i class="ti ti-circle-check" style="color:#22c55e"></i>`;
                    resolve();
                };
                reader.readAsDataURL(file);
            });
        }

        const dz = document.getElementById('dropZone');

        dz.addEventListener('click', () => { document.getElementById('fi').click(); });
        dz.addEventListener('contextmenu', (e) => { e.preventDefault(); document.getElementById('fi-folder').click(); });
        dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
        dz.addEventListener('dragleave', () => dz.classList.remove('over'));

        dz.addEventListener('drop', async (e) => {
            e.preventDefault();
            dz.classList.remove('over');

            const items = e.dataTransfer.items;
            if (!items) return;

            let hasFolder = false;
            for (const item of items) {
                const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
                if (entry && entry.isDirectory) { hasFolder = true; break; }
            }

            if (hasFolder) {
                await handleDroppedFolders(items);
            } else {
                const dt = new DataTransfer();
                for (const item of items) {
                    const file = item.getAsFile();
                    if (file) dt.items.add(file);
                }
                document.getElementById('fi').files = dt.files;
                handleFileUpload();
            }
        });

        async function handleDroppedFolders(dataTransferItems) {
            const panel = document.getElementById('uploadPanel');
            const panelList = document.getElementById('uploadPanelList');
            const title = document.getElementById('uploadPanelTitle');

            panelList.innerHTML = '';
            title.innerHTML = `<i class="ti ti-folder-up" style="color:#3b82f6;"></i> Processing dropped items...`;
            panel.classList.add('open');

            for (const item of dataTransferItems) {
                const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
                if (!entry) continue;

                if (entry.isDirectory) {
                    const node = await readDirectoryEntry(entry);
                    await uploadFolderTree(node, entry.name, currentFolderId || ROOT_FOLDER_ID, panelList);
                } else if (entry.isFile) {
                    const file = await entryToFile(entry);
                    const itemId = 'dop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
                    panelList.insertAdjacentHTML('beforeend', `
                    <div class="upload-item" id="${itemId}">
                        <div class="upload-item-meta">
                            <span style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><i class="ti ti-file"></i> ${esc(file.name)}</span>
                            <span id="${itemId}_pct">Uploading...</span>
                        </div>
                        <div class="upload-progress-container">
                            <div class="upload-progress-bar" id="${itemId}_bar" style="width:10%;"></div>
                        </div>
                    </div>`);
                    await transmitFileToCloud(itemId, file, currentFolderId || ROOT_FOLDER_ID);
                }
            }

            title.innerHTML = `<i class="ti ti-circle-check" style="color:#22c55e"></i> Drop Upload Complete`;
            reloadCurrentFolder();
            setTimeout(() => { panel.classList.remove('open'); }, 3000);
        }

        async function readDirectoryEntry(dirEntry) {
            const node = { children: {}, files: [] };
            const entries = await readAllEntries(dirEntry.createReader());

            for (const entry of entries) {
                if (entry.isFile) {
                    const file = await entryToFile(entry);
                    node.files.push(file);
                } else if (entry.isDirectory) {
                    node.children[entry.name] = await readDirectoryEntry(entry);
                }
            }
            return node;
        }

        function readAllEntries(reader) {
            return new Promise((resolve) => {
                const allEntries = [];
                function readBatch() {
                    reader.readEntries((entries) => {
                        if (!entries.length) { resolve(allEntries); return; }
                        allEntries.push(...entries);
                        readBatch();
                    }, () => resolve(allEntries));
                }
                readBatch();
            });
        }

        function entryToFile(entry) {
            return new Promise((resolve, reject) => entry.file(resolve, reject));
        }


        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/sw.js').catch(err => {
                    console.error('SW registration failed:', err);
                });
            });
        }



        // --- exposed for inline HTML event handlers ---
        window.closeDeleteModal = closeDeleteModal;
        window.closeFolderModal = closeFolderModal;
        window.closeChangePasswordModal = closeChangePasswordModal;
        window.toggleScriptUrlField = toggleScriptUrlField;
        window.openRegisterModal = openRegisterModal;
        window.closeRegisterModal = closeRegisterModal;
        window.submitRegister = submitRegister;
        window.openChangePasswordModal = openChangePasswordModal;
        window.downloadDriveFile = downloadDriveFile;
        window.openEditProfileModal = openEditProfileModal;
        window.closeEditProfileModal = closeEditProfileModal;
        window.submitEditProfile = submitEditProfile;
        window.handleProfilePhotoPick = handleProfilePhotoPick;
        window.removeProfilePhoto = removeProfilePhoto;
        window.extractFolderId = extractFolderId;
        checkRegisterEnabled();

        // Coming back from /register: prefill the new email on the sign-in form.
        try {
            const justRegistered = sessionStorage.getItem('drivesync_registered_email');
            if (justRegistered) {
                sessionStorage.removeItem('drivesync_registered_email');
                const emailEl = document.getElementById('gateEmail');
                const authErr = document.getElementById('authError');
                if (emailEl) emailEl.value = justRegistered;
                if (authErr) {
                    authErr.style.color = '#22c55e';
                    authErr.innerText = 'Account created. Enter your password to sign in.';
                    authErr.style.display = 'block';
                    setTimeout(() => { authErr.style.color = ''; }, 8000);
                }
                const pwEl = document.getElementById('gatePassword');
                if (pwEl) setTimeout(() => pwEl.focus(), 50);
            }
        } catch (e) { /* storage may be blocked */ }
        window.submitChangePassword = submitChangePassword;
        window.goToHomeView = goToHomeView;
        window.closePreview = closePreview;
        window.closeSidebar = closeSidebar;
        window.executeAppLogout = executeAppLogout;
        window.handleAuthIconTap = handleAuthIconTap;
        window.handleFileUpload = handleFileUpload;
        window.handleFolderUpload = handleFolderUpload;
        window.handleGateKey = handleGateKey;
        window.handlePreviewOverlayClick = handlePreviewOverlayClick;
        window.loadDriveContents = loadDriveContents;
        window.prefetchFolder = prefetchFolder;
        window.navigateToRoot = navigateToRoot;
        window.openFolderModal = openFolderModal;
        window.render = render;
        window.handleSearchInput = handleSearchInput;
        window.submitFolderCreation = submitFolderCreation;
        window.switchCategoryView = switchCategoryView;
        window.switchSidebarFilter = switchSidebarFilter;
        window.switchTabFilter = switchTabFilter;
        window.toggleSidebar = toggleSidebar;
        window.toggleTheme = toggleTheme;
        window.toggleUploadDropdown = toggleUploadDropdown;
        window.triggerFileUpload = triggerFileUpload;
        window.triggerFolderUpload = triggerFolderUpload;
        window.verifyLogin = verifyLogin;
        window.openAddAccountModal = openAddAccountModal;
        window.closeAddAccountModal = closeAddAccountModal;
        window.submitAddAccount = submitAddAccount;
        window.handleDeleteItem = handleDeleteItem;
        window.navigateToFolder = navigateToFolder;
        window.navigateUpOneLevel = navigateUpOneLevel;
        window.goBack = goBack;
        window.goNext = goNext;
        window.openPreview = openPreview;
        window.previewPrev = previewPrev;
        window.previewNext = previewNext;
        window.setViewMode = setViewMode;
        window.handleRenameItem = handleRenameItem;
        window.closeRenameModal = closeRenameModal;
        window.submitRenameItem = submitRenameItem;
        window.switchToNotesSection = switchToNotesSection;
        window.openNoteEditor = openNoteEditor;
        window.backToNotesList = backToNotesList;
        window.saveCurrentNote = saveCurrentNote;
        window.handleDeleteNote = handleDeleteNote;
}

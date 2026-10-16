import { markTabActive, isSameTabSession, clearTabMarker } from '../lib/tabSession.js';
import { getMaskedValue, clearMaskedInput } from '../lib/maskedInput.js';
import {
    ensureNotesFolder, listNotes, loadNoteContent, createNote, saveNoteContent, deleteNote,
} from '../lib/notes.js';

export function initThemePage() {
        // Config settings fetched seamlessly from upstream runtime memory
        let MACRO_WEBAPP_URL = '';
        let ROOT_FOLDER_ID = '';

        let driveItems = [];
        let currentFolderId = null;
        let parentFolderId = null;
        let activeFilterGroup = 'all';
        let folderPathStack = [];
        let folderForwardStack = [];
        let pendingDeleteTarget = null;
        let pendingRenameTarget = null;
        let notesFolderId = null;
        let currentMainMode = 'drive';

        // --- Fast load-up: folder listing cache (mirrors IndexPage.script.js) ---
        const folderCache = new Map();
        const FOLDER_CACHE_TTL_MS = 2 * 60 * 1000;
        const prefetchInFlight = new Set();
        let activeLoadRequestId = 0;

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
                return false;
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

            Promise.resolve(loadDriveContents(ROOT_FOLDER_ID)).then(() => replaceNavState());
            refreshSessionSettingsAndArm();
            return true;
        }

        // Security Lockout Configuration
        const MAX_ATTEMPTS = 3;
        const LOCKOUT_DURATION = 1 * 60 * 60 * 1000; // 1 hour in milliseconds
        let lockoutTimerInterval = null; // Reference for the live countdown interval

        // Theme Configuration Manager
        function initTheme() {
            const savedTheme = localStorage.getItem('drivesync_theme');
            const currentTheme = (savedTheme === 'light' || savedTheme === 'dark')
                ? savedTheme
                : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
            document.documentElement.setAttribute('data-theme', currentTheme);
            const iconNode = document.getElementById('themeIcon');
            if (iconNode) {
                iconNode.className = currentTheme === 'light' ? 'ti ti-moon' : 'ti ti-sun';
            }
        }

        function toggleTheme() {
            const htmlNode = document.documentElement;
            const iconNode = document.getElementById('themeIcon');
            let nextTheme = 'dark';

            if (htmlNode.getAttribute('data-theme') === 'dark') {
                nextTheme = 'light';
                iconNode.className = 'ti ti-moon';
            } else {
                iconNode.className = 'ti ti-sun';
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
            const lockoutExpiry = localStorage.getItem('drivesync_lockout_expiry');
            const errorEl = document.getElementById('authError');
            const unlockBtn = document.querySelector('#authGate .btn-primary');

            if (lockoutExpiry) {
                const remainingTime = parseInt(lockoutExpiry, 10) - Date.now();

                if (remainingTime > 0) {
                    setGateInputsDisabled(true);
                    if (unlockBtn) unlockBtn.disabled = true;
                    errorEl.style.display = 'block';

                    // Clear any duplicate running intervals
                    clearInterval(lockoutTimerInterval);

                    // Update UI text instantly every second
                    const updateCountdownUI = () => {
                        const timeLeft = parseInt(localStorage.getItem('drivesync_lockout_expiry'), 10) - Date.now();

                        if (timeLeft <= 0) {
                            clearInterval(lockoutTimerInterval);
                            localStorage.removeItem('drivesync_lockout_expiry');
                            localStorage.removeItem('drivesync_failed_attempts');
                            setGateInputsDisabled(false);
                            if (unlockBtn) unlockBtn.disabled = false;
                            errorEl.style.display = 'none';
                        } else {
                            const minutes = Math.floor(timeLeft / (60 * 1000));
                            const seconds = Math.floor((timeLeft % (60 * 1000)) / 1000);

                            const paddedMinutes = String(minutes).padStart(2, '0');
                            const paddedSeconds = String(seconds).padStart(2, '0');

                            errorEl.innerText = `Too many incorrect attempts. App locked. Try again in ${paddedMinutes}:${paddedSeconds}`;
                        }
                    };

                    updateCountdownUI();
                    lockoutTimerInterval = setInterval(updateCountdownUI, 1000);
                    return true;
                } else {
                    // Lockout expired, clear security parameters cleanly
                    clearInterval(lockoutTimerInterval);
                    localStorage.removeItem('drivesync_lockout_expiry');
                    localStorage.removeItem('drivesync_failed_attempts');
                    setGateInputsDisabled(false);
                    if (unlockBtn) unlockBtn.disabled = false;
                    errorEl.style.display = 'none';
                }
            }
            return false;
        }

        // The auth gate is hidden by default (see theme.page.css) so it never
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

        // Runs immediately instead of waiting for window "load" — see
        // IndexPage.script.js for the full explanation. Short version: "load"
        // fires late enough that the auth gate would flash on screen for an
        // already logged-in user before this check ran and hid it again.
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

                // Try a silent persistent-login restore before ever showing
                // the password gate. Only reveal it once we know for certain
                // no valid session can be restored.
                const restored = await tryRestorePersistentLogin();
                if (!restored) {
                    showAuthGate();
                }
            }
        })();

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
                    Promise.resolve(loadDriveContents(ROOT_FOLDER_ID)).then(() => replaceNavState());
                    refreshSessionSettingsAndArm();
                    
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

                // Increment tracking mechanisms dynamically
                let currentAttempts = parseInt(localStorage.getItem('drivesync_failed_attempts') || '0', 10);
                currentAttempts++;
                localStorage.setItem('drivesync_failed_attempts', currentAttempts);

                if (currentAttempts >= MAX_ATTEMPTS) {
                    const expiryTimestamp = Date.now() + LOCKOUT_DURATION;
                    localStorage.setItem('drivesync_lockout_expiry', expiryTimestamp);
                    checkLockoutState();
                } else {
                    errorEl.style.display = 'block';
                    errorEl.innerText = `${err.message || "Invalid email or password."} (${MAX_ATTEMPTS - currentAttempts} attempt(s) remaining)`;
                }

                pwField.value = '';
                pwField.focus();
            }
        }

        function executeAppLogout() {
            sessionStorage.removeItem('drivesync_token');
            sessionStorage.removeItem('drivesync_authenticated');
            sessionStorage.removeItem('drivesync_macro');
            sessionStorage.removeItem('drivesync_root');
            sessionStorage.removeItem('drivesync_navstate');
            localStorage.removeItem('drivesync_authenticated');
            localStorage.removeItem('drivesync_macro');
            localStorage.removeItem('drivesync_root');
            localStorage.removeItem('drivesync_token');
            clearTabMarker();
            window.location.reload();
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
            if (e.target.classList && e.target.classList.contains('modal-overlay') && e.target.classList.contains('open')) {
                const closers = {
                    folderModal: closeFolderModal,
                    renameModal: closeRenameModal,
                    changePasswordModal: closeChangePasswordModal,
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
            if (e.key === 'Escape' && document.getElementById('previewOverlay').classList.contains('open')) closePreview();
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
            const mainEl2 = document.querySelector('.main');
            if (mainEl2) mainEl2.scrollTo({ top: 0, behavior: 'smooth' });
            switchTabFilter(filterType);
            pushNavState();
        }

        // =============================================
        // BROWSER / MOBILE BACK-BUTTON NAVIGATION
        // =============================================
        // Push a history entry for every in-app navigation step (folder, root,
        // recent, category filter) and every overlay (preview, modals, mobile
        // sidebar). Pressing the mobile back button then just pops one step
        // within the app instead of closing it outright.
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
            // Overlays/modals each consume a single back press by closing
            // themselves, rather than letting the browser leave the app.
            const changePasswordModal = document.getElementById('changePasswordModal');
            if (changePasswordModal && changePasswordModal.classList.contains('open')) {
                closeChangePasswordModal();
                replaceNavState();
                return;
            }

            const deleteModal = document.getElementById('deleteModal');
            if (deleteModal && deleteModal.classList.contains('open')) {
                closeDeleteModal();
                replaceNavState();
                return;
            }

            const folderModal = document.getElementById('folderModal');
            if (folderModal && folderModal.classList.contains('open')) {
                closeFolderModal();
                replaceNavState();
                return;
            }

            const overlay = document.getElementById('previewOverlay');
            if (overlay && overlay.classList.contains('open')) {
                closePreview();
                replaceNavState();
                return;
            }

            const sidebarNode = document.getElementById('sidebarNode');
            if (sidebarNode && sidebarNode.classList.contains('mobile-open')) {
                closeSidebar();
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

            if (!notesFolderId && searchId === ROOT_FOLDER_ID) {
                const notesFolder = driveItems.find(i => i.type === 'folder' && i.name === 'Notes');
                if (notesFolder) notesFolderId = notesFolder.id;
            }

            updateBreadcrumbs();
            render();
        }

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
                console.error('Failed to refresh storage stat:', err);
            }
        }

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

        function reloadCurrentFolder() {
            folderCache.delete(currentFolderId);
            return loadDriveContents(currentFolderId);
        }

        async function loadDriveContents(folderId = null) {
            if (!document.getElementById('app').classList.contains('authenticated')) return;

            const searchId = folderId || currentFolderId || ROOT_FOLDER_ID;
            const requestId = ++activeLoadRequestId;
            const cached = folderCache.get(searchId);
            const list = document.getElementById('list');

            if (cached) {
                applyFolderData(searchId, cached);
            } else {
                list.innerHTML = `<div class="empty content-fade"><div class="sync-spinner"></div><div class="sync-loading-text">Syncing with Drive Folder<span class="sync-dots"><span>.</span><span>.</span><span>.</span></span></div></div>`;
            }

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
            updateNavButtons();
            pushNavState();
        }

        async function navigateToRoot() {
            folderPathStack = [];
            folderForwardStack = [];
            const mainEl = document.querySelector('.main');
            if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });
            await loadDriveContents(ROOT_FOLDER_ID);
            updateNavButtons();
            pushNavState();
        }

        async function goBack() {
            if (!parentFolderId) return;
            const current = folderPathStack[folderPathStack.length - 1];
            if (current) folderForwardStack.push(current);
            folderPathStack.pop();
            const mainEl = document.querySelector('.main');
            if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });
            await loadDriveContents(parentFolderId);
            updateNavButtons();
            pushNavState();
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
            const q = document.getElementById('searchInput').value.toLowerCase();
            const sortBy = document.getElementById('sortSelect').value;

            let filtered = driveItems.filter(f => {
                const matchesQuery = f.name.toLowerCase().includes(q);
                if (!matchesQuery) return false;
                if (currentMainMode === 'recent' && f.type === 'folder') return false;
                if (activeFilterGroup === 'all') return true;
                return getFileCategory(f.name, f.type) === activeFilterGroup;
            });

            filtered.sort((a, b) => {
                if (a.type === 'folder' && b.type !== 'folder') return -1;
                if (a.type !== 'folder' && b.type === 'folder') return 1;
                return sortBy === 'az' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
            });

            updateCounters();
            updateNavButtons();

            let html = '';

            if (!filtered.length && !parentFolderId) {
                list.innerHTML = `<div class="empty content-fade"><i class="ti ti-folder-off"></i><div style="font-size:14px;color:var(--color-text-primary)">No elements found.</div></div>`;
                return;
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
                    const safeName = esc(f.name);
                    const safeUrl = esc(f.url);
                    const safeMime = esc(f.type || '');
                    actionCell = `<button
                        class="btn"
                        style="padding:5px 10px;font-size:12px;height:30px;color:#22c55e;border-color:rgba(34,197,94,0.3);background:rgba(34,197,94,0.08);"
                        onclick="openPreview('${safeUrl}','${safeName}','${safeMime}')">
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
                return `
                <div class="trow ${rowClass} row-enter" style="animation-delay:${rowDelay}ms">
                    <div class="fname" ${rowClickAction}>
                        <div class="ficon" style="background:${badgeBg};color:${badgeTxt}">${iconHtml}</div>
                        <div>
                            <div class="fname-text${cat === 'folder' ? ' folder-pill' : ''}">${esc(f.name)}</div>
                            ${cat === 'folder' ? '' : `<div class="fname-sub">${fmtSz(f.size)}</div>`}
                        </div>
                    </div>
                    <div ${rowClickAction}><span class="badge" style="background:${badgeBg};color:${badgeTxt}">${cat === 'folder' ? 'Folder' : getBadgeLabel(f.name, f.type)}</span></div>
                    <div>${actionCell}</div>
                    <div style="display:flex;gap:4px;justify-content:flex-end;">
                        <button class="btn-delete" style="color:#a855f7;border-color:rgba(168,85,247,0.3);"
                            onclick="handleRenameItem('${f.id}','${cat === 'folder' ? 'folder' : 'file'}','${esc(f.name)}')" title="Rename">
                            <i class="ti ti-edit"></i>
                        </button>
                        <button class="btn-delete" onclick="handleDeleteItem('${f.id}','${cat === 'folder' ? 'folder' : 'file'}','${esc(f.name)}')">
                            <i class="ti ti-trash"></i>
                        </button>
                    </div>
                </div>`;
            }).join('');

            list.innerHTML = html;
            replayFade(list);
        }

        function resolvePreviewStrategy(url, mimeType) {
            const idMatch = url.match(/\/d\/([^\/]+)/) || url.match(/id=([^&]+)/);
            const fileId = idMatch ? idMatch[1] : null;
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

        function openPreview(url, name, mimeType) {
            const overlay = document.getElementById('previewOverlay');
            const body = document.getElementById('previewBody');
            const loader = document.getElementById('previewLoader');
            const driveLink = document.getElementById('previewDriveLink');
            const filename = document.getElementById('previewFilename');
            const fileIcon = document.getElementById('previewFileIcon');

            const rawUrl = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            const rawName = name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            const rawMime = mimeType.replace(/&amp;/g, '&');

            filename.textContent = rawName;
            fileIcon.className = `ti ${getIconForMime(rawMime, rawName)}`;
            driveLink.href = rawUrl;

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
                img.onerror = () => { loader.classList.add('hidden'); img.replaceWith(buildFallback(rawUrl, rawName)); };
                body.appendChild(img);
            } else {
                loader.classList.add('hidden');
                body.appendChild(buildFallback(rawUrl, rawName));
            }

            overlay.classList.add('open');
            document.body.style.overflow = 'hidden';
            pushNavState();
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

        function handleDeleteItem(id, type, name) {
            pendingDeleteTarget = { id, type };
            const modal = document.getElementById('deleteModal');
            document.getElementById('deleteModalMessage').innerHTML = `Are you absolutely sure you want to delete the ${type} <strong>"${esc(name)}"</strong>? This process cannot be undone.`;
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
        window.openChangePasswordModal = openChangePasswordModal;
        window.submitChangePassword = submitChangePassword;
        window.goToHomeView = goToHomeView;
        window.closePreview = closePreview;
        window.closeSidebar = closeSidebar;
        window.executeAppLogout = executeAppLogout;
        window.handleFileUpload = handleFileUpload;
        window.handleFolderUpload = handleFolderUpload;
        window.handleGateKey = handleGateKey;
        window.handlePreviewOverlayClick = handlePreviewOverlayClick;
        window.loadDriveContents = loadDriveContents;
        window.prefetchFolder = prefetchFolder;
        window.navigateToRoot = navigateToRoot;
        window.openFolderModal = openFolderModal;
        window.render = render;
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
        window.handleDeleteItem = handleDeleteItem;
        window.handleRenameItem = handleRenameItem;
        window.closeRenameModal = closeRenameModal;
        window.submitRenameItem = submitRenameItem;
        window.switchToNotesSection = switchToNotesSection;
        window.openNoteEditor = openNoteEditor;
        window.backToNotesList = backToNotesList;
        window.saveCurrentNote = saveCurrentNote;
        window.handleDeleteNote = handleDeleteNote;
        window.navigateToFolder = navigateToFolder;
        window.openPreview = openPreview;
        window.setViewMode = setViewMode;
        window.goBack = goBack;
        window.goNext = goNext;
}

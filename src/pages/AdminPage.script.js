import { markTabActive, isSameTabSession, clearTabMarker } from '../lib/tabSession.js';
import { attachMaskedInput, getMaskedValue, clearMaskedInput } from '../lib/maskedInput.js';

export function initAdminPage() {
        let ADMIN_PASSCODE = '';
        let editingAccountId = null;
        let editingHasPassword = false;

        const gate = document.getElementById('gate');
        const app = document.getElementById('app');
        const gateError = document.getElementById('gateError');

        // Mask passcode inputs without type="password", so browsers never
        // offer to save them via the native save-password popup.
        ['adminPasscode', 'pCurrent', 'pNew', 'pConfirm'].forEach(id => {
            attachMaskedInput(document.getElementById(id));
        });

        // If a valid session is already stored, hide the gate right away so it
        // never flashes on screen while we verify it in the background.
        if (sessionStorage.getItem('drivesync_admin_passcode') && isSameTabSession()) {
            gate.style.display = 'none';
        }

        // ===================== SIDEBAR NAV / VIEW SWITCHING =====================
        const viewTitles = { add: 'Add Account', manage: 'Existing Accounts', password: 'Change Password', feature: 'Feature Access' };
        let currentView = 'add';

        function switchView(view, element, fromHistory) {
            closeSidebar();
            currentView = view;
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            const targetView = document.getElementById(`view-${view}`);
            targetView.classList.add('active');

            document.querySelectorAll('.sidebar-menu-items .nav-btn').forEach(b => b.classList.remove('active'));
            if (element) {
                element.classList.add('active');
            } else {
                const navBtn = document.getElementById(`nav-${view}`);
                if (navBtn) navBtn.classList.add('active');
            }

            const titleEl = document.getElementById('topbarTitle');
            titleEl.textContent = viewTitles[view] || '';

            const mainEl = document.querySelector('.main');
            if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });

            if (view === 'manage') loadAccounts();
            if (view === 'feature') loadFeatureSettings();

            if (!fromHistory) pushAdminNavState();
        }

        function toggleSidebar() {
            document.getElementById('sidebarNode').classList.toggle('mobile-open');
            document.getElementById('sidebarBackdrop').classList.toggle('show');
        }

        function closeSidebar() {
            document.getElementById('sidebarNode').classList.remove('mobile-open');
            document.getElementById('sidebarBackdrop').classList.remove('show');
        }

        window.addEventListener('resize', () => { if (window.innerWidth >= 1024) closeSidebar(); });

        // ---- Mobile back-button navigation fix ----
        // Push a history entry each time the admin panel switches views, so the
        // mobile back gesture moves one step back inside the app instead of
        // closing the page. If the edit-account modal is open, back closes it
        // first rather than leaving the current view.
        let suppressAdminHistoryPush = false;

        function pushAdminNavState() {
            if (suppressAdminHistoryPush) return;
            history.pushState({ view: currentView }, '', location.href);
        }

        function replaceAdminNavState() {
            history.replaceState({ view: currentView }, '', location.href);
        }

        window.addEventListener('popstate', (e) => {
            if (editModalBackdrop.classList.contains('show')) {
                closeEditModal();
                replaceAdminNavState();
                return;
            }

            if (!app.classList.contains('show')) return;

            const state = e.state;
            if (!state) return;

            suppressAdminHistoryPush = true;
            switchView(state.view || 'add', null, true);
            suppressAdminHistoryPush = false;
        });

        // ===================== AUTH =====================
        async function apiFetch(path, options = {}) {
            const res = await fetch(path, {
                ...options,
                headers: {
                    ...(options.headers || {}),
                    'x-admin-passcode': ADMIN_PASSCODE
                }
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
            return data;
        }

        async function unlock() {
            const val = getMaskedValue(document.getElementById('adminPasscode')).trim();
            if (!val) return;
            ADMIN_PASSCODE = val;
            gateError.textContent = '';

            try {
                await loadAccounts(); // doubles as a passcode check
                sessionStorage.setItem('drivesync_admin_passcode', ADMIN_PASSCODE);
                markTabActive();
                gate.style.display = 'none';
                app.classList.add('show');
                replaceAdminNavState();
            } catch (err) {
                ADMIN_PASSCODE = '';
                gateError.textContent = err.message || 'Invalid admin passcode.';
            }
        }

        function logout() {
            ADMIN_PASSCODE = '';
            sessionStorage.removeItem('drivesync_admin_passcode');
            clearTabMarker();
            window.location.href = '/';
        }

        document.getElementById('unlockBtn').addEventListener('click', unlock);
        document.getElementById('adminPasscode').addEventListener('keydown', e => {
            if (e.key === 'Enter') unlock();
        });
        document.getElementById('logoutBtn').addEventListener('click', logout);

        function escapeHtml(str) {
            return String(str).replace(/[&<>"']/g, c => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[c]));
        }

        async function loadAccounts() {
            const data = await apiFetch('/api/admin-accounts');
            const list = document.getElementById('accountList');

            if (!data.accounts || data.accounts.length === 0) {
                list.innerHTML = '<div class="empty">No accounts added through this panel yet.</div>';
                return;
            }

            list.innerHTML = data.accounts.map(a => `
                <div class="row" data-id="${escapeHtml(a.id)}">
                    <div class="row-info">
                        <div class="label">${escapeHtml(a.label)}</div>
                        <div style="font-size:12px;opacity:.65;margin-top:2px;">${escapeHtml(a.email || '')}</div>
                    </div>
                    <div class="row-actions" style="display:flex; gap:8px;">
                        <button class="btn ghost" data-edit="${escapeHtml(a.id)}">Edit</button>
                        <button class="btn danger" data-delete="${escapeHtml(a.id)}">Delete</button>
                    </div>
                </div>
            `).join('');

            list.querySelectorAll('[data-delete]').forEach(btn => {
                btn.addEventListener('click', () => deleteAccount(btn.getAttribute('data-delete')));
            });
            list.querySelectorAll('[data-edit]').forEach(btn => {
                btn.addEventListener('click', () => openEditModal(btn.getAttribute('data-edit')));
            });
        }

        // ===================== EDIT MODAL =====================
        const editModalBackdrop = document.getElementById('editModalBackdrop');

        async function openEditModal(id) {
            const editToast = document.getElementById('editToast');
            editToast.textContent = '';
            editToast.className = 'toast';

            try {
                const data = await apiFetch(`/api/admin-accounts?id=${encodeURIComponent(id)}`);
                const acc = data.account;
                editingAccountId = acc.id;
                document.getElementById('eLabel').value = acc.label || '';
                document.getElementById('eEmail').value = acc.email || '';
                document.getElementById('ePassword').value = '';
                editingHasPassword = !!acc.hasPassword;
                document.getElementById('ePassword').placeholder = 'Leave blank to keep the current password';
                document.getElementById('eMacroUrl').value = acc.macroUrl || '';
                document.getElementById('eRootFolderId').value = acc.rootFolderId || '';
                editModalBackdrop.classList.add('show');
            } catch (err) {
                alert(err.message);
            }
        }

        function closeEditModal() {
            editModalBackdrop.classList.remove('show');
            editingAccountId = null;
        }

        document.getElementById('editModalClose').addEventListener('click', closeEditModal);
        document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);
        editModalBackdrop.addEventListener('click', (e) => {
            if (e.target === editModalBackdrop) closeEditModal();
        });

        document.getElementById('editSaveBtn').addEventListener('click', async () => {
            const label = document.getElementById('eLabel').value.trim();
            const email = document.getElementById('eEmail').value.trim();
            const password = document.getElementById('ePassword').value;
            const macroUrl = document.getElementById('eMacroUrl').value.trim();
            const rootFolderId = document.getElementById('eRootFolderId').value.trim();
            const editToast = document.getElementById('editToast');
            editToast.textContent = '';
            editToast.className = 'toast';

            if (!label || !email || !macroUrl || !rootFolderId || (!password && !editingHasPassword)) {
                editToast.textContent = editingHasPassword ? 'Label, email, script URL and folder ID are required.' : 'All fields are required, including a password.';
                editToast.classList.add('err');
                return;
            }

            try {
                await apiFetch(`/api/admin-accounts?id=${encodeURIComponent(editingAccountId)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ label, email, password: password || undefined, macroUrl, rootFolderId })
                });
                closeEditModal();
                await loadAccounts();
            } catch (err) {
                editToast.textContent = err.message;
                editToast.classList.add('err');
            }
        });

        async function deleteAccount(id) {
            if (!confirm('Remove this account? It will no longer be able to log in.')) return;
            try {
                await apiFetch(`/api/admin-accounts?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
                await loadAccounts();
            } catch (err) {
                alert(err.message);
            }
        }

        document.getElementById('addBtn').addEventListener('click', async () => {
            const label = document.getElementById('fLabel').value.trim();
            const email = document.getElementById('fEmail').value.trim();
            const password = document.getElementById('fPassword').value;
            const macroUrl = document.getElementById('fMacroUrl').value.trim();
            const rootFolderId = document.getElementById('fRootFolderId').value.trim();
            const toast = document.getElementById('addToast');
            toast.textContent = '';
            toast.className = 'toast';

            if (!label || !email || !password || !macroUrl || !rootFolderId) {
                toast.textContent = 'All fields are required.';
                toast.classList.add('err');
                return;
            }

            try {
                await apiFetch('/api/admin-accounts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ label, email, password, macroUrl, rootFolderId })
                });
                toast.textContent = 'Account added.';
                toast.classList.add('ok');
                ['fLabel', 'fEmail', 'fPassword', 'fMacroUrl', 'fRootFolderId'].forEach(id => document.getElementById(id).value = '');
            } catch (err) {
                toast.textContent = err.message;
                toast.classList.add('err');
            }
        });

        document.getElementById('changePasswordBtn').addEventListener('click', async () => {
            const current = getMaskedValue(document.getElementById('pCurrent')).trim();
            const next = getMaskedValue(document.getElementById('pNew')).trim();
            const confirmVal = getMaskedValue(document.getElementById('pConfirm')).trim();
            const toast = document.getElementById('passwordToast');
            toast.textContent = '';
            toast.className = 'toast';

            if (!current || !next || !confirmVal) {
                toast.textContent = 'All fields are required.';
                toast.classList.add('err');
                return;
            }
            if (next.length < 4) {
                toast.textContent = 'New passcode must be at least 4 characters.';
                toast.classList.add('err');
                return;
            }
            if (next !== confirmVal) {
                toast.textContent = 'New passcode and confirmation do not match.';
                toast.classList.add('err');
                return;
            }
            if (next === current) {
                toast.textContent = 'New passcode must be different from the current one.';
                toast.classList.add('err');
                return;
            }

            try {
                await apiFetch('/api/admin-passcode', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ currentPasscode: current, newPasscode: next })
                });

                // Keep this tab's session working under the new passcode.
                ADMIN_PASSCODE = next;
                sessionStorage.setItem('drivesync_admin_passcode', ADMIN_PASSCODE);

                toast.textContent = 'Password updated. Use the new passcode next time you log in.';
                toast.classList.add('ok');
                ['pCurrent', 'pNew', 'pConfirm'].forEach(id => clearMaskedInput(document.getElementById(id)));
            } catch (err) {
                toast.textContent = err.message;
                toast.classList.add('err');
            }
        });

        // ===================== FEATURE ACCESS (self-service Add Account toggle) =====================
        let cachedAccountsForFeature = [];

        function renderSpecificUsersList(selectedIds) {
            const box = document.getElementById('specificUsersList');
            if (!cachedAccountsForFeature.length) {
                box.innerHTML = '<div class="empty">No accounts added through this panel yet — add one first.</div>';
                return;
            }
            box.innerHTML = cachedAccountsForFeature.map(a => `
                <label class="feature-checkbox-row">
                    <input type="checkbox" class="specific-user-checkbox" value="${escapeHtml(a.id)}" ${selectedIds.includes(a.id) ? 'checked' : ''}>
                    <span>${escapeHtml(a.label)}</span>
                </label>
            `).join('');
        }

        function updateSpecificBoxVisibility() {
            const mode = document.querySelector('input[name="addAccountMode"]:checked')?.value;
            document.getElementById('specificUsersBox').style.display = mode === 'specific' ? 'block' : 'none';
        }

        document.querySelectorAll('input[name="addAccountMode"]').forEach(radio => {
            radio.addEventListener('change', updateSpecificBoxVisibility);
        });

        // ===================== SESSION TIMEOUT (auto-logout) =====================
        function updateSessionTimeoutBoxVisibility() {
            const mode = document.querySelector('input[name="sessionMode"]:checked')?.value;
            document.getElementById('sessionTimeoutBox').style.display = mode === 'never' ? 'none' : 'block';
        }

        document.querySelectorAll('input[name="sessionMode"]').forEach(radio => {
            radio.addEventListener('change', updateSessionTimeoutBoxVisibility);
        });

        document.getElementById('saveSessionBtn').addEventListener('click', async () => {
            const toast = document.getElementById('sessionToast');
            toast.textContent = '';
            toast.className = 'toast';

            const mode = document.querySelector('input[name="sessionMode"]:checked')?.value || 'timeout';
            const minutesField = document.getElementById('sessionTimeoutMinutes');
            const timeoutMinutes = Number(minutesField.value);
            const persistAcrossTabClose = document.getElementById('persistAcrossTabCloseToggle').checked;

            if (mode === 'timeout' && (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0)) {
                toast.textContent = 'Enter a valid number of minutes (greater than 0).';
                toast.classList.add('err');
                return;
            }

            try {
                await apiFetch('/api/feature-settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionSettings: { mode, timeoutMinutes, persistAcrossTabClose } })
                });
                toast.textContent = 'Session setting saved.';
                toast.classList.add('ok');
            } catch (err) {
                toast.textContent = err.message;
                toast.classList.add('err');
            }
        });

        async function loadFeatureSettings() {
            const toast = document.getElementById('featureToast');
            toast.textContent = '';
            toast.className = 'toast';

            try {
                const [settingsData, accountsData] = await Promise.all([
                    apiFetch('/api/feature-settings'),
                    apiFetch('/api/admin-accounts')
                ]);

                cachedAccountsForFeature = accountsData.accounts || [];

                const mode = settingsData.settings?.addAccountAccess?.mode || 'off';
                const allowedIds = settingsData.settings?.addAccountAccess?.allowedAccountIds || [];

                const radio = document.getElementById(mode === 'all' ? 'modeAll' : mode === 'specific' ? 'modeSpecific' : 'modeOff');
                if (radio) radio.checked = true;

                renderSpecificUsersList(allowedIds);
                updateSpecificBoxVisibility();

                const sessionMode = settingsData.settings?.sessionSettings?.mode === 'never' ? 'never' : 'timeout';
                const sessionMinutes = settingsData.settings?.sessionSettings?.timeoutMinutes || 2;

                const sessionRadio = document.getElementById(sessionMode === 'never' ? 'sessionModeNever' : 'sessionModeTimeout');
                if (sessionRadio) sessionRadio.checked = true;
                document.getElementById('sessionTimeoutMinutes').value = sessionMinutes;
                document.getElementById('persistAcrossTabCloseToggle').checked = !!settingsData.settings?.sessionSettings?.persistAcrossTabClose;
                updateSessionTimeoutBoxVisibility();
            } catch (err) {
                toast.textContent = err.message;
                toast.classList.add('err');
            }
        }

        document.getElementById('saveFeatureBtn').addEventListener('click', async () => {
            const toast = document.getElementById('featureToast');
            toast.textContent = '';
            toast.className = 'toast';

            const mode = document.querySelector('input[name="addAccountMode"]:checked')?.value || 'off';
            const allowedAccountIds = mode === 'specific'
                ? Array.from(document.querySelectorAll('.specific-user-checkbox:checked')).map(cb => cb.value)
                : [];

            try {
                await apiFetch('/api/feature-settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ addAccountAccess: { mode, allowedAccountIds } })
                });
                toast.textContent = 'Access setting saved.';
                toast.classList.add('ok');
            } catch (err) {
                toast.textContent = err.message;
                toast.classList.add('err');
            }
        });

        // Reuse a stored admin passcode for this tab session, if present.
        function init() {
            const stored = sessionStorage.getItem('drivesync_admin_passcode');
            if (stored && isSameTabSession()) {
                ADMIN_PASSCODE = stored;
                loadAccounts()
                    .then(() => {
                        gate.style.display = 'none';
                        app.classList.add('show');
                        replaceAdminNavState();
                    })
                    .catch(() => {
                        ADMIN_PASSCODE = '';
                        sessionStorage.removeItem('drivesync_admin_passcode');
                        gate.style.display = 'flex';
                    });
            } else if (stored) {
                // Stale sessionStorage from a reopened/restored tab — clear it
                // and require the passcode again.
                sessionStorage.removeItem('drivesync_admin_passcode');
                gate.style.display = 'flex';
            }
        }

        window.onload = () => {
            init();
        };


        // window.onload above already registers init() to run once when the
        // page's load event fires. Only call it manually here if that event
        // has ALREADY passed — calling it unconditionally runs init() twice.
        if (document.readyState === 'complete' && typeof window.onload === 'function') {
            window.onload();
        }

        // --- exposed for inline HTML event handlers ---
        window.switchView = switchView;
        window.toggleSidebar = toggleSidebar;
        window.closeSidebar = closeSidebar;
}

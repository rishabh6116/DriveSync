# Google sign-in + Drive setup

DriveSync lets people **sign up with email + password or with Google**, and connect
their own Google Drive with one tap. No Apps Script and no folder ID are needed.

You do this setup **once** (you, the site owner). Users never see any of it.

## How it works

1. A user signs in (email/password or **Continue with Google**).
2. If their Drive is not connected, the dashboard shows **Connect Google Drive**.
3. Google asks them to allow DriveSync. The scope is `drive`, so files a user adds to the
   *DriveSync* folder directly from drive.google.com also show up in the dashboard.
4. The server creates a folder called **DriveSync** in their Drive and stores the
   (encrypted) refresh token on their account.
5. The browser asks `/api/me?drive=token` for a short-lived access token and talks to
   the Drive API directly (`src/lib/driveBridge.js`). Large uploads therefore never go
   through Vercel's 4.5 MB request limit.

Accounts created with Google start **without a password**. After signing in they can set
one in **Edit Profile**, and from then on both ways work (same account, same email).
If someone already has an email/password account and later taps *Continue with Google*
with the same (verified) email, the two are linked automatically.

## 1. Create the OAuth client (Google Cloud Console)

1. Open <https://console.cloud.google.com/> and create a project (e.g. "DriveSync").
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding/Audience):
   - App name, support email, logo.
   - Authorized domain: your site's domain (e.g. `vercel.app` is not allowed on its own,
     use your own domain if you have one; for testing you can skip it).
   - Privacy policy link (required before publishing).
4. **Data access / Scopes → Add:** `openid`, `.../auth/userinfo.email`,
   `.../auth/userinfo.profile`, and `.../auth/drive` (a *restricted* scope).
5. **Clients → Create client → Web application**
   - **Authorized redirect URI:** `https://YOUR-DOMAIN/api/google`
     (for local testing also `http://localhost:3000/api/google`)
   - Copy the **Client ID** and **Client secret**.

## 2. Environment variables (Vercel → Settings → Environment Variables)

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from step 1 |
| `GOOGLE_CLIENT_SECRET` | from step 1 |
| `APP_URL` | optional, e.g. `https://your-domain.com` (must match the redirect URI origin) |
| `TOKEN_ENC_KEY` | optional, a long random string used to encrypt stored refresh tokens (defaults to `SESSION_SECRET`) |

`MONGODB_URI`, `MONGODB_DB`, `ADMIN_PASSCODE`, `SESSION_SECRET` stay as before.
Redeploy after changing variables. Until both Google values are set, the
"Continue with Google" buttons stay hidden and everything else works as before.

## 3. Testing vs. Production (important)

| Publishing status | What happens |
|---|---|
| **Testing** | No review. Only users you add under *Test users* (max 100) can sign in, and Google expires their refresh token after **7 days** (they must reconnect weekly). Fine for you and friends. |
| **In production** | `drive` is a restricted scope, so Google requires full verification plus a security assessment before the 100-user cap is lifted. Tokens no longer expire after 7 days once approved. |

## 4. Good to know

- **Existing users must reconnect once.** Accounts connected with the old `drive.file` scope get a *Connect Google Drive* prompt the next time they open the dashboard; after allowing it, files added by hand to the *DriveSync* folder appear.
- Files added by hand are not "anyone with the link", so image/PDF preview inside the dashboard may be blank for them; *Open in Drive* still works.
- Uploaded files are set to "anyone with the link can view", like the old Apps Script
  version, so image/PDF previews work. Some Google Workspace domains block this; the
  upload still succeeds.
- A user can disconnect Drive from **Edit Profile** (the token is revoked at Google), or
  remove access in their Google Account settings. DriveSync then asks them to connect again.
- **Older accounts that still use an Apps Script URL keep working unchanged.** They show the
  old Apps Script URL / folder fields in Edit Profile. `backend/Code.gs` is only needed for them.
- Vercel's Hobby plan allows 12 serverless functions. This project uses exactly 12
  (`api/google.js` handles all Google routes; `api/me.js` also serves Drive tokens and
  profile edits; the old `api/config.js` moved to `lib/config.js`).

## 5. Tests

`npm test` runs the automated tests (server flows with an in-memory database and a mocked
Google, and the Drive bridge with a mocked Drive API). They need no internet or keys.

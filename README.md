# DriveSync

DriveSync is a multi-account personal drive/dashboard app. Users sign in with an **email and password**, and each account is actually backed by its own Google Drive folder, connected through a small Apps Script bridge rather than any central file storage. It's built as a React SPA on Vercel serverless functions, with MongoDB Atlas storing accounts and settings.

## What it does

- **Email + password login** — Accounts are looked up by email; passwords are stored only as scrypt hashes (never plaintext). A successful login returns a signed session token that the browser keeps for the tab session (optionally persisted by the admin's "stay logged in" setting). Accounts come from two sources: accounts hardcoded in `api/config.js` and accounts added dynamically at runtime.
- **Bring-your-own Drive storage** — DriveSync doesn't host files itself. Each account points at a Google Apps Script web app deployed on someone's own Google Drive, which exposes their chosen folder (list, upload, create folder, delete).
- **Dynamic accounts** — New accounts can be added two ways:
  - By an **admin**, through the Admin panel's "Existing Accounts" view.
  - By **users themselves**, via a self-service "Add Account" link — but only if the admin has turned this on (globally, for all users, or for specific users) from the Feature Access settings.
- **Self password change** — A logged-in user can change their own password (and script URL) from inside the app.
- **Admin panel** — A separate area protected by the admin passcode (unchanged) for:
  - Managing accounts (view/add/remove, each tied to a Drive folder ID + Apps Script macro URL)
  - Controlling the "Add Account" self-service feature (off / all users / specific users)
  - Managing app theme/appearance
- **MongoDB as backend storage** — Accounts and admin/feature settings live in MongoDB Atlas (`accounts` and `settings` collections). A unique index on `email` prevents duplicate accounts, and writes touch a single document instead of rewriting a whole file.
- **Install prompt** — A one-time "Install App" banner appears on mobile browsers (Android via the native install prompt, iOS via manual "Add to Home Screen" instructions), so the app can be used like a PWA.


## Tech Stack

- **Frontend:** React 19, React Router, Vite
- **Backend:** Vercel serverless functions (`/api`)
- **Database:** MongoDB Atlas (official `mongodb` driver)

## Project Structure

```
drivesync/
├── api/                    # Vercel serverless functions
│   ├── auth.js               # Email + password login → signed session token
│   ├── me.js                  # Session check (used to restore persisted logins)
│   ├── account-password.js    # Self password / script URL change
│   ├── self-add-account.js    # User self-service account creation
│   ├── admin-accounts.js      # Admin: manage accounts
│   ├── admin-passcode.js      # Admin: change the admin panel passcode
│   └── feature-settings.js    # Admin: "Add Account" visibility toggle
├── lib/                    # db.js (Mongo connection), accounts.js, settings.js, passwords.js, session.js, adminAuth.js, featureSettings.js
├── scripts/hash-password.mjs # Generate a passwordHash for STATIC_ACCOUNTS
├── src/
│   ├── components/            # Shared React components (e.g. install prompt)
│   ├── pages/                 # App pages — Index (main dashboard), Admin, Theme
│   └── styles/                # Page-level CSS
├── public/                  # Static assets, icons, favicons, PWA manifest
└── vercel.json               # Vercel deployment config
```

## Getting Started

```bash
npm install
npm run dev        # start local dev server
npm run build       # production build
npm run preview      # preview production build
```

## Environment Variables

Copy `.env.example` to `.env` and fill it in (and add the same variables in Vercel → Settings → Environment Variables):

| Variable | What it is |
|---|---|
| `MONGODB_URI` | Atlas connection string |
| `MONGODB_DB` | Database name (default `drivesync`) |
| `ADMIN_PASSCODE` | First-time admin panel passcode. Once changed from inside the panel, only its hash is stored in MongoDB |
| `SESSION_SECRET` | Long random string used to sign login tokens |
| `APP_URL` | Public site URL used in password-reset email links, e.g. `https://mydockerr.vercel.app` (no trailing slash) |

## First-time setup

1. Create a free MongoDB Atlas cluster (pick Mumbai / `ap-south-1` if your users are in India; `vercel.json` already sets the Vercel function region to `bom1` — change or remove it if your cluster is elsewhere). Create a database user and, under **Network Access**, allow `0.0.0.0/0` (Vercel's IPs aren't fixed).
2. Set the env vars above locally and on Vercel.
3. Open `/adminaccount`, enter `ADMIN_PASSCODE`, and add your first account (email, password, Apps Script URL, Drive folder ID). Indexes are created automatically on first use.

## Authentication notes

- **Passwords:** no length or complexity rules (any non-empty string), hashed with scrypt (`lib/passwords.js`). Emails are stored lowercase and must be unique.
- **Sessions:** `POST /api/auth` returns a token (valid 30 days) that the client sends as `Authorization: Bearer <token>`. Tokens stop working when the account is deleted or its password changes.
- **Hardcoded accounts:** run `node scripts/hash-password.mjs "password"` and put the output in `STATIC_ACCOUNTS` as `passwordHash` (with an `email`).
- **Not included:** "forgot password" / email verification (needs an email provider).

## License

Private project — not licensed for redistribution.

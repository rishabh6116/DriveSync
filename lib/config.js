// All sensitive values come from environment variables (see .env.example).
// Never hardcode real credentials here — this file is safe to commit.

// MongoDB Atlas connection string + database name.
export const MONGODB_URI = process.env.MONGODB_URI || "";
export const MONGODB_DB = process.env.MONGODB_DB || "drivesync";

// First-time admin passcode for /adminaccount. After the admin changes it from
// inside the admin panel, only a hash of the new one is stored in MongoDB and
// this value is no longer used.
export const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "";

// Secret used to sign login session tokens. Use a long random string
// (e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
export const SESSION_SECRET = process.env.SESSION_SECRET || "";

// Optional hardcoded accounts. Generate the hash with:
//   node scripts/hash-password.mjs "the password"
export const STATIC_ACCOUNTS = [
  // {
  //   label: "Main Drive",
  //   email: "you@example.com",
  //   passwordHash: "scrypt$16384$8$1$...",
  //   macroUrl: "https://script.google.com/macros/s/.../exec",
  //   rootFolderId: "...",
  // },
];

// ---------------------------------------------------------------------------
// Google sign-in + Drive API (see docs/GOOGLE_SETUP.md)
// ---------------------------------------------------------------------------

// OAuth client created in Google Cloud Console (type: Web application).
// While these two are empty the "Continue with Google" buttons stay hidden.
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

// Optional: the public https URL of the site (e.g. https://drivesync.vercel.app).
// If empty it is worked out from the request. It must match the redirect URI
// registered in Google Cloud Console: <APP_URL>/api/google
export const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");

// Optional: key used to encrypt each user's Google refresh token before it is
// stored in MongoDB. Falls back to SESSION_SECRET when empty.
export const TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY || "";

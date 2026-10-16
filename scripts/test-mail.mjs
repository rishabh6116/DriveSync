// Quick SMTP check, runs outside vercel dev:
//   node scripts/test-mail.mjs you@example.com
// Reads SMTP_* values from .env in the project root.

import { readFileSync } from 'fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) process.env[m[1]] ??= m[2];
}

const { sendMail } = await import('../lib/mailer.js');
const to = process.argv[2] || process.env.SMTP_USER;
try {
    await sendMail({ to, subject: 'DriveSync test', text: 'SMTP works.' });
    console.log('Sent OK to', to);
} catch (err) {
    console.error('FAILED:', err.code || '', err.message);
}

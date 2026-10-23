// Usage: node scripts/hash-password.mjs "my password"
// Prints a hash you can paste into STATIC_ACCOUNTS (api/config.js) as passwordHash.
import { hashPassword } from '../lib/passwords.js';

const pw = process.argv[2];
if (!pw) {
    console.error('Usage: node scripts/hash-password.mjs "your password"');
    process.exit(1);
}
console.log(await hashPassword(pw));

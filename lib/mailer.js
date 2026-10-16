// lib/mailer.js
//
// Sends email over SMTP with nodemailer. Configure with environment variables:
//   SMTP_HOST, SMTP_PORT (465 = SSL, 587 = STARTTLS), SMTP_USER, SMTP_PASS
//   MAIL_FROM  (optional, defaults to SMTP_USER), e.g. "DriveSync <you@gmail.com>"
// For Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=465 or 587, SMTP_PASS = an App Password.

import nodemailer from 'nodemailer';

let transporter = null;

export function mailConfigured() {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
    if (!transporter) {
        const port = Number(process.env.SMTP_PORT || 465);
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port,
            secure: port === 465,
            requireTLS: port !== 465,
            auth: { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS).replace(/\s+/g, '') },
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 15000
        });
        // A dropped socket must never become an unhandled error that kills the server.
        transporter.on('error', (err) => console.error('SMTP transporter error:', err.message));
    }
    return transporter;
}

export async function sendMail({ to, subject, text, html }) {
    if (!mailConfigured()) throw new Error('Email is not configured on the server (SMTP_HOST, SMTP_USER, SMTP_PASS).');
    try {
        await getTransporter().sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to, subject, text, html
        });
    } catch (err) {
        transporter = null; // rebuild the connection next time
        throw err;
    }
}

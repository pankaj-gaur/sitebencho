'use strict';
/**
 * Keycard setup for Miti. All Miti-specific sign-in settings live here;
 * server.js only needs: const auth = require('./auth');
 *
 * Settings come from .env (see .env.example).
 */
const path = require('path');
const { createKeycard, sqliteStore, consoleMailer, smtpMailer } = require('keycard');

const useSmtp = !!process.env.SMTP_HOST;

const auth = createKeycard({
  appName: 'Miti',
  appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`,
  secret: process.env.AUTH_SECRET,
  store: sqliteStore({ filename: path.join(__dirname, 'data', 'auth.db') }),
  mailer: useSmtp
    ? smtpMailer({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.SMTP_FROM,
      })
    : consoleMailer(), // no SMTP configured: sign-in codes print in this terminal
  adminEmails: process.env.ADMIN_EMAILS,

  // Starting access mode. Only admins and allowlisted emails can sign in until
  // Miti's per-user isolation is finished. Change it later in /auth/admin → Access settings.
  access: { modes: ['allowlist'], contactUrl: process.env.CONTACT_URL || '' },

  // Limits for anyone signed in without a licence (e.g. admins). Same as Miti today.
  defaultEntitlements: { maxPages: 200, runsKept: 30, aiSummary: true },
});

// Created once on first start. Later edits in the admin panel are kept.
auth.ensurePlans([
  { name: 'Trial',    entitlements: { maxPages: 50,  runsKept: 10,  aiSummary: false }, defaultDays: 14,  defaultGraceDays: 0 },
  { name: 'Standard', entitlements: { maxPages: 200, runsKept: 30,  aiSummary: true },  defaultDays: 365, defaultGraceDays: 7 },
  { name: 'Pro',      entitlements: { maxPages: 500, runsKept: 100, aiSummary: true },  defaultDays: 365, defaultGraceDays: 7 },
]);

module.exports = auth;

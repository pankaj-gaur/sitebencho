#!/usr/bin/env node
/**
 * One-off: moves history and Daily Snapshots saved BEFORE sign-in existed
 * into one person's account (normally yours).
 *
 *   npm run migrate -- you@yourcompany.com            do it
 *   npm run migrate -- you@yourcompany.com --dry-run  only show what would move
 *
 * Stop Miti first. The person must have signed in at least once.
 * Safe to run twice: anything already moved is skipped.
 */
'use strict';
try { require('dotenv').config(); } catch (e) { /* optional */ }
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const email = (args.find((a) => !a.startsWith('--')) || '').trim().toLowerCase();

if (!email) {
  console.error('Usage: npm run migrate -- you@yourcompany.com [--dry-run]');
  process.exit(1);
}

const auth = require('../auth');
const user = auth.getUserByEmail(email);
if (!user) {
  console.error(`No account for ${email}. Start Miti, sign in once with that email, stop Miti, then run this again.`);
  auth.close();
  process.exit(1);
}

let moved = 0;
let skipped = 0;
function move(from, to) {
  if (fs.existsSync(to)) { skipped += 1; return; }
  console.log(`${dryRun ? 'would move' : 'moving'}  ${path.relative(ROOT, from)}  ->  ${path.relative(ROOT, to)}`);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
  moved += 1;
}

// ---- History: history/<type>/*.json -> history/<userId>/<type>/*.json
for (const type of ['diff', 'analysis']) {
  const legacy = path.join(ROOT, 'history', type);
  if (!fs.existsSync(legacy)) continue;
  for (const f of fs.readdirSync(legacy).filter((n) => n.endsWith('.json'))) {
    move(path.join(legacy, f), path.join(ROOT, 'history', user.id, type, f));
  }
  if (!dryRun && fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy);
}

// ---- Daily Snapshots: snapshots/{config.json,state.json,u-*} -> snapshots/users/<userId>/
const snapRoot = path.join(ROOT, 'snapshots');
const target = path.join(snapRoot, 'users', user.id);
if (fs.existsSync(path.join(snapRoot, 'config.json'))) {
  const existing = path.join(target, 'config.json');
  let hasOwn = false;
  try { hasOwn = JSON.parse(fs.readFileSync(existing, 'utf8')).urls.length > 0; } catch (e) { /* none yet */ }
  if (hasOwn) {
    console.warn(`Skipped Daily Snapshots: ${email} already has tracked pages set up after sign-in. Old setup left in snapshots/.`);
  } else {
    if (!dryRun && fs.existsSync(existing)) fs.unlinkSync(existing); // empty setup from after sign-in
    move(path.join(snapRoot, 'config.json'), existing);
    if (fs.existsSync(path.join(snapRoot, 'state.json'))) move(path.join(snapRoot, 'state.json'), path.join(target, 'state.json'));
    for (const d of fs.readdirSync(snapRoot).filter((n) => /^u-[a-z0-9]+-[a-z0-9]+$/.test(n))) {
      move(path.join(snapRoot, d), path.join(target, d));
    }
  }
}

console.log(`\n${dryRun ? 'Dry run: ' : ''}${moved} item(s) ${dryRun ? 'would be moved' : 'moved'} to ${email}${skipped ? `, ${skipped} already there` : ''}.`);
auth.close();

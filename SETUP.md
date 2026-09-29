# Miti: multi-user update

After this update, everyone who signs in has their own crawls, tests, scans,
AI summaries, History and Daily Snapshots. Nobody can see or affect anyone
else's work. Plans limit pages per crawl, saved runs, AI and snapshots.

About 20 minutes. Stop Miti before you start.

## What's in this package

| File | Put it in | Change |
|---|---|---|
| `server.js` | Miti root | Per-user workspaces, busy limit, plan limits, AI by plan |
| `history.js` | Miti root | History saved per user; only your own runs are visible |
| `snapshots.js` | Miti root | Daily Snapshots per user, with plan limits |
| `auth.js` | Miti root | Plans (Trial, Standard, Pro), Miti look on sign-in pages |
| `package.json` | Miti root | Keycard 1.1.1, `npm run migrate` |
| `scripts/migrate-to-user.js` | Miti `scripts/` (new folder) | Moves your old history and snapshots into your account |
| `public/js/main.js` | Miti `public/js/` | Account menu, sign-in redirect, page limit |
| `public/css/main.css` | Miti `public/css/` | Account menu styles |
| `public/js/snapshot.js` | Miti `public/js/` | Shows your plan's snapshot limits |
| `.env.example` | Miti root | Settings template (two new optional settings) |

`keycard-1.1.1.zip` (next to this folder) is the Keycard update.

## Steps

**1. Update Keycard on GitHub**

Unzip `keycard-1.1.1.zip` over your local copy of the keycard repo, then:
```
git add .
git commit -m "Keycard 1.1.1"
git tag v1.1.1
git push && git push --tags
```

**2. Back up Miti**

Commit your current Miti work, or copy the folder.

**3. Copy the files**
- Copy everything from `miti-multiuser/` into the Miti folder, replacing existing files.
- Delete `public/keycard-nav.js`. The account menu now lives in `main.js` and `main.css`.

**4. Install**
```
npm install
```
This picks up Keycard 1.1.1.

**5. Check `.env`**

`AUTH_SECRET` and `ADMIN_EMAILS` must be set. See `.env.example`. The two capacity settings are optional.

**6. Sign in once**
- Start Miti with `npm start`.
- Sign in with your admin email. The code prints in the terminal.
- Stop Miti.

**7. Move your old data into your account**
```
npm run migrate -- you@yourcompany.com --dry-run
npm run migrate -- you@yourcompany.com
```
The first command only lists what would move; the second moves it. It's safe to run twice.

**8. Start Miti and check**
- **History** shows your earlier runs.
- **Daily Snapshots** shows your tracked pages and past captures.
- The header has your email, **Admin** and **Sign out**.

**9. Keep data out of git.** Add to `.gitignore`:
```
.env
data/
history/
snapshots/
```

## Plans

Set up automatically; edit them in **Admin → Plans**.

| Plan | Pages per crawl | Saved runs per tool | AI summaries | Snapshot pages | Keep snapshots |
|---|---|---|---|---|---|
| Trial (14 days) | 50 | 10 | No | 2 | 30 days |
| Standard (1 year) | 200 | 30 | Yes | 10 | 400 days |
| Pro (1 year) | 500 | 100 | Yes | 50 | 730 days |
| No licence (e.g. admins) | 200 | 30 | Yes | 10 | 400 days |

To give yourself Pro limits, grant yourself a Pro licence in **Admin → Users**.

## Letting customers in

1. Fill in the `SMTP_` settings in `.env` and restart.
2. In **Admin → Access settings**, tick **Licence** and **Approval**.
3. Approve requests in **Admin → Access requests**, choosing **New personal licence** and a plan.

## Good to know

- **Busy limit:** up to 3 people can crawl, test or scan at the same time (`MAX_BUSY_USERS`). Anyone else gets "Miti is busy, try again in a few minutes". Loading pages from history is never blocked.
- **Snapshot schedule:** each person's pages are captured at their own chosen time. Captures stop automatically when their licence ends.
- **Lowered plans:** if a plan is lowered, snapshot captures continue for the first pages up to the new limit. Older screenshots beyond the new "keep for" limit are removed at the next capture.
- **Memory:** work in progress is kept in memory. It's cleared after a restart, or 12 hours after someone's last activity. Saved History and snapshots are on disk and aren't affected.

## If something goes wrong

| Problem | Fix |
|---|---|
| `No account for …` when migrating | Sign in once with that email first (step 6). |
| History is empty after migrating | Check you migrated to the same email you signed in with. Old files are in `history/<your-id>/`. |
| `Skipped Daily Snapshots: … already has tracked pages` | You set up snapshots after sign-in. The old setup is left in `snapshots/`. Remove the new setup and run the migration again, or keep the new one. |
| `Cannot find module 'keycard'` or plans ignore limits | Run `npm install` and check `npm ls keycard` shows 1.1.1. |
| "Miti is busy…" too often | Raise `MAX_BUSY_USERS` in `.env` if the server has memory to spare. |

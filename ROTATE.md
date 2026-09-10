# Rotating the exposed Apps Script credentials

Two secrets were committed to this repository, which is public:

| Secret | Where | Public since |
|---|---|---|
| `API_TOKEN` — `mf_TNzQ…utDJ` | `assets/js/admin.js:8`, `order.js:8` | 3 Sept 2026 |
| `SETUP_KEY` — `6a9812e5…c322` | `apps-script/Config.gs:8` | earlier |

**Removing them from the code does not un-expose them.** They are in the git
history and have been readable by anyone for as long as they were there. They
have to be changed in the Apps Script project, which is the only place that
decides what the backend accepts.

## What each one actually reaches

`API_TOKEN` alone does not get an attacker into the console — every admin
action additionally needs a staff session or `ADMIN_PASS`, and the sheet-sync
hooks have their own push keys. What it does give is unmetered access to
`staffLogin`, which has **no rate limit and no lockout** in the Apps Script
build. That is a password-guessing oracle against every staff account, running
against a public URL.

`SETUP_KEY` re-runs `setup_`, but once installed that also requires
`ADMIN_PASS`, so on its own it does nothing. Rotate it anyway; it costs a line.

## Rotate

1. Open the Apps Script project → **Project Settings → Script properties**.
2. Edit `API_TOKEN`. Any long random value: `openssl rand -hex 24`, prefixed
   `mf_` by convention.
3. Save. The old token stops working immediately — anything still sending it
   gets `Bad token`, which is the point.
4. In `apps-script/Config.gs`, replace `SETUP_KEY` with a fresh value, or blank
   it entirely: setup has already run and does not need to run again.

## Then put the new token into the console

The published console at `rogerdf30.github.io/merchforce-ops/` still talks to
Apps Script and still needs a token until cutover. Set it **without committing
it** — the frontend now reads `window.MF_API_TOKEN` if a deployment provides
one, so create `assets/js/config.js` (already git-ignored):

```js
window.MF_API_TOKEN = 'mf_<the new value>';
```

`wire-token.sh` used to do this by writing the token into `admin.js` and
pushing. That script has been deleted: its whole purpose was committing a
secret to a public repository, and it is why one was committed.

## After cutover, none of this applies

The new backend identifies a supplier by a **public slug**, not a secret. A
token that ships in a JavaScript bundle is not a token; the console now sends
`tenant: "acme"` and authorises nothing with it. Signing in is bcrypt behind a
per-IP and per-account rate limit, and a customer's order page is authorised by
that order's own token.

So this is the last time a credential needs to live in the frontend at all.

## Worth checking

Look at the Apps Script execution log and the `AuditLog` tab for
`login_fail` rows between 3 Sept and the rotation. A burst against one address
is what a dictionary attack looks like. Nothing may have happened — but the
window was open, and the log is the only place it would show.

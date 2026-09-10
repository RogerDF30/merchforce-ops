# Security

## Reporting

Email roger@companystore.io.

## Credentials

No credential belongs in this repository. The console names its supplier with a
public slug and authorises nothing with it; every admin action requires a staff
session, and a customer's order page is authorised by that order's own token.

Anything a deployment needs to keep secret goes in the environment, or in an
untracked `assets/js/config.js` for the browser. `.env` and that file are
git-ignored. There is no script here that writes a secret into a tracked file.

## Known history

An earlier build committed backend credentials to this repository before the
current design. They are being rotated; rotation instructions are held outside
the repository rather than published here.

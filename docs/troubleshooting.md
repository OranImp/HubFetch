# Troubleshooting

Common issues and how to resolve them. If a problem persists, gather a support bundle and report it
on [GitHub Issues](https://github.com/OranImp/HubFetch/issues).

## SmartScreen warning on first launch

Release ZIPs are **unsigned**. Windows SmartScreen may warn when you run `HubFetch.exe` the first
time. Choose **More info → Run anyway**, and verify the ZIP against its published SHA-256 checksum.
See [signing.md](signing.md).

## "Git not found" / clone does not start

Clones require **system Git** on `PATH`. If a repo uses Git-Xet filters, **Git-Xet** must also be
installed and on `PATH`.

1. Open the **Diagnostics** page and check the Git and Git-Xet readiness rows.
2. Install Git (and Git-Xet if needed), then restart HubFetch.
3. The clone now reports a clear readiness result instead of failing at startup.

## Clone fails with an authentication error

Git clones authenticate through system Git (Git Credential Manager / SSH) or through the app-token
AskPass helper.

- If you use **Git Credential Manager / SSH**, make sure your credentials are configured for the
  target host as you would for a normal `git clone`.
- If you use an **app-token** clone, confirm the token has the needed permissions for the repo and
  that you are signed in with the correct account.

## Proxy connection failure

If downloads, clones, or browsing fail with a network error:

1. Check **Settings → Network** proxy mode.
   - **System** inherits your OS proxy; if that proxy is unreachable, switch to **Direct** or
     **Manual**.
   - **Manual** requires a valid HTTP/HTTPS proxy URL (it is validated before it is applied).
   - **Direct** bypasses all proxies.
2. Use **Diagnostics → Test connection** to probe the endpoint under the applied proxy.

Because each transfer snapshots its proxy selection at creation time, changing the proxy affects new
tasks; an in-flight task keeps the proxy it started with.

## Notifications do not appear

- Confirm notifications are enabled under **Settings**.
- On Windows, HubFetch registers its notification mechanism; if Windows notifications are disabled
  for the app, re-enable them in Windows Settings.

## App state was lost or a transfer was interrupted

Clone state persists in SQLite and is **recovered on restart**: an abandoned `running`/`cancelling`
clone becomes `interrupted` and can be resumed. Downloads are resumable in the standard HF cache
layout. If a task is stuck, cancel it and start it again.

## Collecting a support bundle

1. Open the **Diagnostics** page.
2. Select **Export support bundle** and choose a destination.
3. Attach the resulting ZIP to your issue. The bundle is sanitized: secrets are redacted centrally,
   and the export fails closed if any registered secret leaks in.

## Data and privacy

Your token and Hub web session are encrypted at rest. Browsing history, favorites, follows, download
tasks, and clone state are local. To remove everything, use **Settings → Clear local data** and sign
out, or delete `%APPDATA%\HubFetch\credentials.json` to sign out everywhere.

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

1. Open **Settings → Clone tools** and check the Git and Git-Xet readiness rows.
2. Install Git (and Git-Xet if needed) from the official download pages the rows link to, then
   press **Recheck**.
3. If a tool is still reported missing after Recheck, **restart HubFetch** so it picks up the
   updated `PATH`.
4. The clone now reports a clear readiness result instead of failing at startup.

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

## Hub capability compatibility

The Diagnostics page shows local capability knowledge for model browsing, downloads, posts, profile
settings, watching, and the datasets viewer independently. A posts, profile, or watch compatibility
failure does not make model browsing or downloads unavailable.

Capability statuses are read from the local registry and current sign-in/session state without a
background request. Use **Probe** on one capability when you explicitly want to test it; that probe
uses the active proxy and returns only a closed status, source class, capability key, and check time.
No response body, request headers, URL query, token, or cookie is shown.

- **Session required**: connect the Hub web session under **Settings → Account**.
- **Unauthorized**: check the token account and permissions under **Settings → Account**.
- **Forbidden**: a 403 is kept distinct from session expiry; open the safe Hub page to check access,
  region, or proxy policy.
- **Rate limited**, **network**, or **upstream changed**: retry the affected capability only.

## Space administration

Space runtime and lifecycle controls need a token with repository-administration rights on that
Space (owner or collaborator).

- **"Forbidden" / 403 when loading the runtime**: the signed-in account is not an owner or
  collaborator of the Space, or the token lacks the manage-repos scope. Check
  **Settings → Account**.
- **"Invalid request" / 400 on Pause**: the Space may already be paused or not yet have an app
  file. Refresh the status; resume uses the normal restart path.
- **Hardware change fails with 400/409**: the Space may be mid-build or already transitioning to
  the requested flavor. Refresh the runtime panel — a pending switch appears as "Requested
  hardware" — and retry after the current transition settles.
- **Status never updates after an action**: the runtime panel polls for a bounded window (about
  half a minute) and then stops. Press the refresh button to fetch the current state; Hub rebuilds
  can take several minutes.
- **Custom sleep time is disabled**: on the free `cpu-basic` tier the Hub manages the sleep window
  automatically and reports none. The app displays "Hub-managed automatic sleep" instead of
  guessing a duration. Custom and never-sleep values are only sent for hardware where the official
  API accepts them.
- **Malformed status response**: if the Hub returns a runtime payload without its stage field, the
  panel shows the raw error instead of a fake state; retry later or check the Hub status page.
- The app never shows Space prices or cost estimates. Upgraded-hardware actions warn that billing
  may start immediately; check the Hub website for actual pricing.

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

# Security Policy

## Supported versions

Security fixes are provided for the latest published version of HubFetch. Please update to the
newest release before reporting an issue that may already be resolved.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability
reporting feature on this repository's **Security** tab. Include the affected version, operating
system, reproduction steps, impact, and any suggested mitigation.

We aim to acknowledge a report within five business days. We will coordinate validation, a fix, and
disclosure timing with the reporter. Please avoid accessing data that is not yours, disrupting Hub
services, or publishing details before a fix is available.

## Release security controls

CI audits production dependencies for high and critical advisories and runs CodeQL. Release jobs
build the **Windows x64 ZIP** with publishing disabled, smoke-test the packaged application, and
verify SHA-256 checksums plus the remote asset inventory before the only write-enabled job can
create a tag or GitHub Release. The application has no self-update capability, so there are no
updater manifests to validate.

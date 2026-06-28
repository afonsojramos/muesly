# Google Calendar OAuth setup

muesly connects Google Calendar as an optional, read-only calendar source. The
app needs a Google OAuth **Desktop** client id. For a distributed desktop app the
client "secret" is not actually secret (it ships in the binary); PKCE is the real
protection.

## Dev setup (Testing mode, ~5 min)

1. **Project + API**: [console.cloud.google.com](https://console.cloud.google.com)
   → create/select a project → **APIs & Services → Library → "Google Calendar API"
   → Enable**.
2. **OAuth consent screen** (APIs & Services → OAuth consent / "Google Auth
   Platform"):
   - User type: **External**.
   - App name, support email, developer email.
   - **Scopes**: add `https://www.googleapis.com/auth/calendar.events.readonly`
     plus `openid` and `email`. (events.readonly is *sensitive*, not *restricted*
     - no CASA, no fee.)
   - **Test users**: add your own Google account (keeps you in Testing mode).
3. **Credentials → Create credentials → OAuth client ID → Application type:
   Desktop app** → Create. Copy the **Client ID** and **Client secret**.
   - No redirect URI to register: Desktop clients accept
     `http://127.0.0.1:<any-port>` (loopback) automatically.
4. **Provide credentials to muesly** via env vars (read at runtime):
   ```sh
   export MUESLY_GOOGLE_CLIENT_ID="…apps.googleusercontent.com"
   export MUESLY_GOOGLE_CLIENT_SECRET="…"
   ```
   Then run `pnpm tauri:dev` (or a bundled build - the macOS consent prompt only
   attaches correctly to a bundled build, same TCC caveat as the audio/calendar
   permissions).

## Testing-mode caveats

- Refresh tokens **expire ~every 7 days** in Testing mode, and there is a
  **100-user cap**. Users will be asked to reconnect about weekly. The app shows
  an honest "in review, reconnect ~weekly" notice during this period.
- This is why public release is gated on verification (below).

## Public-release prerequisites (one-time, free, ~10 business days)

Before moving the consent screen to **In production** (required for real users):

1. muesly.ai serves a **login-free privacy policy on the same domain** that
   includes the verbatim Google API Services **Limited Use** statement and a
   "Google Calendar connection" section (read-only scope, device-only handling,
   no human review / no training / no sale, how to disconnect).
2. **Domain ownership** verified in Google Search Console (same Google account).
3. An **unlisted demo video** showing the consent grant, the app name on the
   consent screen, the client id in the address bar, and the scope in use.
4. Submit verification and move to **In production**.

Keep the scope set minimal forever (`openid email calendar.events.readonly`).
Adding any Gmail/Drive/Photos/Fit/Chat scope moves you into *restricted* territory
and a recurring CASA security assessment.

## How the app uses it

- Loopback (`http://127.0.0.1:<ephemeral>`) + PKCE (S256) + system browser.
- Identity (`sub`, email) resolved via the userinfo endpoint over TLS.
- Refresh token stored in the OS keychain (`service "muesly"`, key
  `google-oauth-<sub>`), never in SQLite. Only the account email (a label) and
  non-secret metadata live in the DB.
- Read-only `calendarList.list` + `events.list`; attendee emails are never stored
  or sent anywhere.

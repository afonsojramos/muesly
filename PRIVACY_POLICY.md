# muesly Privacy Policy

*Last updated: 2026-06-18*

## Our Privacy Commitment

muesly is built on a simple principle: everything you say stays yours. It captures, transcribes, and summarizes your speech entirely on your own device. This policy explains exactly how your data is handled in this source-available app.

## Local-First Processing

- **Transcription**: runs entirely on your device using local Whisper or Parakeet models
- **Recordings**: your audio is never transmitted to external servers
- **Transcripts and notes**: stored in a local database on your device
- **Summaries**: generated locally by default, or through a cloud LLM provider you explicitly configure

You own all of your recordings, transcripts, and summaries. You can view, export, or delete them at any time, and there is no vendor lock-in.

## Usage Analytics

Official builds include optional anonymized usage analytics (via PostHog) to help us find bugs and improve performance. Analytics is disabled by default until you opt in, you can change that choice at any time in the app settings, and builds compiled without a PostHog key have analytics disabled entirely.

**What we collect:**

- Feature usage and session patterns
- Performance metrics (transcription success rates, processing times, error frequencies)
- Application version and platform information
- Anonymized error logs and crash reports

**What we never collect:**

- Your recordings, audio, transcripts, or notes
- Recording titles, file names, or participant information
- Personal or identifiable data
- LLM conversations or AI-generated content

**Implementation:**

- All data is linked to a randomly generated ID only, with no personal identification
- Data is retained for a maximum of 12 months, then automatically deleted
- Data is encrypted in transit
- Access is limited to core maintainers
- The full analytics implementation is public source code, available for review

## Cloud LLM Providers (Optional)

Summaries are generated locally by default. If you configure a cloud provider (Anthropic Claude, OpenAI, Groq, xAI Grok, OpenRouter, or a custom OpenAI-compatible endpoint), the transcript being summarized is sent to that provider and is subject to its own privacy policy. The built-in local model and Ollama run on infrastructure you control (on your device, or a server you point Ollama at) and send nothing to muesly or its maintainers.

If you enable calendar context, the matched meeting's title, time, and location are included in the summary. For cloud providers, attendee and organizer names and the meeting's agenda/notes are withheld by default and only sent if you explicitly opt in (per-type toggles in Settings → Calendar), the conference link is never sent, and attendee email addresses are never stored or sent. Local providers receive the full meeting context.

## Google Calendar Connection (Optional)

Calendar context works with your Mac's local calendars by default. You may also optionally connect one or more Google accounts (Settings → Calendar → Add Google account). This is off until you connect an account.

- **Scopes (read-only, minimal):** muesly requests `calendar.calendarlist.readonly` to list the calendars you subscribe to so you can choose which calendars to use, and `calendar.events.readonly` to read events from those selected calendars for upcoming-meeting display, recording matching, optional automatic recording, and meeting context. It also requests `openid`/`email` to identify the connected account. These permissions cannot create, edit, or delete anything, and muesly never accesses your Gmail, Drive, or contacts.
- **Where it goes:** events are fetched directly between your device and Google. muesly has no server; nothing is routed through or stored by muesly's maintainers.
- **What is stored, and where:** events are stored only on your device. The connected account's email is stored locally as a label. The OAuth refresh token is stored in your operating system keychain, never in the app database. Attendee email addresses are never stored.
- **No human review, no training, no sale:** calendar data is used only to provide the in-app meeting-context feature.
- **Revoke anytime:** "Remove" in Settings → Calendar deletes the token from your keychain and revokes it with Google; you can also revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

muesly's use of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Data Security

- Your data never leaves your device unless you configure a cloud LLM provider
- Local data is protected by your operating system's file permissions and disk encryption (when enabled)
- Full source code is available for security review, with no hidden data collection or tracking

## Changes to This Policy

Material changes are announced through updates to this document in the GitHub repository, release notes, and in-app notifications for significant privacy changes.

## Contact

For privacy-related questions or concerns, [create an issue](https://github.com/afonsojramos/muesly/issues).

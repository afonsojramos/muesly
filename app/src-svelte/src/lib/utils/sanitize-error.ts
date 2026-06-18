/**
 * Redact filesystem paths from a string before it is sent to analytics.
 * Import/transcription error messages can embed paths like
 * /Users/alice/secret.wav; PRIVACY_POLICY.md says file names are never collected.
 * Replaces path-like runs with <path>, preserving the rest of the message.
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/[A-Za-z]:\\[^\s'"]*/g, '<path>')        // Windows: C:\Users\...
    .replace(/~[/\\][^\s'"]*/g, '<path>')             // home-relative: ~/...
    .replace(/\/[^\s/]+(?:\/[^\s/]*)+/g, '<path>');   // POSIX absolute: /a/b...
}

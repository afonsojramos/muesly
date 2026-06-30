import type { HandleClientError } from '@sveltejs/kit';
import { Analytics } from '$lib/analytics';

/**
 * SvelteKit client error hook: forwards errors thrown during load/render/
 * navigation to PostHog error tracking. No-op unless the user has opted into
 * analytics (Analytics.trackException guards on initialization).
 */
export const handleError: HandleClientError = ({ error }) => {
  void Analytics.trackException(error, { handled: false, source: 'frontend' });
  return { message: 'An unexpected error occurred.' };
};

// Catch errors that escape the SvelteKit lifecycle (DOM event handlers, timers,
// rejected promises). Registered once, when this module is first imported.
if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    void Analytics.trackException(event.error ?? event.message, {
      handled: false,
      source: 'frontend',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    void Analytics.trackException(event.reason, { handled: false, source: 'frontend' });
  });
}

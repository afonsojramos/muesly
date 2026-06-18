/**
 * Aggregate auto-save status for the meeting detail view.
 *
 * The title, summary, and notes surfaces each call `begin()` / `end()` around
 * their saves; the toolbar renders a subtle "Saving…/Saved" indicator from
 * `state`. Lives above the per-meeting view (a module singleton) so it survives
 * the `{#key meeting.id}` remount; `reset()` is called when a new meeting mounts
 * so a prior "Saved" flash doesn't linger.
 */
type Status = 'idle' | 'saving' | 'saved';

const SAVED_FLASH_MS = 2000;

class SaveStatus {
	#inFlight = $state(0);
	#savedFlash = $state(false);
	#timer: ReturnType<typeof setTimeout> | null = null;

	get state(): Status {
		if (this.#inFlight > 0) return 'saving';
		if (this.#savedFlash) return 'saved';
		return 'idle';
	}

	begin = (): void => {
		this.#inFlight++;
		this.#savedFlash = false;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	};

	end = (ok: boolean): void => {
		this.#inFlight = Math.max(0, this.#inFlight - 1);
		if (ok && this.#inFlight === 0) {
			this.#savedFlash = true;
			if (this.#timer) clearTimeout(this.#timer);
			this.#timer = setTimeout(() => {
				this.#savedFlash = false;
				this.#timer = null;
			}, SAVED_FLASH_MS);
		}
	};

	reset = (): void => {
		this.#inFlight = 0;
		this.#savedFlash = false;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	};
}

export const saveStatus = new SaveStatus();

/**
 * Onboarding store.
 *
 * Drives the multi-step onboarding flow: model downloads (Parakeet + summary),
 * permissions, database initialization (with legacy auto-import), and persisted
 * status. Equivalent of the React OnboardingContext.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { OnboardingPermissions, PermissionStatus } from '$lib/types/onboarding';
import { toast } from '$lib/toast';

const PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3-int8';
const SAVE_DEBOUNCE_MS = 1000;

export interface ProgressInfo {
	percent: number;
	downloadedMb: number;
	totalMb: number;
	speedMbps: number;
}

interface OnboardingStatusBlob {
	version: string;
	completed: boolean;
	current_step: number;
	model_status: {
		parakeet: string;
		summary: string;
	};
	last_updated: string;
}

const emptyProgress = (): ProgressInfo => ({
	percent: 0,
	downloadedMb: 0,
	totalMb: 0,
	speedMbps: 0,
});

class OnboardingStore {
	currentStep = $state<number>(1);
	completed = $state<boolean>(false);
	/** True once persisted onboarding status has been loaded from the backend. */
	statusLoaded = $state<boolean>(false);

	parakeetDownloaded = $state<boolean>(false);
	parakeetProgress = $state<number>(0);
	parakeetProgressInfo = $state<ProgressInfo>(emptyProgress());

	summaryModelDownloaded = $state<boolean>(false);
	summaryModelProgress = $state<number>(0);
	summaryModelProgressInfo = $state<ProgressInfo>(emptyProgress());

	selectedSummaryModel = $state<string>('gemma3:1b');
	databaseExists = $state<boolean>(false);
	isBackgroundDownloading = $state<boolean>(false);

	permissions = $state<OnboardingPermissions>({
		microphone: 'not_determined',
		systemAudio: 'not_determined',
		screenRecording: 'not_determined',
	});
	permissionsSkipped = $state<boolean>(false);

	#saveTimer: ReturnType<typeof setTimeout> | null = null;
	#completing = false;
	#unsubscribers: UnlistenFn[] = [];
	#started = false;

	async start(): Promise<() => void> {
		if (this.#started) return () => this.#cleanup();
		this.#started = true;

		await Promise.allSettled([
			this.#loadOnboardingStatus(),
			this.#checkDatabaseStatus(),
			this.#initializeDatabaseInBackground(),
			this.#fetchRecommendedModel(),
		]);

		// Status has now been resolved (or failed) — safe for the layout to gate.
		this.statusLoaded = true;

		try {
			this.#unsubscribers.push(
				await listen<{
					modelName: string;
					progress: number;
					downloaded_mb?: number;
					total_mb?: number;
					speed_mbps?: number;
					status?: string;
				}>('parakeet-model-download-progress', (event) => {
					const p = event.payload;
					if (p.modelName !== PARAKEET_MODEL) return;
					this.parakeetProgress = p.progress;
					this.parakeetProgressInfo = {
						percent: p.progress,
						downloadedMb: p.downloaded_mb ?? 0,
						totalMb: p.total_mb ?? 0,
						speedMbps: p.speed_mbps ?? 0,
					};
					if (p.status === 'completed' || p.progress >= 100) {
						this.parakeetDownloaded = true;
					}
				}),
				await listen<{ modelName: string }>('parakeet-model-download-complete', (event) => {
					if (event.payload.modelName !== PARAKEET_MODEL) return;
					this.parakeetDownloaded = true;
					this.parakeetProgress = 100;
				}),
				await listen<{ modelName: string; error: string }>(
					'parakeet-model-download-error',
					(event) => {
						if (event.payload.modelName === PARAKEET_MODEL) {
							console.error('[OnboardingStore] Parakeet download error:', event.payload.error);
						}
					},
				),
				await listen<{
					model: string;
					progress: number;
					downloaded_mb?: number;
					total_mb?: number;
					speed_mbps?: number;
					status: string;
				}>('builtin-ai-download-progress', (event) => {
					const p = event.payload;
					if (
						p.model !== this.selectedSummaryModel &&
						p.model !== 'gemma3:1b' &&
						p.model !== 'gemma3:4b'
					)
						return;
					this.summaryModelProgress = p.progress;
					this.summaryModelProgressInfo = {
						percent: p.progress,
						downloadedMb: p.downloaded_mb ?? 0,
						totalMb: p.total_mb ?? 0,
						speedMbps: p.speed_mbps ?? 0,
					};
					if (p.status === 'completed' || p.progress >= 100) {
						this.summaryModelDownloaded = true;
					}
				}),
			);
		} catch (error) {
			console.error('[OnboardingStore] Failed to set up event listeners:', error);
		}

		return () => this.#cleanup();
	}

	/** Debounced persistence — call after meaningful state changes. */
	#scheduleSave(): void {
		if (this.#completing) return;
		if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => {
			void this.#saveOnboardingStatus();
		}, SAVE_DEBOUNCE_MS);
	}

	goToStep = (step: number): void => {
		this.currentStep = Math.max(1, Math.min(step, 4));
		this.#scheduleSave();
	};

	goNext = (): void => {
		this.currentStep = Math.min(this.currentStep + 1, 4);
		this.#scheduleSave();
	};

	goPrevious = (): void => {
		this.currentStep = Math.max(this.currentStep - 1, 1);
		this.#scheduleSave();
	};

	setParakeetDownloaded = (value: boolean): void => {
		this.parakeetDownloaded = value;
		this.#scheduleSave();
	};
	setSummaryModelDownloaded = (value: boolean): void => {
		this.summaryModelDownloaded = value;
		this.#scheduleSave();
	};
	setSelectedSummaryModel = (value: string): void => {
		this.selectedSummaryModel = value;
	};
	setDatabaseExists = (value: boolean): void => {
		this.databaseExists = value;
	};
	setPermissionStatus = (
		permission: keyof OnboardingPermissions,
		status: PermissionStatus,
	): void => {
		this.permissions = { ...this.permissions, [permission]: status };
	};
	setPermissionsSkipped = (skipped: boolean): void => {
		this.permissionsSkipped = skipped;
	};

	completeOnboarding = async (): Promise<void> => {
		this.#completing = true;
		if (this.#saveTimer !== null) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = null;
		}

		try {
			await invoke('complete_onboarding', { model: this.selectedSummaryModel });
			this.completed = true;
		} catch (error) {
			console.error('[OnboardingStore] complete_onboarding failed:', error);
			throw error;
		} finally {
			this.#completing = false;
		}
	};

	startBackgroundDownloads = async (includeGemma: boolean): Promise<void> => {
		this.isBackgroundDownloading = true;

		try {
			if (!this.parakeetDownloaded) {
				invoke('parakeet_download_model', { modelName: PARAKEET_MODEL }).catch((err) =>
					console.error('[OnboardingStore] Parakeet download failed:', err),
				);
			}

			if (includeGemma && !this.summaryModelDownloaded) {
				setTimeout(() => {
					invoke('builtin_ai_download_model', {
						modelName: this.selectedSummaryModel || 'gemma3:1b',
					}).catch((err) => console.error('[OnboardingStore] Gemma download failed:', err));
				}, 3000);
			}
		} catch (error) {
			this.isBackgroundDownloading = false;
			throw error;
		}
	};

	retryParakeetDownload = async (): Promise<void> => {
		await invoke('parakeet_retry_download', { modelName: PARAKEET_MODEL });
	};

	async #loadOnboardingStatus(): Promise<void> {
		try {
			const status = await invoke<OnboardingStatusBlob | null>('get_onboarding_status');
			if (!status) return;

			// Verify against disk before trusting the saved JSON.
			const verified = await this.#verifyModelStatus(status);
			this.currentStep = verified.currentStep;
			this.completed = verified.completed;
			this.parakeetDownloaded = verified.parakeetDownloaded;
			this.summaryModelDownloaded = verified.summaryModelDownloaded;

			await this.#checkActiveDownloads();
		} catch (error) {
			console.error('[OnboardingStore] Failed to load onboarding status:', error);
		}
	}

	async #verifyModelStatus(saved: OnboardingStatusBlob): Promise<{
		currentStep: number;
		completed: boolean;
		parakeetDownloaded: boolean;
		summaryModelDownloaded: boolean;
	}> {
		let parakeetDownloaded = false;
		let summaryModelDownloaded = false;

		try {
			await invoke('parakeet_init');
			parakeetDownloaded = await invoke<boolean>('parakeet_has_available_models');
		} catch (error) {
			console.warn('[OnboardingStore] Failed to verify Parakeet:', error);
		}

		try {
			const availableModel = await invoke<string | null>('builtin_ai_get_available_summary_model');
			summaryModelDownloaded = !!availableModel;
		} catch (error) {
			console.warn('[OnboardingStore] Failed to verify summary model:', error);
		}

		let currentStep = saved.current_step;
		if (currentStep > 4) currentStep = 3;

		return {
			currentStep,
			completed: saved.completed,
			parakeetDownloaded,
			summaryModelDownloaded,
		};
	}

	async #saveOnboardingStatus(): Promise<void> {
		if (this.#completing) return;

		try {
			await invoke('save_onboarding_status_cmd', {
				status: {
					version: '1.0',
					completed: this.completed,
					current_step: this.currentStep,
					model_status: {
						parakeet: this.parakeetDownloaded ? 'downloaded' : 'not_downloaded',
						summary: this.summaryModelDownloaded ? 'downloaded' : 'not_downloaded',
					},
					last_updated: new Date().toISOString(),
				},
			});
		} catch (error) {
			console.error('[OnboardingStore] Failed to save onboarding status:', error);
		}
	}

	async #checkDatabaseStatus(): Promise<void> {
		try {
			const isFirstLaunch = await invoke<boolean>('check_first_launch');
			this.databaseExists = !isFirstLaunch;
		} catch (error) {
			console.error('[OnboardingStore] Failed to check database status:', error);
			this.databaseExists = false;
		}
	}

	async #initializeDatabaseInBackground(): Promise<void> {
		try {
			const isFirstLaunch = await invoke<boolean>('check_first_launch');
			if (!isFirstLaunch) {
				this.databaseExists = true;
				return;
			}
			await this.#performAutoDetection();
		} catch (error) {
			console.error('[OnboardingStore] Database initialization failed:', error);
		}
	}

	async #performAutoDetection(): Promise<void> {
		const isMac =
			typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('mac');
		if (isMac) {
			const homebrewDbPath = '/usr/local/var/muesly/meeting_minutes.db';
			try {
				const check = await invoke<{ exists: boolean; size: number } | null>(
					'check_homebrew_database',
					{ path: homebrewDbPath },
				);
				if (check?.exists) {
					await invoke('import_and_initialize_database', { legacyDbPath: homebrewDbPath });
					this.databaseExists = true;
					toast.info('Imported your existing muesly database', {
						description: 'Meetings from your previous install are now available.',
					});
					return;
				}
			} catch (e) {
				console.log('[OnboardingStore] Homebrew DB check failed:', e);
			}
		}

		try {
			const legacyPath = await invoke<string | null>('check_default_legacy_database');
			if (legacyPath) {
				await invoke('import_and_initialize_database', { legacyDbPath: legacyPath });
				this.databaseExists = true;
				toast.info('Imported your existing muesly database', {
					description: 'Meetings from your previous install are now available.',
				});
				return;
			}
		} catch (e) {
			console.log('[OnboardingStore] Legacy DB check failed:', e);
		}

		await invoke('initialize_fresh_database');
		this.databaseExists = true;
	}

	async #fetchRecommendedModel(): Promise<void> {
		try {
			const recommended = await invoke<string>('builtin_ai_get_recommended_model');
			this.selectedSummaryModel = recommended;
		} catch (error) {
			console.error('[OnboardingStore] Failed to get recommended model:', error);
		}
	}

	async #checkActiveDownloads(): Promise<void> {
		try {
			const models = await invoke<Array<{ status?: unknown }>>('parakeet_get_available_models');
			const isDownloading = models.some(
				(m) =>
					m.status !== undefined &&
					(typeof m.status === 'object'
						? m.status !== null && 'Downloading' in m.status
						: m.status === 'Downloading'),
			);
			if (isDownloading) {
				this.isBackgroundDownloading = true;
			}
		} catch (error) {
			console.warn('[OnboardingStore] Failed to check active downloads:', error);
		}
	}

	#cleanup(): void {
		if (this.#saveTimer !== null) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = null;
		}
		for (const fn of this.#unsubscribers) {
			fn();
		}
		this.#unsubscribers = [];
		this.#started = false;
	}
}

export const onboarding = new OnboardingStore();

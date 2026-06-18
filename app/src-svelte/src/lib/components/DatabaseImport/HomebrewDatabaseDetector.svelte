<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { AlertCircle, CheckCircle2, Database, Loader2 } from '@lucide/svelte';

	import { toast } from '$lib/toast';

	interface Props {
		onImportSuccess: () => void;
		onDecline: () => void;
	}

	let { onImportSuccess, onDecline }: Props = $props();

	// Homebrew paths differ between Intel and Apple Silicon Macs.
	const HOMEBREW_PATHS = [
		'/opt/homebrew/var/muesly/meeting_minutes.db', // Apple Silicon (M1/M2/M3)
		'/usr/local/var/muesly/meeting_minutes.db' // Intel Macs
	];

	let isChecking = $state(true);
	let isImporting = $state(false);
	let homebrewDbExists = $state(false);
	let dbSize = $state(0);
	let detectedPath = $state('');
	let isDismissed = $state(false);

	const isVisible = $derived(!isChecking && homebrewDbExists && !isDismissed);

	onMount(() => {
		void checkHomebrewDatabase();
	});

	async function checkHomebrewDatabase(): Promise<void> {
		try {
			isChecking = true;

			for (const path of HOMEBREW_PATHS) {
				const result = await invoke<{ exists: boolean; size: number } | null>(
					'check_homebrew_database',
					{ path }
				);

				if (result && result.exists && result.size > 0) {
					homebrewDbExists = true;
					dbSize = result.size;
					detectedPath = path;
					break;
				}
			}
		} catch (error) {
			console.error('Error checking homebrew database:', error);
			// Silently fail — this is just auto-detection.
		} finally {
			isChecking = false;
		}
	}

	async function handleYes(): Promise<void> {
		try {
			isImporting = true;

			await invoke('import_and_initialize_database', { legacyDbPath: detectedPath });

			toast.success('Database imported successfully! Reloading...');
			onImportSuccess();

			// Wait 1 second for user to see success, then reload to refresh all data.
			setTimeout(() => {
				window.location.reload();
			}, 1000);
		} catch (error) {
			console.error('Error importing database:', error);
			toast.error(`Import failed: ${error}`);
			isImporting = false;
		}
	}

	function handleNo(): void {
		isDismissed = true;
		onDecline();
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

{#if isVisible}
	<div class="mb-4 rounded-lg border-2 border-accent/40 bg-accent/5 p-4">
		<div class="flex items-start gap-3">
			<Database class="mt-0.5 size-6 shrink-0 text-accent" />
			<div class="flex-1">
				<div class="mb-1 flex items-center gap-2">
					<AlertCircle class="size-4 text-accent" />
					<h3 class="text-sm font-semibold">Previous muesly Installation Detected!</h3>
				</div>
				<p class="mb-2 text-sm text-muted-foreground">
					We found an existing database from your previous muesly installation (Python backend
					version).
				</p>
				<div class="mb-3 rounded bg-secondary p-2">
					<p class="break-all font-mono text-xs text-muted-foreground">{detectedPath}</p>
					<p class="mt-1 text-xs text-muted-foreground">Size: {formatFileSize(dbSize)}</p>
				</div>
				<p class="mb-3 text-sm text-muted-foreground">
					Would you like to import your previous meetings, transcripts, and summaries?
				</p>

				<div class="flex gap-2">
					<button
						onclick={handleYes}
						disabled={isImporting}
						class="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{#if isImporting}
							<Loader2 class="size-4 animate-spin" />
							<span>Importing...</span>
						{:else}
							<CheckCircle2 class="size-4" />
							<span>Yes, Import</span>
						{/if}
					</button>

					<button
						onclick={handleNo}
						disabled={isImporting}
						class="flex-1 rounded-lg border-2 border-input px-4 py-2 transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
					>
						No, Browse Manually
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

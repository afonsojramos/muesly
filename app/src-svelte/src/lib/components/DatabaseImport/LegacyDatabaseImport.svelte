<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { CheckCircle2, Database, FolderOpen, Loader2, XCircle } from '@lucide/svelte';

	import Dialog from '$lib/ui/dialog.svelte';
	import { toast } from '$lib/toast';
	import HomebrewDatabaseDetector from './HomebrewDatabaseDetector.svelte';

	interface Props {
		isOpen: boolean;
		onComplete: () => void;
	}

	type ImportState = 'idle' | 'selecting' | 'detecting' | 'importing' | 'success' | 'error';

	let { isOpen, onComplete }: Props = $props();

	let importState = $state<ImportState>('idle');
	let detectedPath = $state<string | null>(null);
	let errorMessage = $state('');

	const isLoading = $derived(
		importState === 'selecting' || importState === 'detecting' || importState === 'importing'
	);
	const canImport = $derived(!!detectedPath && importState === 'idle');

	async function handleBrowse(): Promise<void> {
		try {
			importState = 'selecting';

			const selectedPath = await invoke<string | null>('select_legacy_database_path');

			if (!selectedPath) {
				importState = 'idle';
				return;
			}

			importState = 'detecting';

			const dbPath = await invoke<string | null>('detect_legacy_database', { selectedPath });

			if (dbPath) {
				detectedPath = dbPath;
				importState = 'idle';
			} else {
				errorMessage =
					'No database found at selected location. Please select the muesly folder, backend folder, or the database file directly.';
				detectedPath = null;
				importState = 'error';
				setTimeout(() => (importState = 'idle'), 3000);
			}
		} catch (error) {
			console.error('Error browsing for database:', error);
			errorMessage = String(error);
			importState = 'error';
			setTimeout(() => (importState = 'idle'), 3000);
		}
	}

	async function handleImport(): Promise<void> {
		if (!detectedPath) return;

		try {
			importState = 'importing';

			await invoke('import_and_initialize_database', { legacyDbPath: detectedPath });

			importState = 'success';
			toast.success('Database imported successfully! Reloading...');

			setTimeout(() => {
				window.location.reload();
			}, 1000);
		} catch (error) {
			console.error('Error importing database:', error);
			errorMessage = String(error);
			importState = 'error';
			toast.error(`Import failed: ${error}`);
			setTimeout(() => (importState = 'idle'), 3000);
		}
	}

	async function handleStartFresh(): Promise<void> {
		try {
			importState = 'importing';

			await invoke('initialize_fresh_database');

			importState = 'success';
			toast.success('Database initialized successfully! Starting app...');

			setTimeout(() => {
				window.location.reload();
			}, 1000);
		} catch (error) {
			console.error('Error initializing database:', error);
			errorMessage = String(error);
			importState = 'error';
			toast.error(`Initialization failed: ${error}`);
			setTimeout(() => (importState = 'idle'), 3000);
		}
	}

	function handleHomebrewImportSuccess(): void {
		// The HomebrewDatabaseDetector handles the reload itself.
		onComplete();
	}

	function handleHomebrewDecline(): void {
		// User declined homebrew import; they can continue with manual browse.
	}
</script>

<Dialog
	open={isOpen}
	onOpenChange={() => {}}
	title="Welcome to muesly!"
	description="Do you have data from a previous muesly installation?"
	class="sm:max-w-[600px]"
	showClose={false}
>
	<div class="space-y-6 py-4">
		<!-- Homebrew Database Auto-Detection -->
		<HomebrewDatabaseDetector
			onImportSuccess={handleHomebrewImportSuccess}
			onDecline={handleHomebrewDecline}
		/>

		<!-- Browse Section -->
		<div class="space-y-3">
			<p class="text-sm text-muted-foreground">
				Select your previous muesly folder, backend directory, or database file:
			</p>

			<button
				onclick={handleBrowse}
				disabled={isLoading}
				class="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if importState === 'selecting' || importState === 'detecting'}
					<Loader2 class="size-5 animate-spin" />
					<span>{importState === 'selecting' ? 'Selecting...' : 'Detecting database...'}</span>
				{:else}
					<FolderOpen class="size-5" />
					<span>Browse for Database</span>
				{/if}
			</button>
		</div>

		<!-- Detection Result -->
		{#if detectedPath}
			<div class="rounded-lg border border-green-500/30 bg-green-500/10 p-3">
				<div class="flex items-start gap-2">
					<CheckCircle2 class="mt-0.5 size-5 shrink-0 text-green-600" />
					<div class="min-w-0 flex-1">
						<p class="text-sm font-medium text-green-700">Database found!</p>
						<p class="mt-1 break-all text-xs text-green-700/80">{detectedPath}</p>
					</div>
				</div>
			</div>
		{/if}

		<!-- Error Message -->
		{#if importState === 'error' && errorMessage}
			<div class="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
				<div class="flex items-start gap-2">
					<XCircle class="mt-0.5 size-5 shrink-0 text-destructive" />
					<div class="flex-1">
						<p class="text-sm text-destructive">{errorMessage}</p>
					</div>
				</div>
			</div>
		{/if}

		<!-- Action Buttons -->
		<div class="flex flex-col gap-3 pt-2">
			<button
				onclick={handleImport}
				disabled={!canImport || isLoading}
				class="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if importState === 'importing'}
					<Loader2 class="size-5 animate-spin" />
					<span>Importing...</span>
				{:else if importState === 'success'}
					<CheckCircle2 class="size-5" />
					<span>Success!</span>
				{:else}
					<Database class="size-5" />
					<span>Import Database</span>
				{/if}
			</button>

			<div class="relative">
				<div class="absolute inset-0 flex items-center">
					<div class="w-full border-t border-border"></div>
				</div>
				<div class="relative flex justify-center text-sm">
					<span class="bg-card px-2 text-muted-foreground">or</span>
				</div>
			</div>

			<button
				onclick={handleStartFresh}
				disabled={isLoading}
				class="w-full rounded-lg border-2 border-input px-4 py-3 transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
			>
				Start Fresh (No Import)
			</button>
		</div>
	</div>
</Dialog>

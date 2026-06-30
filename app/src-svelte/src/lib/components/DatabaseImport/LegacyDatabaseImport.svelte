<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { CheckCircle2, Database, FolderOpen, Loader2, XCircle } from '@lucide/svelte';

	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
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

<Dialog.Root open={isOpen} onOpenChange={() => {}}>
	<Dialog.Content class="sm:max-w-[600px]" showCloseButton={false}>
		<Dialog.Header>
			<Dialog.Title>Welcome to muesly!</Dialog.Title>
			<Dialog.Description>
				Do you have data from a previous muesly installation?
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-6 py-4">
			<!-- Homebrew Database Auto-Detection -->
			<HomebrewDatabaseDetector
				onImportSuccess={handleHomebrewImportSuccess}
				onDecline={handleHomebrewDecline}
			/>

			<!-- Browse Section -->
			<div class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">
					Select your previous muesly folder, backend directory, or database file:
				</p>

				<Button class="w-full py-3" onclick={handleBrowse} disabled={isLoading}>
					{#if importState === 'selecting' || importState === 'detecting'}
						<Loader2 data-icon="inline-start" class="animate-spin" />
						<span>{importState === 'selecting' ? 'Selecting...' : 'Detecting database...'}</span>
					{:else}
						<FolderOpen data-icon="inline-start" />
						<span>Browse for Database</span>
					{/if}
				</Button>
			</div>

			<!-- Detection Result -->
			{#if detectedPath}
				<div class="rounded-lg border border-success/30 bg-success/10 p-3">
					<div class="flex items-start gap-2">
						<CheckCircle2 class="mt-0.5 size-5 shrink-0 text-success" />
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium text-success">Database found!</p>
							<p class="mt-1 break-all text-xs text-success/80">{detectedPath}</p>
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
				<Button class="w-full py-3" onclick={handleImport} disabled={!canImport || isLoading}>
					{#if importState === 'importing'}
						<Loader2 data-icon="inline-start" class="animate-spin" />
						<span>Importing...</span>
					{:else if importState === 'success'}
						<CheckCircle2 data-icon="inline-start" />
						<span>Success!</span>
					{:else}
						<Database data-icon="inline-start" />
						<span>Import Database</span>
					{/if}
				</Button>

				<div class="relative">
					<div class="absolute inset-0 flex items-center">
						<div class="w-full border-t border-border"></div>
					</div>
					<div class="relative flex justify-center text-sm">
						<span class="bg-popover px-2 text-muted-foreground">or</span>
					</div>
				</div>

				<Button variant="outline" class="w-full py-3" onclick={handleStartFresh} disabled={isLoading}>
					Start Fresh (No Import)
				</Button>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>

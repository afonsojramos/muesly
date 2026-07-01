<script lang="ts" module>
	function formatDuration(seconds: number): string {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		const secs = Math.floor(seconds % 60);
		if (hours > 0) {
			return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
		}
		return `${minutes}:${secs.toString().padStart(2, '0')}`;
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}
</script>

<script lang="ts">
	import {
		AlertCircle,
		CheckCircle2,
		ChevronDown,
		ChevronUp,
		Clock,
		Cpu,
		FileAudio,
		Globe,
		HardDrive,
		Loader2,
		Upload,
		X,
	} from '@lucide/svelte';
	import { goto } from '$app/navigation';

	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Progress } from '$lib/components/ui/progress';
	import * as Select from '$lib/components/ui/select';
	import { toast } from '$lib/toast';
	import { LANGUAGES } from '$lib/constants/languages';
	import { config } from '$lib/stores/config.svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import { useImportAudio, type ImportResult } from '$lib/hooks/use-import-audio.svelte';
	import {
		useTranscriptionModels,
		type ModelOption,
	} from '$lib/hooks/use-transcription-models.svelte';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		preselectedFile?: string | null;
		onComplete?: () => void;
	}

	let { open, onOpenChange, preselectedFile = null, onComplete }: Props = $props();

	let title = $state('');
	let selectedLang = $state(config.selectedLanguage || 'auto');
	let showAdvanced = $state(false);
	let titleModifiedByUser = $state(false);
	let prevOpen = false;

	const models = useTranscriptionModels(() => config.transcriptModelConfig);

	function handleImportComplete(result: ImportResult): void {
		toast.success(`Import complete! ${result.segments_count} segments created.`);
		void sidebar.refetchMeetings();
		onComplete?.();
		onOpenChange(false);
		void goto(`/meeting-details?id=${result.meeting_id}`);
	}

	function handleImportError(error: string): void {
		toast.error('Import failed', { description: error });
	}

	const importer = useImportAudio({
		onComplete: handleImportComplete,
		onError: handleImportError,
	});

	const selectedModel = $derived.by((): ModelOption | undefined => {
		const key = models.selectedModelKey;
		if (!key) return undefined;
		const colonIndex = key.indexOf(':');
		if (colonIndex === -1) return undefined;
		const provider = key.slice(0, colonIndex);
		const name = key.slice(colonIndex + 1);
		return models.availableModels.find((m) => m.provider === provider && m.name === name);
	});

	const isParakeetModel = $derived(selectedModel?.provider === 'parakeet');

	const languageItems = $derived(LANGUAGES.map((l) => ({ label: l.name, value: l.code })));
	const modelItems = $derived(
		models.availableModels.map((m) => ({
			label: `${m.displayName} (${Math.round(m.size_mb)} MB)`,
			value: `${m.provider}:${m.name}`,
		})),
	);

	const selectedLangLabel = $derived(
		languageItems.find((i) => i.value === selectedLang)?.label ?? 'Select language',
	);
	const selectedModelLabel = $derived(
		modelItems.find((i) => i.value === models.selectedModelKey)?.label ??
			(models.loadingModels ? 'Loading models...' : 'Select model'),
	);

	// Initialise only when transitioning from closed to open.
	$effect(() => {
		const wasOpen = prevOpen;
		prevOpen = open;
		if (open && !wasOpen) {
			importer.reset();
			models.resetSelection();
			title = '';
			titleModifiedByUser = false;
			selectedLang = config.selectedLanguage || 'auto';
			showAdvanced = false;

			if (preselectedFile) {
				void importer.validateFile(preselectedFile).then((info) => {
					if (info) title = info.filename;
				});
			}

			void models.fetchModels();
		}
	});

	// Update title from fileInfo when not yet set/modified.
	$effect(() => {
		if (importer.fileInfo && !title && !titleModifiedByUser) {
			title = importer.fileInfo.filename;
		}
	});

	// Parakeet always uses automatic detection.
	$effect(() => {
		if (isParakeetModel && selectedLang !== 'auto') {
			selectedLang = 'auto';
		}
	});

	async function handleSelectFile(): Promise<void> {
		const info = await importer.selectFile();
		if (info) title = info.filename;
	}

	async function handleStartImport(): Promise<void> {
		const fileInfo = importer.fileInfo;
		if (!fileInfo) return;
		await importer.startImport(
			fileInfo.path,
			title || fileInfo.filename,
			isParakeetModel ? null : selectedLang === 'auto' ? null : selectedLang,
			selectedModel?.name || null,
			selectedModel?.provider || null,
		);
	}

	async function handleCancel(): Promise<void> {
		if (importer.isProcessing) {
			await importer.cancelImport();
			toast.info('Import cancelled');
		}
		onOpenChange(false);
	}

	// Prevent closing while a file is being imported.
	function handleOpenChange(next: boolean): void {
		if (!next && importer.isProcessing) return;
		onOpenChange(next);
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-[500px]" showCloseButton={false}>
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2 text-lg font-semibold">
				{#if importer.isProcessing}
					<Loader2 class="size-5 animate-spin text-accent" />
					Importing Audio...
				{:else if importer.error}
					<AlertCircle class="size-5 text-destructive" />
					Import Failed
				{:else if importer.status === 'complete'}
					<CheckCircle2 class="size-5 text-success" />
					Import Complete
				{:else}
					<Upload class="size-5 text-accent" />
					Import Audio File
				{/if}
			</Dialog.Title>
			<Dialog.Description>
				{#if importer.isProcessing}
					{importer.progress?.message || 'Processing audio...'}
				{:else if importer.error}
					An error occurred during import
				{:else}
					Import an audio file to create a new meeting with transcripts
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-4 py-4">
			{#if !importer.isProcessing && !importer.error}
				{#if importer.fileInfo}
					<div class="flex flex-col gap-3 rounded-lg bg-secondary p-4">
						<div class="flex items-start gap-3">
							<FileAudio class="size-8 shrink-0 text-accent" />
							<div class="min-w-0 flex-1">
								<p class="truncate font-medium text-foreground">{importer.fileInfo.filename}</p>
								<div class="mt-1 flex items-center gap-4 text-sm text-muted-foreground">
									<span class="flex items-center gap-1">
										<Clock class="size-3.5" />
										{formatDuration(importer.fileInfo.duration_seconds)}
									</span>
									<span class="flex items-center gap-1">
										<HardDrive class="size-3.5" />
										{formatFileSize(importer.fileInfo.size_bytes)}
									</span>
									<span class="font-medium text-accent">{importer.fileInfo.format}</span>
								</div>
							</div>
						</div>

						<div class="flex flex-col gap-1">
							<label for="import-title" class="text-sm font-medium text-foreground">
								Meeting Title
							</label>
							<Input
								id="import-title"
								value={title}
								oninput={(e) => {
									title = e.currentTarget.value;
									titleModifiedByUser = true;
								}}
								placeholder="Enter meeting title"
							/>
						</div>

						<Button variant="outline" size="sm" onclick={handleSelectFile} class="w-full">
							Choose Different File
						</Button>
					</div>
				{:else}
					<div class="rounded-lg border-2 border-dashed border-border p-8 text-center">
						<FileAudio class="mx-auto mb-4 size-12 text-muted-foreground" />
						<Button onclick={handleSelectFile} disabled={importer.status === 'validating'}>
							{#if importer.status === 'validating'}
								<Loader2 data-icon="inline-start" class="animate-spin" />
								Validating...
							{:else}
								<Upload data-icon="inline-start" />
								Select Audio File
							{/if}
						</Button>
						<p class="mt-2 text-sm text-muted-foreground">
							MP4, WAV, MP3, FLAC, OGG, MKV, WebM, WMA
						</p>
					</div>
				{/if}

				{#if importer.fileInfo}
					<div class="rounded-lg border border-border">
						<Button
							variant="ghost"
							onclick={() => (showAdvanced = !showAdvanced)}
							class="h-auto w-full justify-between p-3 text-sm font-medium text-foreground"
						>
							<span>Advanced Options</span>
							{#if showAdvanced}<ChevronUp data-icon="inline-end" />{:else}<ChevronDown
									data-icon="inline-end"
								/>{/if}
						</Button>

						{#if showAdvanced}
							<div class="flex flex-col gap-4 border-t border-border p-3 pt-0">
								{#if !isParakeetModel}
									<div class="flex flex-col gap-2">
										<div class="flex items-center gap-2">
											<Globe class="size-4 text-muted-foreground" />
											<span class="text-sm font-medium">Language</span>
										</div>
										<Select.Root
											type="single"
											value={selectedLang}
											onValueChange={(v) => {
												if (v) selectedLang = v;
											}}
										>
											<Select.Trigger class="w-full">{selectedLangLabel}</Select.Trigger>
											<Select.Content>
												<Select.Group>
													{#each languageItems as item (item.value)}
														<Select.Item value={item.value} label={item.label}
															>{item.label}</Select.Item
														>
													{/each}
												</Select.Group>
											</Select.Content>
										</Select.Root>
									</div>
								{:else}
									<div class="flex flex-col gap-2">
										<div class="flex items-center gap-2">
											<Globe class="size-4 text-muted-foreground" />
											<span class="text-sm font-medium">Language</span>
										</div>
										<p class="text-xs text-muted-foreground">
											Language selection isn't supported for Parakeet. It always uses automatic
											detection.
										</p>
									</div>
								{/if}

								{#if models.availableModels.length > 0}
									<div class="flex flex-col gap-2">
										<div class="flex items-center gap-2">
											<Cpu class="size-4 text-muted-foreground" />
											<span class="text-sm font-medium">Model</span>
										</div>
										<Select.Root
											type="single"
											value={models.selectedModelKey ?? ''}
											disabled={models.loadingModels}
											onValueChange={(v) => {
												if (v) models.setSelectedModelKey(v);
											}}
										>
											<Select.Trigger class="w-full">{selectedModelLabel}</Select.Trigger>
											<Select.Content>
												<Select.Group>
													{#each modelItems as item (item.value)}
														<Select.Item value={item.value} label={item.label}
															>{item.label}</Select.Item
														>
													{/each}
												</Select.Group>
											</Select.Content>
										</Select.Root>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			{/if}

			{#if importer.isProcessing && importer.progress}
				<div class="flex flex-col gap-2">
					<div>
						<Progress value={Math.min(importer.progress.progress_percentage, 100)} />
						<div class="mt-1 flex justify-between text-xs text-muted-foreground">
							<span>{importer.progress.stage}</span>
							<span>{Math.round(importer.progress.progress_percentage)}%</span>
						</div>
					</div>
					<p class="text-center text-sm text-muted-foreground">{importer.progress.message}</p>
				</div>
			{/if}

			{#if importer.error}
				<div class="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
					<p class="text-sm text-destructive">{importer.error}</p>
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			{#if !importer.isProcessing && !importer.error}
				<Button variant="outline" onclick={() => onOpenChange(false)}>Cancel</Button>
				<Button onclick={handleStartImport} disabled={!importer.fileInfo}>
					<Upload data-icon="inline-start" />
					Import
				</Button>
			{:else if importer.isProcessing}
				<Button variant="outline" onclick={handleCancel}>
					<X data-icon="inline-start" />
					Cancel
				</Button>
			{:else if importer.error}
				<Button variant="outline" onclick={() => onOpenChange(false)}>Close</Button>
				<Button variant="outline" onclick={importer.reset}>Try Again</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

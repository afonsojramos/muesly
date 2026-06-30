<script lang="ts">
	import { check, type Update } from '@tauri-apps/plugin-updater';
	import { relaunch } from '@tauri-apps/plugin-process';
	import { AlertCircle, Download, Loader2 } from '@lucide/svelte';

	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { toast } from '$lib/toast';
	import type { UpdateInfo, UpdateProgress } from '$lib/services/update';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		updateInfo: UpdateInfo | null;
	}

	let { open, onOpenChange, updateInfo }: Props = $props();

	let isDownloading = $state(false);
	let progress = $state<UpdateProgress | null>(null);
	let error = $state<string | null>(null);
	let update = $state<Update | null>(null);

	// Reset / prepare state whenever the dialog opens or closes.
	$effect(() => {
		if (open && updateInfo?.available) {
			isDownloading = false;
			progress = null;
			error = null;

			check()
				.then((updateResult) => {
					if (updateResult?.available) {
						update = updateResult;
					} else {
						error = 'Update no longer available';
					}
				})
				.catch((err: unknown) => {
					console.error('Failed to get update object:', err);
					error = 'Failed to prepare update: ' + extractMessage(err);
				});
		} else {
			isDownloading = false;
			progress = null;
			error = null;
			update = null;
		}
	});

	function extractMessage(err: unknown): string {
		if (err instanceof Error) return err.message;
		return 'Unknown error';
	}

	async function handleDownloadAndInstall(): Promise<void> {
		let updateToUse: Update | null = update;
		if (!updateToUse) {
			try {
				const updateResult = await check();
				if (updateResult?.available) {
					updateToUse = updateResult;
					update = updateResult;
				} else {
					error = 'Update not available';
					return;
				}
			} catch (err: unknown) {
				error = 'Failed to get update: ' + extractMessage(err);
				return;
			}
		}

		if (!updateToUse) {
			return;
		}

		isDownloading = true;
		error = null;
		progress = { downloaded: 0, total: 0, percentage: 0 };

		try {
			let downloaded = 0;
			let contentLength = 0;

			await updateToUse.downloadAndInstall((event) => {
				switch (event.event) {
					case 'Started':
						contentLength = event.data.contentLength ?? 0;
						progress = { downloaded: 0, total: contentLength, percentage: 0 };
						break;

					case 'Progress': {
						downloaded += event.data.chunkLength ?? 0;
						const percentage =
							contentLength > 0 ? Math.round((downloaded / contentLength) * 100) : 0;
						progress = { downloaded, total: contentLength, percentage };
						break;
					}

					case 'Finished':
						progress = { downloaded: contentLength, total: contentLength, percentage: 100 };
						break;
				}
			});

			toast.success('Update installed successfully. The app will restart...');

			isDownloading = false;
			handleOpenChange(false);

			await relaunch();
		} catch (err: unknown) {
			console.error('Update failed:', err);
			error = extractMessage(err);
			isDownloading = false;
			toast.error('Update failed: ' + extractMessage(err));
		}
	}

	function formatDate(dateString?: string): string {
		if (!dateString) return '';
		try {
			return new Date(dateString).toLocaleDateString();
		} catch {
			return dateString;
		}
	}

	// Prevent closing the dialog while downloading.
	function handleOpenChange(newOpen: boolean): void {
		if (!newOpen && isDownloading) {
			return;
		}
		onOpenChange(newOpen);
	}

	function formatBytes(bytes: number): string {
		if (bytes === 0) return '0 Bytes';
		const k = 1024;
		const sizes = ['Bytes', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		const unit = sizes[i] ?? 'Bytes';
		return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + unit;
	}
</script>

{#if updateInfo?.available}
	<Dialog.Root {open} onOpenChange={handleOpenChange}>
		<Dialog.Content class="sm:max-w-[500px]" showCloseButton={!isDownloading}>
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2 text-lg font-semibold">
					{#if isDownloading}
						<Loader2 class="size-5 animate-spin text-accent" />
						Downloading Update
					{:else if error}
						<AlertCircle class="size-5 text-destructive" />
						Update Error
					{:else}
						<Download class="size-5 text-accent" />
						Update Available
					{/if}
				</Dialog.Title>
				<Dialog.Description>
					{#if isDownloading}
						Downloading the latest version...
					{:else if error}
						An error occurred while updating
					{:else}
						A new version ({updateInfo.version}) is available
					{/if}
				</Dialog.Description>
			</Dialog.Header>

			<div class="flex flex-col gap-4 py-4">
				{#if !isDownloading && !error}
					<div class="flex flex-col gap-2">
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">Current Version:</span>
							<span class="font-medium">{updateInfo.currentVersion}</span>
						</div>
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">New Version:</span>
							<span class="font-medium text-accent">{updateInfo.version}</span>
						</div>
						{#if updateInfo.date}
							<div class="flex justify-between text-sm">
								<span class="text-muted-foreground">Release Date:</span>
								<span class="font-medium">{formatDate(updateInfo.date)}</span>
							</div>
						{/if}
					</div>

					{#if updateInfo.body}
						<div class="max-h-40 overflow-y-auto rounded-lg bg-secondary p-3">
							<p class="whitespace-pre-wrap text-sm text-muted-foreground">
								{updateInfo.body}
							</p>
						</div>
					{/if}
				{/if}

				{#if isDownloading && progress}
					<div class="flex flex-col gap-2">
						<div>
							<Progress value={Math.min(progress.percentage, 100)} />
							<div class="mt-1 flex justify-between text-xs text-muted-foreground">
								<span>{Math.round(progress.percentage)}% complete</span>
								{#if progress.total > 0}
									<span>
										{formatBytes(progress.downloaded)} / {formatBytes(progress.total)}
									</span>
								{/if}
							</div>
						</div>
						<p class="text-center text-sm text-muted-foreground">
							The app will restart automatically after installation
						</p>
					</div>
				{/if}

				{#if error}
					<div class="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
						<p class="text-sm text-destructive">{error}</p>
					</div>
				{/if}
			</div>

			<Dialog.Footer>
				{#if !isDownloading && !error}
					<Button variant="outline" onclick={() => handleOpenChange(false)}>Later</Button>
					<Button variant="accent" onclick={handleDownloadAndInstall}>
						<Download data-icon="inline-start" />
						Download & Install
					</Button>
				{:else if error}
					<Button variant="outline" onclick={() => handleOpenChange(false)}>Close</Button>
				{/if}
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}

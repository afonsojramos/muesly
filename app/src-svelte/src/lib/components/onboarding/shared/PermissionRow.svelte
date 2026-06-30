<script lang="ts">
	import type { Snippet } from 'svelte';
	import { CheckCircle2, Loader2, XCircle } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import type { PermissionStatus } from '$lib/types/onboarding';

	interface Props {
		icon: Snippet;
		title: string;
		description: string;
		status: PermissionStatus;
		isPending?: boolean;
		onAction: () => void;
	}

	let { icon, title, description, status, isPending = false, onAction }: Props = $props();

	const isAuthorized = $derived(status === 'authorized');
	const isDenied = $derived(status === 'denied');
	const isChecking = $derived(isPending);

	const buttonText = $derived(
		isChecking ? 'Checking...' : isDenied ? 'Open Settings' : 'Enable'
	);
</script>

<div
	class={cn(
		'flex items-center justify-between rounded-2xl border px-6 py-5 transition-all duration-200',
		isAuthorized
			? 'border-primary bg-secondary'
			: isDenied
				? 'border-destructive/30 bg-destructive/5'
				: 'bg-card border-border'
	)}
>
	<!-- Left side: Icon + Info -->
	<div class="flex items-center gap-3 flex-1 min-w-0">
		<div
			class={cn(
				'flex size-10 items-center justify-center rounded-full flex-shrink-0',
				isAuthorized ? 'bg-secondary' : isDenied ? 'bg-destructive/10' : 'bg-muted'
			)}
		>
			<div
				class={cn(
					isAuthorized
						? 'text-foreground'
						: isDenied
							? 'text-destructive'
							: 'text-muted-foreground'
				)}
			>
				{@render icon()}
			</div>
		</div>

		<div class="min-w-0 flex-1">
			<div class="font-medium truncate text-foreground">{title}</div>
			<div class="text-sm text-muted-foreground">
				{#if isAuthorized}
					<span class="text-success flex items-center gap-1">
						<CheckCircle2 class="size-3.5" />
						Access Granted
					</span>
				{:else if isDenied}
					<span class="text-destructive flex items-center gap-1">
						<XCircle class="size-3.5" />
						Access Denied - Please grant in System Settings
					</span>
				{:else}
					<span>{description}</span>
				{/if}
			</div>
		</div>
	</div>

	<!-- Right side: Action button or checkmark -->
	<div class="flex items-center gap-2 flex-shrink-0 ml-3">
		{#if !isAuthorized}
			<Button
				variant={isDenied ? 'destructive' : 'outline'}
				size="sm"
				onclick={onAction}
				disabled={isChecking}
				class="min-w-[100px]"
			>
				{#if isChecking}
					<Loader2 class="animate-spin" data-icon="inline-start" />
				{/if}
				{buttonText}
			</Button>
		{:else}
			<div class="flex size-8 items-center justify-center rounded-full bg-success/15">
				<CheckCircle2 class="size-4 text-success" />
			</div>
		{/if}
	</div>
</div>

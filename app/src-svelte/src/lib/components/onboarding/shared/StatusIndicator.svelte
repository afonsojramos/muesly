<script lang="ts" module>
	export type StatusIndicatorStatus = 'idle' | 'checking' | 'success' | 'error';
	export type StatusIndicatorSize = 'sm' | 'md' | 'lg';
</script>

<script lang="ts">
	import { cn } from '$lib/utils';

	interface Props {
		status: StatusIndicatorStatus;
		size?: StatusIndicatorSize;
		class?: string;
	}

	let { status, size = 'md', class: className }: Props = $props();

	const sizeClasses: Record<StatusIndicatorSize, string> = {
		sm: 'w-2 h-2',
		md: 'w-3 h-3',
		lg: 'w-4 h-4'
	};

	const statusColors: Record<StatusIndicatorStatus, string> = {
		idle: 'bg-muted-foreground/40',
		checking: 'bg-yellow-400 animate-pulse',
		success: 'bg-green-500',
		error: 'bg-destructive'
	};
</script>

<span class={cn('rounded-full inline-block', sizeClasses[size], statusColors[status], className)}
></span>

<script lang="ts">
	import { Switch as SwitchPrimitive } from 'bits-ui';
	import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		checked = $bindable(false),
		size = 'default',
		...restProps
	}: WithoutChildrenOrChild<SwitchPrimitive.RootProps> & {
		size?: 'sm' | 'default';
	} = $props();
</script>

<SwitchPrimitive.Root
	bind:ref
	bind:checked
	data-slot="switch"
	data-size={size}
	class={cn(
		'data-[state=checked]:bg-switch-active data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 dark:data-[state=unchecked]:bg-input/80 shrink-0 rounded-[7px] border border-transparent focus-visible:ring-3 aria-invalid:ring-3 data-[size=default]:h-5 data-[size=default]:w-[38px] data-[size=sm]:h-4 data-[size=sm]:w-[30px] peer group/switch relative inline-flex items-center transition-[background-color,box-shadow] outline-none after:absolute after:-inset-x-3 after:-inset-y-2 data-disabled:cursor-not-allowed data-disabled:opacity-50',
		className,
	)}
	{...restProps}
>
	<SwitchPrimitive.Thumb
		data-slot="switch-thumb"
		class="bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-brand-foreground group-data-[size=default]/switch:h-3 group-data-[size=default]/switch:w-[18px] group-data-[size=default]/switch:rounded-[3px] group-data-[size=sm]/switch:h-2.5 group-data-[size=sm]/switch:w-3.5 group-data-[size=sm]/switch:rounded-[2px] group-data-[size=default]/switch:data-[state=checked]:translate-x-4 group-data-[size=sm]/switch:data-[state=checked]:translate-x-[13px] group-data-[size=default]/switch:data-[state=unchecked]:translate-x-1 group-data-[size=sm]/switch:data-[state=unchecked]:translate-x-[3px] pointer-events-none block ring-0 transition-transform rtl:data-[state=checked]:-translate-x-4"
	/>
</SwitchPrimitive.Root>

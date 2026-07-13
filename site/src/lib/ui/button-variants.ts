import { cn } from '$lib/utils/cn';

export type ButtonVariant = 'default' | 'accent' | 'outline' | 'ghost' | 'link';
export type ButtonSize = 'default' | 'lg' | 'icon';

const base =
	'inline-flex items-center justify-center gap-2 rounded-[var(--radius)] font-medium whitespace-nowrap transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50';

const variants: Record<ButtonVariant, string> = {
	default:
		'bg-primary text-primary-foreground shadow-button hover:bg-primary/90 hover:shadow-button-hover',
	accent:
		'bg-accent text-accent-foreground shadow-accent-button hover:bg-accent/90 hover:shadow-accent-button-hover',
	outline: 'bg-card text-foreground shadow-card hover:bg-secondary hover:shadow-card-hover',
	ghost: 'bg-transparent text-foreground hover:bg-secondary',
	link: 'bg-transparent text-accent underline-offset-4 hover:underline',
};

const sizes: Record<ButtonSize, string> = {
	default: 'h-10 px-4 text-sm',
	lg: 'h-12 px-6 text-base',
	icon: 'h-10 w-10',
};

/** Compose the class string for a marketing button (no CVA dependency). */
export function buttonVariants(opts?: {
	variant?: ButtonVariant;
	size?: ButtonSize;
	class?: string;
}): string {
	const { variant = 'default', size = 'default', class: className } = opts ?? {};
	return cn(base, variants[variant], sizes[size], className);
}

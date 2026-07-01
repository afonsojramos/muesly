/**
 * useTemplates
 *
 * Lists available summary templates and tracks the selected one.
 */

import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';

import { Analytics } from '$lib/analytics';
import { toast } from '$lib/toast';

export interface Template {
	id: string;
	name: string;
	description: string;
}

export interface UseTemplates {
	readonly availableTemplates: Template[];
	readonly selectedTemplate: string;
	handleTemplateSelection: (templateId: string, templateName: string) => void;
}

// Templates are global, read-only app state, so cache them at module scope and
// share across every hook instance. This avoids re-fetching (and re-reading the
// template files from disk on the Rust side) each time the meeting view re-mounts.
let availableTemplates = $state<Template[]>([]);
let templatesPromise: Promise<Template[]> | null = null;

function loadTemplates(): Promise<Template[]> {
	templatesPromise ??= invoke<Template[]>('api_list_templates')
		.then((templates) => {
			availableTemplates = templates;
			return templates;
		})
		.catch((error) => {
			console.error('Failed to fetch templates:', error);
			templatesPromise = null; // allow a retry on the next mount
			return [];
		});

	return templatesPromise;
}

export function useTemplates(): UseTemplates {
	let selectedTemplate = $state<string>('standard_meeting');

	onMount(() => {
		void loadTemplates();
	});

	const handleTemplateSelection = (templateId: string, templateName: string): void => {
		selectedTemplate = templateId;
		toast.success('Template selected', {
			description: `Using "${templateName}" template for summary generation`,
		});
		Analytics.track('feature_used', { feature: 'template_selected' }).catch(() => {});
	};

	return {
		get availableTemplates() {
			return availableTemplates;
		},
		get selectedTemplate() {
			return selectedTemplate;
		},
		handleTemplateSelection,
	};
}

export interface BarExecution {
	barId: string;
	barTitle: string;
	/** Fully interpolated prompt used for this run. */
	barPrompt: string;
	/** One-off refinement supplied after a slash command. */
	barContext?: string;
}

const ADDITIONAL_INSTRUCTIONS_MARKER = '\n\nAdditional instructions from the user:\n';

/** Preserve the reusable bar prompt while clearly separating the user's
 * one-off refinement from the bar's authored instructions. */
export function addBarInstructions(prompt: string, additionalInstructions?: string): string {
	const additional = additionalInstructions?.trim();
	if (!additional) return prompt;
	return `${prompt.trim()}${ADDITIONAL_INSTRUCTIONS_MARKER}${additional}`;
}

export interface ParsedBarCommand {
	slug: string;
	additionalInstructions: string;
}

/** Parse `/recent-todos related to project X?` without flattening multiline
 * refinements. Returns null for ordinary chat drafts. */
export function parseBarCommandDraft(draft: string): ParsedBarCommand | null {
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft.trim());
	if (!match?.[1]) return null;
	return {
		slug: match[1].toLowerCase(),
		additionalInstructions: match[2]?.trim() ?? '',
	};
}

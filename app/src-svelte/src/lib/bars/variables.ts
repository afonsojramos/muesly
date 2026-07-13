const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9 _-]{0,39})\s*\}\}/g;

/** Unique `{{variable}}` names in first-appearance order. */
export function barVariables(prompt: string): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const match of prompt.matchAll(VARIABLE_PATTERN)) {
		const name = match[1]!.trim();
		const key = name.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			names.push(name);
		}
	}
	return names;
}

/** Replace known placeholders while leaving any unanswered ones intact. */
export function fillBarVariables(prompt: string, values: Record<string, string>): string {
	const normalized = new Map(
		Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
	);
	return prompt.replace(VARIABLE_PATTERN, (placeholder, name: string) => {
		const value = normalized.get(name.trim().toLowerCase())?.trim();
		return value || placeholder;
	});
}

export function variableLabel(name: string): string {
	return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

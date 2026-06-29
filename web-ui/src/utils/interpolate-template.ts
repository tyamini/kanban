/**
 * Replace `{{key}}` tokens in a template with the provided values. Unknown
 * tokens are left untouched; callers that want empty fallbacks should pass an
 * empty string for those keys.
 */
export function interpolateTemplate(template: string, variables: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(variables)) {
		result = result.replaceAll(`{{${key}}}`, value);
	}
	return result;
}

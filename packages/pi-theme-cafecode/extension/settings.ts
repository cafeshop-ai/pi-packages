export const THEME_KEY = "cafe-theme";
export const GROUP_KEY = "cafe-theme-tools-group";
export const DETAIL_KEY = "cafe-theme-tools-extra-detail";

/** Legacy names are accepted only while reading settings, never shown in the UI. */
export function normalizeThemeName(name: string): string {
	return name.split("/").map(part =>
		/^claude-code-(dark|light)(-ansi|-daltonized)?$/.test(part)
			? part.replace("claude-code-", "cafe-theme-")
			: part,
	).join("/");
}

export function normalizeThemeSettings(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Theme settings must be a JSON object");
	}
	const settings = { ...value } as Record<string, unknown>;
	for (const [oldKey, newKey] of [
		["ccTheme", THEME_KEY],
		["ccToolsExtraDetail", DETAIL_KEY],
		["groupToolCalls", GROUP_KEY],
	]) {
		if (!Object.hasOwn(settings, newKey) && Object.hasOwn(settings, oldKey)) {
			settings[newKey] = settings[oldKey];
		}
		delete settings[oldKey];
	}
	for (const key of [THEME_KEY, "theme"]) {
		if (typeof settings[key] === "string") settings[key] = normalizeThemeName(settings[key]);
	}
	return settings;
}

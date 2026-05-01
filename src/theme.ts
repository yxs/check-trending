export const THEME_STORAGE_KEY = 'check-trending-theme-preference';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const VALID_THEME_PREFERENCES: ThemePreference[] = ['system', 'light', 'dark'];

export function parseThemePreference(value: string | null): ThemePreference {
  if (value && VALID_THEME_PREFERENCES.includes(value as ThemePreference)) {
    return value as ThemePreference;
  }
  return 'system';
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return preference;
}

import { describe, expect, it } from 'vitest';

import { parseThemePreference, resolveTheme } from './theme';

describe('theme preference parsing', () => {
  it('accepts known preferences', () => {
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('system')).toBe('system');
  });

  it('falls back to system for unknown values', () => {
    expect(parseThemePreference(null)).toBe('system');
    expect(parseThemePreference('')).toBe('system');
    expect(parseThemePreference('auto')).toBe('system');
  });
});

describe('theme resolution', () => {
  it('resolves system preference from OS theme', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('keeps explicit light/dark preferences', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

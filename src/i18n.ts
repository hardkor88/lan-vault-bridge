import { moment } from 'obsidian';
import type { UiLanguage } from './types';

let current: 'en' | 'ru' = 'en';

/** Определяет язык интерфейса: auto следует языку Obsidian. */
export function resolveUiLanguage(setting: UiLanguage): 'en' | 'ru' {
	if (setting === 'en' || setting === 'ru') {
		return setting;
	}
	const candidates: string[] = [];
	try {
		candidates.push(moment.locale());
	} catch {
		// moment может быть недоступен в тестовой среде.
	}
	try {
		const stored = window.localStorage.getItem('language');
		if (stored) {
			candidates.push(stored);
		}
	} catch {
		// localStorage может быть недоступен.
	}
	if (typeof navigator !== 'undefined' && navigator.language) {
		candidates.push(navigator.language);
	}
	for (const candidate of candidates) {
		const normalized = candidate.toLowerCase();
		if (normalized === 'ru' || normalized.startsWith('ru-') || normalized.startsWith('ru_')) {
			return 'ru';
		}
	}
	return 'en';
}

export function setUiLanguage(setting: UiLanguage): void {
	current = resolveUiLanguage(setting);
}

export function getUiLanguage(): 'en' | 'ru' {
	return current;
}

export function getLocale(): string {
	return current === 'ru' ? 'ru-RU' : 'en-US';
}

export type TranslationVars = Record<string, string | number>;

/**
 * Двуязычная строка. Английский вариант — источник, русский — перевод.
 * Плейсхолдеры вида {name} подставляются из vars.
 */
export function t(english: string, russian: string, vars?: TranslationVars): string {
	let text = current === 'ru' ? russian : english;
	if (vars) {
		for (const [key, value] of Object.entries(vars)) {
			text = text.split(`{${key}}`).join(String(value));
		}
	}
	return text;
}

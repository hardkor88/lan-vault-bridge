import { Platform, normalizePath } from 'obsidian';
import type { ConnectionPayload, LocalAddressInfo } from './types';
import { getLocale, getUiLanguage, t } from './i18n';

const TEXT_EXTENSIONS = new Set<string>([
	'md',
	'markdown',
	'mdx',
	'txt',
	'text',
	'json',
	'jsonc',
	'csv',
	'tsv',
	'canvas',
	'html',
	'htm',
	'css',
	'scss',
	'js',
	'mjs',
	'cjs',
	'ts',
	'tsx',
	'jsx',
	'xml',
	'svg',
	'yaml',
	'yml',
	'toml',
	'ini',
	'conf',
	'log',
	'tex',
	'bib',
	'py',
	'java',
	'kt',
	'c',
	'h',
	'cpp',
	'hpp',
	'cs',
	'go',
	'rs',
	'rb',
	'php',
	'sh',
	'ps1',
	'sql',
	'graphql',
	'gql',
]);

const IMAGE_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	avif: 'image/avif',
	ico: 'image/x-icon',
};

function unitNames(): string[] {
	return getUiLanguage() === 'ru'
		? ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
		: ['B', 'KB', 'MB', 'GB', 'TB'];
}

/**
 * Приводит путь к каноническому виду: прямые слэши, NFC, без ведущих/замыкающих слэшей.
 * NFC важен при синхронизации macOS (NFD) с Android/Windows (NFC).
 */
export function normalizeVaultPath(input: string): string {
	const replaced = input.replace(/\\/g, '/').trim();
	if (!replaced) {
		return '';
	}
	// Preserve traversal segments so the server can reject them after normalization.
	const unsafe = replaced.split('/').some((segment) => segment === '..');
	let path = unsafe ? replaced : normalizePath(replaced);
	path = path.normalize('NFC');
	path = path.replace(/^\.\//, '');
	path = path.replace(/^\/+/, '');
	path = path.replace(/\/{2,}/g, '/');
	path = path.replace(/\/+$/, '');
	return path;
}

export function parentFolder(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? '' : path.slice(0, index);
}

export function baseName(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? path : path.slice(index + 1);
}

export function extensionOf(path: string): string {
	const name = baseName(path);
	const index = name.lastIndexOf('.');
	return index === -1 ? '' : name.slice(index + 1).toLowerCase();
}

export function isPathIgnored(
	path: string,
	configDir: string,
	excludedFolders: readonly string[],
): boolean {
	const normalized = normalizeVaultPath(path);
	if (!normalized) {
		return true;
	}
	const config = normalizeVaultPath(configDir);
	if (config && (normalized === config || normalized.startsWith(`${config}/`))) {
		return true;
	}
	// Локальная корзина Obsidian: синхронизировать её содержимое не нужно.
	if (normalized === '.trash' || normalized.startsWith('.trash/')) {
		return true;
	}
	for (const folder of excludedFolders) {
		const excluded = normalizeVaultPath(folder);
		if (!excluded) {
			continue;
		}
		if (normalized === excluded || normalized.startsWith(`${excluded}/`)) {
			return true;
		}
	}
	return false;
}

export function isTextPath(path: string): boolean {
	return TEXT_EXTENSIONS.has(extensionOf(path));
}

export function isImagePath(path: string): boolean {
	return extensionOf(path) in IMAGE_MIME;
}

export function getImageMime(path: string): string {
	return IMAGE_MIME[extensionOf(path)] ?? 'application/octet-stream';
}

export function formatBytes(bytes: number): string {
	const units = unitNames();
	if (!Number.isFinite(bytes) || bytes < 0) {
		return '—';
	}
	if (bytes < 1024) {
		return `${Math.round(bytes)} ${units[0]}`;
	}
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = value >= 100 ? 0 : 1;
	return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatTimestamp(timestamp: number | undefined | null): string {
	if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) {
		return '—';
	}
	try {
		return new Date(timestamp).toLocaleString(getLocale(), {
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	} catch {
		return new Date(timestamp).toISOString();
	}
}

export function decodeUtf8(buffer: ArrayBuffer): string {
	const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	getCrypto().getRandomValues(bytes);
	let result = '';
	for (let i = 0; i < bytes.length; i += 1) {
		result += bytes[i].toString(16).padStart(2, '0');
	}
	return result;
}

export function createDeviceId(): string {
	const cryptoApi = getCrypto();
	if (typeof cryptoApi.randomUUID === 'function') {
		return cryptoApi.randomUUID();
	}
	return `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(8)}`;
}

function getCrypto(): Crypto {
	const cryptoApi = globalThis.crypto;
	if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
		throw new Error(
			t(
				'Web Crypto API is unavailable in this Obsidian environment.',
				'Web Crypto API недоступен в этой среде Obsidian.',
			),
		);
	}
	return cryptoApi;
}

/** Сравнение строк без утечки длины/позиции первого отличия (для токена). */
export function safeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < left.length; i += 1) {
		diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}
	return diff === 0;
}

export function isValidPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function clampPort(port: number): number {
	if (!Number.isFinite(port)) {
		return 27123;
	}
	const rounded = Math.round(port);
	if (rounded < 1) {
		return 1;
	}
	if (rounded > 65535) {
		return 65535;
	}
	return rounded;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			reject(new Error(message));
		}, Math.max(1000, timeoutMs));
		promise.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				window.clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'string') {
		return error;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

export function connectionJson(ip: string, port: number, token: string): string {
	return JSON.stringify({ ip, port, token });
}

/**
 * Разбирает строку подключения из QR/буфера обмена. Понимает ip/host/hostname/address.
 */
export function parseConnectionPayload(raw: string): ConnectionPayload {
	const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
	if (!trimmed) {
		throw new Error(t('The connection string is empty.', 'Строка подключения пуста.'));
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error(
			t(
				'The connection string is not valid JSON. Copy it entirely from the desktop settings.',
				'Строка не является корректным JSON. Скопируйте её целиком из настроек ПК.',
			),
		);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(
			t(
				'Expected a JSON object like {"ip":"...","port":27123,"token":"..."}.',
				'Ожидался JSON-объект вида {"ip":"...","port":27123,"token":"..."}.',
			),
		);
	}
	const record = parsed as Record<string, unknown>;
	const rawHost = record.ip ?? record.host ?? record.hostname ?? record.address;
	if (typeof rawHost !== 'string' || !rawHost.trim()) {
		throw new Error(t('The JSON is missing the ip (or host) field.', 'В JSON отсутствует поле ip (или host).'));
	}
	const rawPort = record.port;
	const port = typeof rawPort === 'number' ? rawPort : Number(rawPort);
	if (!isValidPort(port)) {
		throw new Error(
			t(
				'The port in the connection string must be an integer between 1 and 65535.',
				'Порт в строке подключения должен быть целым числом от 1 до 65535.',
			),
		);
	}
	if (typeof record.token !== 'string' || !record.token.trim()) {
		throw new Error(t('The JSON is missing the token field.', 'В JSON отсутствует поле token.'));
	}
	return { ip: rawHost.trim(), port, token: record.token.trim() };
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		try {
			const area = document.createElement('textarea');
			area.value = text;
			area.setAttribute('readonly', 'true');
			area.style.position = 'fixed';
			area.style.opacity = '0';
			document.body.appendChild(area);
			area.select();
			const ok = document.execCommand('copy');
			area.remove();
			return ok;
		} catch {
			return false;
		}
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

/**
 * Возвращает все внешние IPv4-адреса. Node.js `os` грузится лениво и только на desktop.
 * Приоритет: 192.168.*, 10.*, 172.16-31.*, затем CGNAT/Tailscale 100.64/10.
 */
export function detectLocalAddresses(): LocalAddressInfo[] {
	if (!Platform.isDesktop) {
		return [];
	}
	const requireFn = window.require;
	if (typeof requireFn !== 'function') {
		return [];
	}
	try {
		const os = requireFn('os') as {
			networkInterfaces(): Record<
				string,
				Array<{ address: string; family: string | number; internal: boolean }> | undefined
			>;
		};
		if (!os || typeof os.networkInterfaces !== 'function') {
			return [];
		}
		const result: LocalAddressInfo[] = [];
		const seen = new Set<string>();
		const interfaces = os.networkInterfaces();
		for (const [iface, list] of Object.entries(interfaces)) {
			for (const info of list ?? []) {
				const family = typeof info.family === 'string' ? info.family : String(info.family);
				if (family !== 'IPv4' && family !== '4') {
					continue;
				}
				if (info.internal) {
					continue;
				}
				const address = info.address;
				if (!address || address.startsWith('127.') || address.startsWith('169.254.')) {
					continue;
				}
				if (seen.has(address)) {
					continue;
				}
				seen.add(address);
				result.push({ address, iface, score: scoreAddress(address) });
			}
		}
		result.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
		return result;
	} catch {
		return [];
	}
}

function scoreAddress(address: string): number {
	if (address.startsWith('192.168.')) {
		return 100;
	}
	if (address.startsWith('10.')) {
		return 90;
	}
	const match = /^172\.(\d{1,3})\./.exec(address);
	if (match) {
		const second = Number(match[1]);
		if (second >= 16 && second <= 31) {
			return 80;
		}
	}
	if (address.startsWith('100.')) {
		const second = Number(address.split('.')[1]);
		if (second >= 64 && second <= 127) {
			return 70; // CGNAT / Tailscale
		}
	}
	return 10;
}

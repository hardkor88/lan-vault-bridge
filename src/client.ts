import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';
import { sha256Hex } from './manifest';
import type {
	DownloadedFile,
	FileMetadata,
	LanSyncSettings,
	PingResponse,
	SyncDiff,
	VaultManifest,
} from './types';
import { errorMessage, isValidPort, withTimeout } from './utils';
import { t } from './i18n';

export class SyncClientError extends Error {
	readonly status?: number;
	readonly code?: string;

	constructor(message: string, status?: number, code?: string) {
		super(message);
		this.name = 'SyncClientError';
		this.status = status;
		this.code = code;
	}
}

interface SendOptions {
	url: string;
	method: 'GET' | 'POST' | 'DELETE';
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
	timeoutMs: number;
}

/**
 * Клиентская обёртка над Obsidian requestUrl.
 *
 * requestUrl использует нативный HTTP-стек Capacitor/Electron, поэтому:
 *  - нет CORS-блокировок при обращении к http://192.168.x.x;
 *  - нет Mixed Content-блокировки на Android (https/capacitor -> http).
 * Обычный браузерный fetch на мобильном здесь не работает.
 */
export class SyncClient {
	private readonly getSettings: () => LanSyncSettings;

	constructor(getSettings: () => LanSyncSettings) {
		this.getSettings = getSettings;
	}

	get baseUrl(): string {
		return this.resolveBaseUrl(this.getSettings());
	}

	async ping(): Promise<PingResponse> {
		const response = await this.send({
			url: `${this.baseUrl}/api/ping`,
			method: 'GET',
			headers: this.authHeaders(),
			timeoutMs: Math.min(this.getSettings().requestTimeoutMs, 15000),
		});
		const payload = response.json as Partial<PingResponse> | null;
		if (!payload || payload.status !== 'ok' || typeof payload.deviceName !== 'string') {
			throw new SyncClientError(
				t(
					'The server returned an unexpected response to /api/ping.',
					'Сервер вернул неожиданный ответ на /api/ping.',
				),
			);
		}
		return {
			status: 'ok',
			deviceName: payload.deviceName,
			version: typeof payload.version === 'string' ? payload.version : 'unknown',
		};
	}

	async fetchDiff(manifest: VaultManifest): Promise<SyncDiff> {
		const settings = this.getSettings();
		const response = await this.send({
			url: `${this.baseUrl}/api/sync/diff`,
			method: 'POST',
			headers: this.authHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify(manifest),
			contentType: 'application/json',
			// Первый reconcile на ПК может хешировать всё хранилище.
			timeoutMs: Math.max(settings.requestTimeoutMs, 120000),
		});
		const payload = response.json as Partial<SyncDiff> | null;
		if (
			!payload
			|| !Array.isArray(payload.fileConflicts)
			|| !Array.isArray(payload.contentDiffs)
		) {
			throw new SyncClientError(
				t(
					'The server returned an invalid SyncDiff object.',
					'Сервер вернул некорректный объект SyncDiff.',
				),
			);
		}
		return {
			generatedAt: typeof payload.generatedAt === 'number' ? payload.generatedAt : Date.now(),
			serverDeviceName: typeof payload.serverDeviceName === 'string'
				? payload.serverDeviceName
				: t('Desktop', 'ПК'),
			fileConflicts: payload.fileConflicts,
			contentDiffs: payload.contentDiffs,
		};
	}

	async downloadFile(path: string): Promise<DownloadedFile> {
		const settings = this.getSettings();
		const response = await this.send({
			url: `${this.baseUrl}/api/file?path=${encodeURIComponent(path)}`,
			method: 'GET',
			headers: this.authHeaders(),
			timeoutMs: Math.max(settings.requestTimeoutMs, 120000),
		});
		const data = response.arrayBuffer;
		const headerSha = this.headerValue(response.headers, 'x-file-sha256');
		const headerMtime = Number(this.headerValue(response.headers, 'x-file-mtime') ?? '0');
		let sha256 = headerSha;
		if (sha256) {
			const actual = await sha256Hex(data);
			if (actual !== sha256) {
				throw new SyncClientError(
					t(
						'Checksum for “{path}” does not match: the data was corrupted in transit.',
						'Контрольная сумма файла «{path}» не совпала: данные повреждены при передаче.',
						{ path },
					),
					undefined,
					'sha_mismatch',
				);
			}
		} else {
			sha256 = await sha256Hex(data);
		}
		return {
			data,
			sha256,
			mtime: Number.isFinite(headerMtime) && headerMtime > 0 ? headerMtime : Date.now(),
			size: data.byteLength,
		};
	}

	async uploadFile(path: string, data: ArrayBuffer, deviceName: string): Promise<FileMetadata> {
		const settings = this.getSettings();
		const response = await this.send({
			url: `${this.baseUrl}/api/file?path=${encodeURIComponent(path)}`,
			method: 'POST',
			headers: this.authHeaders({
				'X-Device-Id': settings.deviceId,
				'X-Device-Name': encodeURIComponent(deviceName),
			}),
			body: data,
			contentType: 'application/octet-stream',
			timeoutMs: Math.max(settings.requestTimeoutMs, 180000),
		});
		return this.parseMetadata(response, path);
	}

	async tombstoneFile(path: string, deviceName: string): Promise<FileMetadata | null> {
		const settings = this.getSettings();
		const response = await this.send({
			url: `${this.baseUrl}/api/file/tombstone`,
			method: 'POST',
			headers: this.authHeaders({
				'Content-Type': 'application/json',
				'X-Device-Id': settings.deviceId,
				'X-Device-Name': encodeURIComponent(deviceName),
			}),
			body: JSON.stringify({ path }),
			contentType: 'application/json',
			timeoutMs: this.getSettings().requestTimeoutMs,
		});
		const payload = response.json as Partial<FileMetadata> | null;
		if (!payload || typeof payload.path !== 'string') {
			return null;
		}
		return payload as FileMetadata;
	}

	private parseMetadata(response: RequestUrlResponse, fallbackPath: string): FileMetadata {
		const payload = response.json as Partial<FileMetadata> | null;
		if (!payload || typeof payload.sha256 !== 'string' || !payload.sha256) {
			throw new SyncClientError(
				t(
					'The server did not return metadata for “{path}”.',
					'Сервер не вернул метаданные файла «{path}».',
					{ path: fallbackPath },
				),
			);
		}
		return {
			path: typeof payload.path === 'string' && payload.path ? payload.path : fallbackPath,
			sha256: payload.sha256,
			mtime: typeof payload.mtime === 'number' ? payload.mtime : Date.now(),
			size: typeof payload.size === 'number' ? payload.size : 0,
			status: 'active',
			lastModifiedDevice: typeof payload.lastModifiedDevice === 'string'
				? payload.lastModifiedDevice
				: t('Desktop', 'ПК'),
		};
	}

	private authHeaders(extra?: Record<string, string>): Record<string, string> {
		const token = this.getSettings().clientToken.trim();
		if (!token) {
			throw new SyncClientError(
				t(
					'No auth token. Import the connection string from the desktop.',
					'Не указан токен авторизации. Импортируйте строку подключения с ПК.',
				),
				undefined,
				'no_token',
			);
		}
		return { Authorization: `Bearer ${token}`, ...extra };
	}

	private async send(options: SendOptions): Promise<RequestUrlResponse> {
		let target: URL;
		try {
			target = new URL(options.url);
		} catch {
			throw new SyncClientError(
				t(
					'Invalid server address: {url}. Enter an IP or hostname without spaces.',
					'Некорректный адрес сервера: {url}. Укажите IP или имя хоста без пробелов.',
					{ url: options.url },
				),
				undefined,
				'bad_url',
			);
		}
		let response: RequestUrlResponse;
		try {
			response = await withTimeout(
				requestUrl({
					url: options.url,
					method: options.method,
					headers: options.headers,
					body: options.body,
					contentType: options.contentType,
					throw: false,
				}),
				options.timeoutMs,
				t(
					'Request to {host} timed out ({seconds} s).',
					'Таймаут запроса к {host} ({seconds} с).',
					{ host: target.host, seconds: Math.round(options.timeoutMs / 1000) },
				),
			);
		} catch (error) {
			if (error instanceof SyncClientError) {
				throw error;
			}
			throw new SyncClientError(
				t(
					'Could not connect to {host}. Check that the desktop is on the same network, the server is running, and the IP and port are correct. ({error})',
					'Не удалось подключиться к {host}. Проверьте, что ПК в той же сети, сервер запущен, IP и порт верны. ({error})',
					{ host: target.host, error: errorMessage(error) },
				),
				undefined,
				'network_error',
			);
		}
		if (response.status >= 200 && response.status < 300) {
			return response;
		}
		throw this.toApiError(response, target.host);
	}

	private toApiError(response: RequestUrlResponse, host: string): SyncClientError {
		let message = t(
			'Server {host} returned HTTP {status}.',
			'Сервер {host} вернул HTTP {status}.',
			{ host, status: response.status },
		);
		let code: string | undefined;
		try {
			const body = response.json as { message?: unknown; code?: unknown } | null;
			if (body && typeof body.message === 'string' && body.message.trim()) {
				message = body.message;
			}
			if (body && typeof body.code === 'string') {
				code = body.code;
			}
		} catch {
			// The body is not JSON; keep the generic message.
		}
		if (response.status === 401) {
			message = t(
				'Invalid authorization token. Compare it with the desktop settings.',
				'Неверный токен авторизации. Сверьте токен с настройками ПК.',
			);
		} else if (response.status === 403) {
			message = t('Access denied: {message}', 'Доступ запрещён: {message}', { message });
		} else if (response.status === 404) {
			message = t('Not found on the server: {message}', 'Не найдено на сервере: {message}', {
				message,
			});
		} else if (response.status === 413) {
			message = t(
				'File is too large to sync: {message}',
				'Файл слишком велик для синхронизации: {message}',
				{ message },
			);
		}
		return new SyncClientError(message, response.status, code);
	}

	private resolveBaseUrl(settings: LanSyncSettings): string {
		const raw = settings.clientHost.trim();
		if (!raw) {
			throw new SyncClientError(
				t(
					'No desktop address. Import a connection string or enter the IP manually.',
					'Не указан адрес ПК. Импортируйте строку подключения или введите IP вручную.',
				),
				undefined,
				'no_host',
			);
		}
		let scheme = 'http';
		let rest = raw;
		const schemeMatch = /^(https?):\/\//i.exec(raw);
		if (schemeMatch) {
			scheme = schemeMatch[1].toLowerCase();
			rest = raw.slice(schemeMatch[0].length);
		}
		rest = rest.replace(/\/+$/, '');
		if (!rest) {
			throw new SyncClientError(
				t('Desktop address is empty.', 'Адрес ПК пуст.'),
				undefined,
				'no_host',
			);
		}
		if (rest.includes('/') && !rest.startsWith('[')) {
			throw new SyncClientError(
				t(
					'Enter only a host or IP without a path, for example 192.168.1.5.',
					'Укажите только хост или IP без пути, например 192.168.1.5.',
				),
				undefined,
				'bad_host',
			);
		}

		let host = rest;
		let port = settings.clientPort;
		const withPort = /^\[([^\]]+)\]:(\d+)$/.exec(rest) ?? /^([^:]+):(\d+)$/.exec(rest);
		if (withPort) {
			host = withPort[1];
			port = Number(withPort[2]);
		}
		if (!isValidPort(port)) {
			throw new SyncClientError(
				t(
					'Port must be an integer between 1 and 65535.',
					'Порт должен быть целым числом от 1 до 65535.',
				),
				undefined,
				'bad_port',
			);
		}
		if (host.includes(':') && !host.startsWith('[')) {
			host = `[${host}]`;
		}
		return `${scheme}://${host}:${port}`;
	}

	private headerValue(headers: Record<string, string>, name: string): string | undefined {
		const direct = headers[name];
		if (typeof direct === 'string') {
			return direct;
		}
		const lowered = name.toLowerCase();
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === lowered) {
				return value;
			}
		}
		return undefined;
	}
}

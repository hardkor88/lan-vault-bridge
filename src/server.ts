import { Platform } from 'obsidian';
import type { App } from 'obsidian';
import { computeSyncDiff, normalizeManifest, sha256Hex } from './manifest';
import type { ManifestManager } from './manifest';
import type { LanSyncSettings, PingResponse } from './types';
import {
	baseName,
	clampPort,
	errorMessage,
	formatBytes,
	isPathIgnored,
	normalizeVaultPath,
	safeEqual,
} from './utils';
import { t } from './i18n';
import { debugLog, errorLog, warnLog } from './logger';
/*
 * Минимальные структурные типы Node.js http. Мы не импортируем 'http' статически:
 * на мобильном Obsidian модуля нет, поэтому require('http') вызывается только
 * внутри start() и только когда window.require действительно существует (Electron).
 */
interface NodeSocket {
	destroy(): void;
	on(event: string, listener: () => void): void;
}

interface NodeIncomingMessage {
	method?: string;
	url?: string;
	headers: Record<string, string | string[] | undefined>;
	on(event: 'data', listener: (chunk: Uint8Array) => void): this;
	on(event: 'end', listener: () => void): this;
	on(event: 'error', listener: (error: Error) => void): this;
	on(event: 'aborted', listener: () => void): this;
}

interface NodeServerResponse {
	statusCode: number;
	headersSent: boolean;
	writableEnded: boolean;
	setHeader(name: string, value: string | number): void;
	end(data?: Uint8Array | string): void;
	on(event: 'close', listener: () => void): this;
}

interface NodeError extends Error {
	code?: string;
}

interface NodeHttpServer {
	listening: boolean;
	listen(port: number, host: string, callback: () => void): void;
	close(callback?: (error?: Error) => void): void;
	closeAllConnections?(): void;
	on(event: 'connection', listener: (socket: NodeSocket) => void): void;
	on(event: 'error', listener: (error: NodeError) => void): void;
	once(event: 'error', listener: (error: NodeError) => void): void;
}

interface NodeHttpModule {
	createServer(
		handler: (request: NodeIncomingMessage, response: NodeServerResponse) => void,
	): NodeHttpServer;
}

class HttpError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, message: string, code = 'http_error') {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.code = code;
	}
}

const CORS_ALLOW_HEADERS = [
	'Authorization',
	'Content-Type',
	'X-File-Path',
	'X-Device-Id',
	'X-Device-Name',
].join(', ');

/**
 * HTTP-сервер, который живёт только на desktop-версии Obsidian.
 * Работает через Vault API, поэтому одинаково ведёт себя на Windows/macOS/Linux.
 */
export class DesktopSyncServer {
	private readonly app: App;
	private readonly manager: ManifestManager;
	private readonly getSettings: () => LanSyncSettings;
	private readonly pluginVersion: string;
	private server: NodeHttpServer | null = null;
	private port = 0;
	private readonly sockets = new Set<NodeSocket>();

	constructor(
		app: App,
		manager: ManifestManager,
		getSettings: () => LanSyncSettings,
		pluginVersion: string,
	) {
		this.app = app;
		this.manager = manager;
		this.getSettings = getSettings;
		this.pluginVersion = pluginVersion;
	}

	get isRunning(): boolean {
		return this.server !== null;
	}

	getPort(): number {
		return this.port;
	}

	async start(): Promise<number> {
		if (this.server) {
			return this.port;
		}
		if (!Platform.isDesktop) {
			throw new Error(
				t(
					'The LAN server is available only in the desktop version of Obsidian.',
					'LAN-сервер доступен только в desktop-версии Obsidian.',
				),
			);
		}
		const requireFn = window.require;
		if (typeof requireFn !== 'function') {
			throw new Error(
				t(
					'Node.js API is unavailable. The LAN server can only run in the desktop version of Obsidian.',
					'Node.js API недоступен. LAN-сервер можно запустить только в desktop-версии Obsidian.',
				),
			);
		}
		let http: NodeHttpModule;
		try {
			http = requireFn('http') as NodeHttpModule;
		} catch (error) {
			throw new Error(
				t(
					'Failed to load the Node.js http module: {error}',
					'Не удалось загрузить Node.js-модуль http: {error}',
					{ error: errorMessage(error) },
				),
			);
		}
		if (!http || typeof http.createServer !== 'function') {
			throw new Error(
				t(
					'The http module loaded but does not contain createServer().',
					'Модуль http загрузился, но не содержит createServer().',
				),
			);
		}

		const settings = this.getSettings();
		const port = clampPort(settings.serverPort);
		const server = http.createServer((request, response) => {
			void this.handleRequest(request, response).catch((error: unknown) => {
				errorLog('Unhandled request error.', error);
				if (!response.writableEnded) {
					this.sendError(response, 500, errorMessage(error), 'internal_error');
				}
			});
		});
		server.on('connection', (socket) => {
			this.sockets.add(socket);
			socket.on('close', () => {
				this.sockets.delete(socket);
			});
		});

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) {
					return;
				}
				settled = true;
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};
			server.once('error', (error) => {
				finish(new Error(this.describeListenError(error, port)));
			});
			try {
				server.listen(port, '0.0.0.0', () => {
					finish();
				});
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});

		server.on('error', (error) => {
			errorLog('HTTP server error.', error);
		});

		this.server = server;
		this.port = port;
		debugLog(`LAN server listening on 0.0.0.0:${port}`);
		return port;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		this.port = 0;
		if (!server) {
			return;
		}
		try {
			server.closeAllConnections?.();
		} catch (error) {
			warnLog('closeAllConnections failed.', error);
		}
		for (const socket of this.sockets) {
			try {
				socket.destroy();
			} catch {
				// сокет уже закрыт
			}
		}
		this.sockets.clear();
		await new Promise<void>((resolve) => {
			let done = false;
			let timer = 0;
			const finish = (): void => {
				if (done) {
					return;
				}
				done = true;
				window.clearTimeout(timer);
				resolve();
			};
			timer = window.setTimeout(finish, 1500);
			try {
				server.close(() => finish());
			} catch {
				finish();
			}
		});
	}

	private async handleRequest(
		request: NodeIncomingMessage,
		response: NodeServerResponse,
	): Promise<void> {
		this.applyCors(response);
		if (request.method === 'OPTIONS') {
			response.statusCode = 204;
			response.end();
			return;
		}
		try {
			this.assertAuthorized(request);
			const url = new URL(request.url ?? '/', 'http://localhost');
			const route = url.pathname.replace(/\/+$/, '') || '/';

			if (route === '/api/ping') {
				this.requireMethod(request, response, 'GET');
				const payload: PingResponse = {
					status: 'ok',
					deviceName: this.manager.deviceName,
					version: this.pluginVersion,
				};
				this.sendJson(response, 200, payload);
				return;
			}

			if (route === '/api/sync/diff') {
				this.requireMethod(request, response, 'POST');
				await this.handleDiff(request, response);
				return;
			}

			if (route === '/api/file/tombstone') {
				this.requireMethod(request, response, 'POST');
				await this.handleTombstone(url, request, response, false);
				return;
			}

			if (route === '/api/file') {
				if (request.method === 'GET') {
					await this.handleGetFile(url, response);
					return;
				}
				if (request.method === 'POST') {
					await this.handleUploadFile(url, request, response);
					return;
				}
				if (request.method === 'DELETE') {
					await this.handleTombstone(url, request, response, true);
					return;
				}
				response.setHeader('Allow', 'GET, POST, DELETE');
				throw new HttpError(
					405,
					t('Method not allowed.', 'Метод не поддерживается'),
					'method_not_allowed',
				);
			}

			throw new HttpError(
				404,
				t('Route “{route}” was not found.', 'Маршрут «{route}» не найден', { route }),
				'not_found',
			);
		} catch (error) {
			if (response.writableEnded) {
				return;
			}
			if (error instanceof HttpError) {
				this.sendError(response, error.status, error.message, error.code);
				return;
			}
			errorLog('Request handling failed.', error);
			this.sendError(response, 500, errorMessage(error), 'internal_error');		}
	}

	private applyCors(response: NodeServerResponse): void {
		response.setHeader('Access-Control-Allow-Origin', '*');
		response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
		response.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
		response.setHeader(
			'Access-Control-Expose-Headers',
			'X-File-Mtime, X-File-Sha256, X-File-Size, Content-Length',
		);
		response.setHeader('Access-Control-Max-Age', '86400');
		response.setHeader('Cache-Control', 'no-store');
	}

	private assertAuthorized(request: NodeIncomingMessage): void {
		const expected = this.getSettings().authToken.trim();
		if (!expected) {
			throw new HttpError(
				503,
				t(
					'No authorization token is configured on the desktop. Open the {plugin} settings.',
					'На ПК не сгенерирован токен авторизации. Откройте настройки {plugin}.',
					{ plugin: 'LAN Vault Bridge' },
				),
				'server_not_paired',
			);
		}
		const header = request.headers.authorization;
		const value = Array.isArray(header) ? header[0] : header;
		if (typeof value !== 'string' || !value.toLowerCase().startsWith('bearer ')) {
			throw new HttpError(
				401,
				t(
					'The Authorization: Bearer <token> header is required.',
					'Требуется заголовок Authorization: Bearer <token>',
				),
				'unauthorized',
			);
		}
		const provided = value.slice(7).trim();
		if (!safeEqual(provided, expected)) {
			throw new HttpError(
				401,
				t('Invalid authorization token.', 'Неверный токен авторизации'),
				'unauthorized',
			);
		}
	}

	private requireMethod(
		request: NodeIncomingMessage,
		response: NodeServerResponse,
		...allowed: string[]
	): void {
		if (!request.method || !allowed.includes(request.method)) {
			response.setHeader('Allow', allowed.join(', '));
			throw new HttpError(
				405,
				t('Method not allowed.', 'Метод не поддерживается'),
				'method_not_allowed',
			);
		}
	}

	private async handleDiff(
		request: NodeIncomingMessage,
		response: NodeServerResponse,
	): Promise<void> {
		const body = await this.readJson(request, 32 * 1024 * 1024);
		const remote = normalizeManifest(body);
		if (!remote) {
			throw new HttpError(
				400,
				t('Invalid client manifest.', 'Некорректный манифест клиента'),
				'invalid_manifest',
			);
		}
		await this.manager.reconcile();
		const diff = computeSyncDiff(remote, this.manager.snapshot(), this.manager.deviceName);
		this.sendJson(response, 200, diff);
	}

	private async handleGetFile(url: URL, response: NodeServerResponse): Promise<void> {
		const path = this.getPathParam(url);
		const stat = await this.manager.stat(path);
		const data = await this.manager.readBinary(path);
		if (!stat || stat.type !== 'file' || !data) {
			throw new HttpError(
				404,
				t('File “{path}” was not found on the desktop.', 'Файл «{path}» не найден на ПК', {
					path,
				}),
				'file_not_found',
			);
		}
		const maxBytes = this.maxPayloadBytes();
		if (stat.size > maxBytes) {
			throw new HttpError(
				413,
				t(
					'File “{path}” ({size}) exceeds the {limit} limit.',
					'Файл «{path}» ({size}) больше лимита {limit}',
					{
						path,
						size: formatBytes(stat.size),
						limit: formatBytes(maxBytes),
					},
				),
				'file_too_large',
			);
		}
		const sha256 = await sha256Hex(data);
		await this.manager.recordFileState(
			path,
			sha256,
			stat.mtime,
			data.byteLength,
			this.manager.deviceName,
			false,
		);

		response.statusCode = 200;
		response.setHeader('Content-Type', 'application/octet-stream');
		response.setHeader('Content-Length', String(data.byteLength));
		response.setHeader('X-File-Mtime', String(stat.mtime));
		response.setHeader('X-File-Sha256', sha256);
		response.setHeader('X-File-Size', String(data.byteLength));
		response.setHeader(
			'Content-Disposition',
			`attachment; filename*=UTF-8''${encodeURIComponent(baseName(path))}`,
		);
		response.end(new Uint8Array(data));
	}

	private async handleUploadFile(
		url: URL,
		request: NodeIncomingMessage,
		response: NodeServerResponse,
	): Promise<void> {
		const path = this.getPathParam(url);
		const maxBytes = this.maxPayloadBytes();
		const declaredLength = request.headers['content-length'];
		const declared = Array.isArray(declaredLength) ? declaredLength[0] : declaredLength;
		if (declared && Number(declared) > maxBytes) {
			throw new HttpError(
				413,
				t(
					'File exceeds the {limit} limit.',
					'Файл больше лимита {limit}',
					{ limit: formatBytes(maxBytes) },
				),
				'file_too_large',
			);
		}
		const data = await this.readBody(request, maxBytes);
		const stat = await this.manager.writeBinaryFile(path, data);
		const sha256 = await sha256Hex(data);
		const metadata = await this.manager.recordFileState(
			path,
			sha256,
			stat?.mtime ?? Date.now(),
			data.byteLength,
			this.getDeviceLabel(request),
		);
		this.sendJson(response, 200, metadata);
	}

	private async handleTombstone(
		url: URL,
		request: NodeIncomingMessage,
		response: NodeServerResponse,
		pathFromQuery: boolean,
	): Promise<void> {
		let path: string;
		if (pathFromQuery) {
			path = this.getPathParam(url);
		} else {
			const body = await this.readJson(request, 64 * 1024);
			if (!body || typeof body !== 'object' || Array.isArray(body)) {
				throw new HttpError(
					400,
					t(
						'Expected a JSON object { "path": "..." }.',
						'Ожидался JSON-объект { "path": "..." }',
					),
					'invalid_body',
				);
			}
			const record = body as Record<string, unknown>;
			if (typeof record.path !== 'string') {
				throw new HttpError(
					400,
					t(
						'The request body is missing the path field.',
						'В теле запроса отсутствует поле path',
					),
					'missing_path',
				);
			}
			path = this.assertSafePath(record.path);
		}

		const stat = await this.manager.stat(path);
		if (stat?.type === 'folder') {
			throw new HttpError(
				400,
				t(
					'Deleting folders through the API is not supported.',
					'Удаление папок через API не поддерживается',
				),
				'is_folder',
			);
		}
		if (stat?.type === 'file') {
			await this.manager.removeLocal(path);
		}
		const metadata = await this.manager.markTombstone(
			path,
			this.getDeviceLabel(request),
			true,
		);
		this.sendJson(response, 200, metadata ?? { status: 'ok', path });
	}

	private getPathParam(url: URL): string {
		const raw = url.searchParams.get('path');
		if (!raw) {
			throw new HttpError(
				400,
				t('The path parameter is required.', 'Параметр path обязателен'),
				'missing_path',
			);
		}
		return this.assertSafePath(raw);
	}

	private assertSafePath(raw: string): string {
		const trimmed = raw.trim();
		if (!trimmed) {
			throw new HttpError(400, t('Empty path.', 'Пустой путь'), 'invalid_path');
		}
		if (
			trimmed.startsWith('/')
			|| trimmed.startsWith('\\')
			|| /^[a-zA-Z]:[\\/]/.test(trimmed)
			|| trimmed.includes('\0')
		) {
			throw new HttpError(
				400,
				t(
					'Invalid path: expected a path relative to the vault.',
					'Недопустимый путь: ожидается путь относительно хранилища',
				),
				'invalid_path',
			);
		}
		const normalized = normalizeVaultPath(trimmed);
		if (!normalized || normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
			throw new HttpError(
				400,
				t(
					'Invalid path: it escapes the vault.',
					'Недопустимый путь: выход за пределы хранилища',
				),
				'invalid_path',
			);
		}
		const settings = this.getSettings();
		if (isPathIgnored(normalized, this.app.vault.configDir, settings.excludedFolders)) {
			throw new HttpError(
				403,
				t('Path is excluded from sync.', 'Путь исключён из синхронизации'),
				'path_forbidden',
			);
		}
		return normalized;
	}

	private getDeviceLabel(request: NodeIncomingMessage): string {
		const raw = request.headers['x-device-name'] ?? request.headers['x-device-id'];
		const value = Array.isArray(raw) ? raw[0] : raw;
		if (typeof value === 'string' && value.trim()) {
			let decoded = value.trim();
			try {
				decoded = decodeURIComponent(decoded);
			} catch {
				// Имя пришло без percent-encoding — используем как есть.
			}
			return decoded.slice(0, 120);
		}
		return t('LAN client', 'LAN-клиент');
	}

	private maxPayloadBytes(): number {
		const megabytes = Math.max(1, this.getSettings().maxFileSizeMb);
		return megabytes * 1024 * 1024;
	}

	private readJson(request: NodeIncomingMessage, limit: number): Promise<unknown> {
		return this.readBody(request, limit).then((data) => {
			const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
			if (!text.trim()) {
				throw new HttpError(
					400,
					t('Empty request body.', 'Пустое тело запроса'),
					'empty_body',
				);
			}
			try {
				return JSON.parse(text) as unknown;
			} catch {
				throw new HttpError(
					400,
					t('Invalid JSON in the request body.', 'Некорректный JSON в теле запроса'),
					'invalid_json',
				);
			}
		});
	}

	private readBody(request: NodeIncomingMessage, limit: number): Promise<ArrayBuffer> {
		return new Promise<ArrayBuffer>((resolve, reject) => {
			const chunks: Uint8Array[] = [];
			let total = 0;
			let settled = false;
			const fail = (error: Error): void => {
				if (settled) {
					return;
				}
				settled = true;
				reject(error);
			};
			request.on('data', (chunk) => {
				if (settled) {
					return;
				}
				total += chunk.byteLength;
				if (total > limit) {
					fail(
						new HttpError(
							413,
							t(
								'Request body exceeds the {limit} limit.',
								'Тело запроса превышает лимит {limit}',
								{ limit: formatBytes(limit) },
							),
							'payload_too_large',
						),
					);
					return;
				}
				chunks.push(chunk);
			});
			request.on('end', () => {
				if (settled) {
					return;
				}
				settled = true;
				const result = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					result.set(chunk, offset);
					offset += chunk.byteLength;
				}
				resolve(result.buffer as ArrayBuffer);
			});
			request.on('error', (error) => {
				fail(error);
			});
			request.on('aborted', () => {
				fail(new Error(t('Connection was aborted by the client.', 'Соединение прервано клиентом')));
			});
		});
	}

	private sendJson(response: NodeServerResponse, status: number, payload: unknown): void {
		if (response.writableEnded) {
			return;
		}
		const bytes = new TextEncoder().encode(JSON.stringify(payload));
		response.statusCode = status;
		response.setHeader('Content-Type', 'application/json; charset=utf-8');
		response.setHeader('Content-Length', String(bytes.byteLength));
		response.end(bytes);
	}

	private sendError(
		response: NodeServerResponse,
		status: number,
		message: string,
		code: string,
	): void {
		this.sendJson(response, status, { status: 'error', message, code });
	}

	private describeListenError(error: NodeError, port: number): string {
		if (error.code === 'EADDRINUSE') {
			return t(
				'Port {port} is already in use. Close the application using it or change the port in {plugin} settings.',
				'Порт {port} уже занят. Закройте программу, использующую его, или смените порт в настройках {plugin}.',
				{ port, plugin: 'LAN Vault Bridge' },
			);
		}
		if (error.code === 'EACCES') {
			return t(
				'No permission to listen on port {port}. Choose a port above 1024.',
				'Нет прав на прослушивание порта {port}. Выберите порт больше 1024.',
				{ port },
			);
		}
		return t(
			'Could not start the LAN server on port {port}: {error}',
			'Не удалось запустить LAN-сервер на порту {port}: {error}',
			{ port, error: error.message },
		);
	}
}

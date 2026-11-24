import type { App, SettingDefinitionItem, TextAreaComponent } from 'obsidian';
import { Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import QRCode from 'qrcode';
import type LanSyncPlugin from './main';
import type { LanSyncSettings, UiLanguage } from './types';
import { confirmAction } from './ui/ConfirmModal';
import { setUiLanguage, t } from './i18n';
import { setDebugLogging } from './logger';
import {
	connectionJson,
	copyText,
	detectLocalAddresses,
	errorMessage,
	isValidPort,
	parseConnectionPayload,
	randomHex,
} from './utils';

const PLUGIN_NAME = 'LAN Vault Bridge';

export class LanSyncSettingTab extends PluginSettingTab {
	private readonly plugin: LanSyncPlugin;
	private qrContainer: HTMLElement | null = null;
	private qrAddress: string | null = null;
	private importValue = '';

	constructor(app: App, plugin: LanSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		const items: SettingDefinitionItem[] = [
			{
				type: 'group',
				heading: t('This device', 'Это устройство'),
				items: [
					{
						name: t('Device name', 'Имя устройства'),
						desc: t(
							'Stored in the manifest and shown in the conflict review window.',
							'Попадает в манифест и в интерфейс разрешения конфликтов.',
						),
						control: {
							type: 'text' as const,
							key: 'deviceName',
							placeholder: t('Windows desktop', 'Windows-ПК'),
						},
					},
					{
						name: t('Interface language', 'Язык интерфейса'),
						desc: t(
							'Auto follows the Obsidian display language.',
							'«Авто» следует языку интерфейса Obsidian.',
						),
						render: (setting) => this.renderLanguage(setting),
					},
				],
			},
		];

		if (Platform.isDesktop) {
			items.push({
				type: 'group',
				heading: t('Server on this desktop', 'Сервер на этом ПК'),
				items: [
					{
						name: t('Server status', 'Состояние сервера'),
						desc: this.serverStatusText(),
						render: (setting) => this.renderServerStatus(setting),
					},
					{
						name: t('Start server when Obsidian launches', 'Запускать сервер при старте Obsidian'),
						desc: t(
							'The server listens on 0.0.0.0 and is reachable by other devices on the same network.',
							'Сервер слушает 0.0.0.0 и доступен другим устройствам в этой же сети.',
						),
						control: { type: 'toggle' as const, key: 'serverEnabled' },
					},
					{
						name: t('Server port', 'Порт сервера'),
						desc: t(
							'Default is 27123. Must match the port configured on the phone.',
							'По умолчанию 27123. Должен совпадать с портом в настройках телефона.',
						),
						control: {
							type: 'number' as const,
							key: 'serverPort',
							min: 1024,
							max: 65535,
							step: 1,
							validate: (value: number) => {
								if (!isValidPort(value) || value < 1024) {
									return t(
										'Enter a port between 1024 and 65535.',
										'Укажите порт от 1024 до 65535.',
									);
								}
								return undefined;
							},
						},
					},
					{
						name: t('Authorization token', 'Токен авторизации'),
						desc: t(
							'32 hex characters. Shared secret for the Authorization: Bearer header. Stored in the plugin data.json.',
							'32 hex-символа. Общий секрет для заголовка Authorization: Bearer. Хранится в data.json плагина.',
						),
						control: { type: 'text' as const, key: 'authToken' },
					},
					{
						name: t('Token actions', 'Действия с токеном'),
						desc: t(
							'Copy or regenerate the token. Regenerating disconnects existing phones.',
							'Скопировать или перегенерировать токен. После перегенерации телефоны нужно переподключить.',
						),
						render: (setting) => this.renderTokenActions(setting),
					},
				],
			});

			items.push({
				type: 'group',
				heading: t('Pairing a phone', 'Сопряжение телефона'),
				items: [
					{
						name: t('Address and QR code', 'Адрес и QR-код'),
						desc: t(
							'Choose the local IPv4 address and scan the QR code with the phone.',
							'Выберите локальный IPv4-адрес и отсканируйте QR-код телефоном.',
						),
						render: (setting) => this.renderPairing(setting),
					},
				],
			});
		}

		items.push({
			type: 'group',
			heading: Platform.isMobile
				? t('Connect to a desktop', 'Подключение к ПК')
				: t('Client: connect to a desktop', 'Клиент: подключение к ПК'),
			items: [
				{
					name: t('Quick import', 'Быстрый импорт'),
					desc: t(
						'Paste the JSON connection string from the desktop, or use "Paste from clipboard".',
						'Вставьте JSON-строку из настроек ПК или нажмите «Вставить из буфера».',
					),
					render: (setting) => this.renderQuickImport(setting),
				},
				{
					name: t('Host/IP', 'IP-адрес ПК'),
					desc: t(
						'Desktop IP address on the local network. You can paste it with the port: 192.168.1.5:27123.',
						'IP-адрес ПК в локальной сети. Можно вставить вместе с портом: 192.168.1.5:27123.',
					),
					control: {
						type: 'text' as const,
						key: 'clientHost',
						placeholder: '192.168.1.5',
					},
				},
				{
					name: t('Port', 'Порт'),
					desc: t(
						'LAN server port on the desktop (default 27123).',
						'Порт LAN-сервера на ПК (по умолчанию 27123).',
					),
					control: {
						type: 'number' as const,
						key: 'clientPort',
						min: 1,
						max: 65535,
						step: 1,
						validate: (value: number) => {
							if (!isValidPort(value)) {
								return t(
									'Enter a port between 1 and 65535.',
									'Укажите порт от 1 до 65535.',
								);
							}
							return undefined;
						},
					},
				},
				{
					name: t('Auth token', 'Токен'),
					desc: t(
						'Token from the desktop (32 hex characters).',
						'Токен с ПК (32 hex-символа).',
					),
					control: { type: 'text' as const, key: 'clientToken' },
				},
				{
					name: t('Test connection', 'Проверка соединения'),
					desc: t(
						'GET /api/ping with the current token. Checks that the desktop is reachable and the token is correct.',
						'GET /api/ping с текущим токеном. Проверяет доступность ПК и правильность токена.',
					),
					render: (setting) => this.renderTestConnection(setting),
				},
				{
					name: t('Sync', 'Синхронизация'),
					desc: t(
						'Scans the vault, compares it with the desktop and opens the conflict review window.',
						'Сканирует хранилище, сравнивает с ПК и открывает окно разрешения конфликтов.',
					),
					render: (setting) => this.renderSyncNow(setting),
				},
			],
		});

		const configDir = this.app.vault.configDir;
		items.push({
			type: 'group',
			heading: t('Sync options', 'Параметры синхронизации'),
			items: [
				{
					name: t('Excluded folders', 'Исключённые папки'),
					desc: t(
						'One per line, relative to the vault root. The {configDir} folder is always ignored.',
						'По одной на строку. Пути относительно корня хранилища. Папка {configDir} игнорируется всегда.',
						{ configDir },
					),
					control: {
						type: 'textarea' as const,
						key: 'excludedFolders',
						rows: 4,
						placeholder: t('Archive\nTemplates', 'Архив\nШаблоны'),
					},
				},
				{
					name: t('Maximum file size', 'Максимальный размер файла'),
					desc: t(
						'In megabytes. Files above the limit are excluded from the manifest and are not transferred.',
						'В мегабайтах. Файлы больше лимита не попадают в манифест и не передаются.',
					),
					control: {
						type: 'number' as const,
						key: 'maxFileSizeMb',
						min: 1,
						max: 500,
						step: 1,
						validate: (value: number) => {
							if (!Number.isFinite(value) || value < 1 || value > 500) {
								return t(
									'Enter a value between 1 and 500 MB.',
									'Укажите значение от 1 до 500 МБ.',
								);
							}
							return undefined;
						},
					},
				},
				{
					name: t('Request timeout', 'Таймаут запроса'),
					desc: t(
						'In seconds. File transfers use a larger timeout automatically.',
						'В секундах. Для передачи файлов таймаут увеличивается автоматически.',
					),
					control: {
						type: 'number' as const,
						key: 'requestTimeoutSeconds',
						min: 3,
						max: 300,
						step: 1,
						validate: (value: number) => {
							if (!Number.isFinite(value) || value < 3 || value > 300) {
								return t(
									'Enter a value between 3 and 300 seconds.',
									'Укажите значение от 3 до 300 секунд.',
								);
							}
							return undefined;
						},
					},
				},
				{
					name: t('Parallel transfers', 'Параллельные передачи'),
					desc: t(
						'How many files are transferred at once (1–6). Higher is faster but heavier on the network. Default: 4.',
						'Сколько файлов передавать одновременно (1–6). Больше — быстрее, но выше нагрузка на сеть. По умолчанию: 4.',
					),
					control: {
						type: 'number' as const,
						key: 'parallelTransfers',
						min: 1,
						max: 6,
						step: 1,
						validate: (value: number) => {
							if (!Number.isInteger(value) || value < 1 || value > 6) {
								return t(
									'Enter a whole number between 1 and 6.',
									'Укажите целое число от 1 до 6.',
								);
							}
							return undefined;
						},
					},
				},
			],
		});

		items.push({
			type: 'group',
			heading: t('Advanced', 'Дополнительно'),
			items: [
				{
					name: t('Debug logging', 'Отладочный лог'),
					desc: t(
						'Write diagnostic messages to the developer console. Disabled by default.',
						'Писать диагностические сообщения в консоль разработчика. По умолчанию выключено.',
					),
					control: { type: 'toggle' as const, key: 'debugLogging' },
				},
			],
		});

		items.push({
			type: 'group',
			heading: t('Tombstone protection', 'Защита от удаления'),
			items: [
				{
					name: t('Tombstones', 'Tombstone-записи'),
					desc: t(
						'Stored now: {count}. Tombstones prevent deleted files from coming back and are kept indefinitely. Cleaning is irreversible.',
						'Сейчас сохранено: {count}. Записи не дают «воскресить» удалённые файлы и хранятся бессрочно. Очистка необратима.',
						{ count: this.plugin.manager.getTombstoneCount() },
					),
					render: (setting) => this.renderTombstones(setting),
				},
			],
		});

		items.push({
			type: 'group',
			heading: t('About', 'О плагине'),
			items: [
				{
					name: PLUGIN_NAME,
					render: (setting) => this.renderAbout(setting),
				},
			],
		});

		return items;
	}

	override getControlValue(key: string): unknown {
		switch (key) {
			case 'excludedFolders':
				return this.plugin.settings.excludedFolders.join('\n');
			case 'requestTimeoutSeconds':
				return Math.round(this.plugin.settings.requestTimeoutMs / 1000);
			default:
				return (this.plugin.settings as unknown as Record<string, unknown>)[key];
		}
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		switch (key) {
			case 'deviceName': {
				const name = String(value).trim().slice(0, 64);
				if (name) {
					settings.deviceName = name;
				}
				break;
			}
			case 'serverEnabled': {
				settings.serverEnabled = Boolean(value);
				await this.plugin.saveSettings();
				await this.plugin.restartServer();
				this.update();
				return;
			}
			case 'serverPort': {
				const port = Number(value);
				if (!isValidPort(port) || port < 1024) {
					return;
				}
				settings.serverPort = port;
				break;
			}
			case 'authToken': {
				settings.authToken = String(value).trim();
				break;
			}
			case 'clientHost': {
				settings.clientHost = String(value).trim();
				break;
			}
			case 'clientPort': {
				const port = Number(value);
				if (!isValidPort(port)) {
					return;
				}
				settings.clientPort = port;
				break;
			}
			case 'clientToken': {
				settings.clientToken = String(value).trim();
				break;
			}
			case 'excludedFolders': {
				settings.excludedFolders = String(value)
					.split('\n')
					.map((line) => line.trim())
					.filter((line) => line.length > 0);
				break;
			}
			case 'maxFileSizeMb': {
				const megabytes = Number(value);
				if (!Number.isFinite(megabytes) || megabytes < 1 || megabytes > 500) {
					return;
				}
				settings.maxFileSizeMb = Math.round(megabytes);
				break;
			}
			case 'requestTimeoutSeconds': {
				const seconds = Number(value);
				if (!Number.isFinite(seconds) || seconds < 3 || seconds > 300) {
					return;
				}
				settings.requestTimeoutMs = Math.round(seconds * 1000);
				break;
			}
			case 'parallelTransfers': {
				const parallel = Number(value);
				if (!Number.isInteger(parallel) || parallel < 1 || parallel > 6) {
					return;
				}
				settings.parallelTransfers = parallel;
				break;
			}
			case 'debugLogging': {
				settings.debugLogging = Boolean(value);
				setDebugLogging(settings.debugLogging);
				break;
			}
			default:
				return;
		}
		await this.plugin.saveSettings();
		if (key === 'serverPort' || key === 'authToken') {
			this.plugin.scheduleServerRestart();
			void this.updateQr();
		}
	}

	private renderLanguage(setting: Setting): void {
		setting
			.setName(t('Interface language', 'Язык интерфейса'))
			.setDesc(
				t(
					'Auto follows the Obsidian display language.',
					'«Авто» следует языку интерфейса Obsidian.',
				),
			)
			.addDropdown((dropdown) => {
				dropdown.addOption('auto', t('Auto (Obsidian language)', 'Авто (язык Obsidian)'));
				dropdown.addOption('en', 'English');
				dropdown.addOption('ru', 'Русский');
				dropdown.setValue(this.plugin.settings.uiLanguage);
				dropdown.onChange(async (value) => {
					this.plugin.settings.uiLanguage = value as UiLanguage;
					await this.plugin.saveSettings();
					setUiLanguage(this.plugin.settings.uiLanguage);
					this.update();
				});
			});
	}

	private renderServerStatus(setting: Setting): void {
		setting
			.setName(t('Server status', 'Состояние сервера'))
			.setDesc(this.serverStatusText())
			.addButton((button) => {
				button.setButtonText(t('Restart server', 'Перезапустить сервер')).onClick(async () => {
					await this.plugin.restartServer();
					this.update();
				});
			});
	}

	private renderTokenActions(setting: Setting): void {
		setting
			.setName(t('Token actions', 'Действия с токеном'))
			.setDesc(
				t(
					'Copy or regenerate the token. Regenerating disconnects existing phones.',
					'Скопировать или перегенерировать токен. После перегенерации телефоны нужно переподключить.',
				),
			)
			.addExtraButton((button) => {
				button
					.setIcon('copy')
					.setTooltip(t('Copy token', 'Скопировать токен'))
					.onClick(async () => {
						const copied = await copyText(this.plugin.settings.authToken);
						new Notice(
							copied
								? t('Token copied.', 'Токен скопирован.')
								: t('Could not copy the token.', 'Не удалось скопировать токен.'),
						);
					});
			})
			.addButton((button) => {
				button
					.setButtonText(t('Regenerate', 'Перегенерировать'))
					.setDestructive()
					.onClick(async () => {
						this.plugin.settings.authToken = randomHex(16);
						await this.plugin.saveSettings();
						this.plugin.scheduleServerRestart();
						this.update();
						new Notice(
							t(
								'A new token was generated. Reconnect the phone.',
								'Создан новый токен. Переподключите телефон заново.',
							),
						);
					});
			});
	}

	private renderPairing(setting: Setting): void {
		const addresses = detectLocalAddresses();
		setting
			.setName(t('Address and QR code', 'Адрес и QR-код'))
			.setDesc(
				t(
					'Choose the local IPv4 address and scan the QR code with the phone.',
					'Выберите локальный IPv4-адрес и отсканируйте QR-код телефоном.',
				),
			);
		if (addresses.length === 0) {
			this.qrContainer = null;
			setting.setDesc(
				t(
					'Could not determine an external IPv4 address. Check the Wi-Fi or Ethernet connection; for Tailscale or ZeroTier you can enter the address manually.',
					'Не удалось определить внешний IPv4. Проверьте, что ПК подключён к Wi-Fi/Ethernet; для Tailscale/ZeroTier адрес можно ввести вручную.',
				),
			);
			return;
		}
		const primary = addresses[0].address;
		if (!this.qrAddress || !addresses.some((info) => info.address === this.qrAddress)) {
			this.qrAddress = primary;
		}
		setting.setDesc(
			t(
				'All discovered IPv4 addresses: {list}',
				'Все найденные IPv4-адреса: {list}',
				{ list: addresses.map((info) => `${info.address} (${info.iface})`).join(' · ') },
			),
		);
		setting.addDropdown((dropdown) => {
			for (const info of addresses) {
				dropdown.addOption(info.address, `${info.address} · ${info.iface}`);
			}
			dropdown.setValue(this.qrAddress ?? primary);
			dropdown.onChange((value) => {
				this.qrAddress = value;
				void this.updateQr();
			});
		});
		setting.addButton((button) => {
			button
				.setButtonText(t('Copy connection string (JSON)', 'Скопировать строку подключения (JSON)'))
				.onClick(async () => {
					if (!this.qrAddress) {
						return;
					}
					const json = connectionJson(
						this.qrAddress,
						this.plugin.settings.serverPort,
						this.plugin.settings.authToken,
					);
					const copied = await copyText(json);
					new Notice(
						copied
							? t(
									'Connection string copied. Paste it into LAN Vault Bridge settings on the phone.',
									'Строка подключения скопирована. Вставьте её в настройках LAN Vault Bridge на телефоне.',
								)
							: t(
									'Could not copy the connection string.',
									'Не удалось скопировать строку подключения.',
								),
					);
				});
		});
		this.qrContainer = setting.settingEl.createDiv({ cls: 'lan-sync-qr-container' });
		void this.updateQr();
	}

	private renderQuickImport(setting: Setting): void {
		let textArea: TextAreaComponent | null = null;
		setting
			.setName(t('Quick import', 'Быстрый импорт'))
			.setDesc(
				t(
					'Paste the JSON connection string from the desktop, or use "Paste from clipboard".',
					'Вставьте JSON-строку из настроек ПК или нажмите «Вставить из буфера».',
				),
			)
			.addTextArea((text) => {
				textArea = text;
				text.setPlaceholder('{"ip":"192.168.1.5","port":27123,"token":"..."}');
				text.inputEl.rows = 3;
				text.inputEl.addClass('lan-sync-import-area');
				text.setValue(this.importValue);
				text.onChange((value) => {
					this.importValue = value;
				});
			})
			.addButton((button) => {
				button
					.setButtonText(t('Paste from clipboard', 'Вставить из буфера'))
					.onClick(async () => {
						try {
							const text = await navigator.clipboard.readText();
							if (!text.trim()) {
								new Notice(t('The clipboard is empty.', 'Буфер обмена пуст.'));
								return;
							}
							this.importValue = text;
							textArea?.setValue(text);
						} catch (error) {
							new Notice(
								t(
									'No access to the clipboard: {error}',
									'Нет доступа к буферу обмена: {error}',
									{ error: errorMessage(error) },
								),
								6000,
							);
						}
					});
			})
			.addButton((button) => {
				button
					.setButtonText(t('Import', 'Импортировать'))
					.setCta()
					.onClick(async () => {
						try {
							const parsed = parseConnectionPayload(this.importValue);
							this.plugin.settings.clientHost = parsed.ip;
							this.plugin.settings.clientPort = parsed.port;
							this.plugin.settings.clientToken = parsed.token;
							await this.plugin.saveSettings();
							new Notice(
								t('Connection settings saved.', 'Параметры подключения сохранены.'),
							);
							this.update();
						} catch (error) {
							new Notice(errorMessage(error), 8000);
						}
					});
			});
	}

	private renderTestConnection(setting: Setting): void {
		setting
			.setName(t('Test connection', 'Проверка соединения'))
			.setDesc(
				t(
					'GET /api/ping with the current token. Checks that the desktop is reachable and the token is correct.',
					'GET /api/ping с текущим токеном. Проверяет доступность ПК и правильность токена.',
				),
			);
		const resultEl = setting.descEl.createDiv({ cls: 'lan-sync-test-result' });
		setting.addButton((button) => {
			button
				.setButtonText(t('Test connection', 'Проверить соединение'))
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					resultEl.classList.remove('is-success', 'is-error');
					resultEl.setText(t('Testing…', 'Проверка…'));
					try {
						const ping = await this.plugin.pingServer();
						resultEl.classList.add('is-success');
						resultEl.setText(
							t('Connected: {device} · version {version}', 'Подключено: {device} · версия {version}', {
								device: ping.deviceName,
								version: ping.version,
							}),
						);
					} catch (error) {
						resultEl.classList.add('is-error');
						resultEl.setText(errorMessage(error));
					} finally {
						button.setDisabled(false);
					}
				});
		});
	}

	private renderSyncNow(setting: Setting): void {
		setting
			.setName(t('Sync', 'Синхронизация'))
			.setDesc(
				t(
					'Scans the vault, compares it with the desktop and opens the conflict review window.',
					'Сканирует хранилище, сравнивает с ПК и открывает окно разрешения конфликтов.',
				),
			)
			.addButton((button) => {
				button
					.setButtonText(t('Sync now', 'Синхронизировать сейчас'))
					.setCta()
					.onClick(() => {
						void this.plugin.runSync();
					});
			});
	}

	private renderTombstones(setting: Setting): void {
		setting
			.setName(t('Tombstones', 'Tombstone-записи'))
			.setDesc(
				t(
					'Stored now: {count}. Tombstones prevent deleted files from coming back and are kept indefinitely. Cleaning is irreversible.',
					'Сейчас сохранено: {count}. Записи не дают «воскресить» удалённые файлы и хранятся бессрочно. Очистка необратима.',
					{ count: this.plugin.manager.getTombstoneCount() },
				),
			)
			.addButton((button) => {
				button
					.setButtonText(t('Clear tombstones', 'Очистить tombstone-записи'))
					.setDestructive()
					.onClick(async () => {
						const confirmed = await confirmAction(this.app, {
							title: t('Clear tombstones?', 'Очистить tombstone-записи?'),
							message: t(
								'Records of deleted files will be erased from the manifest. Deleted files may then reappear from another device. This action is irreversible.',
								'Записи об удалённых файлах будут стёрты из манифеста. После этого удалённые файлы могут снова появиться с другого устройства. Действие необратимо.',
							),
							confirmText: t('Clear', 'Очистить'),
							destructive: true,
						});
						if (!confirmed) {
							return;
						}
						const removed = await this.plugin.manager.purgeTombstones();
						new Notice(
							t('Tombstones removed: {count}.', 'Удалено tombstone-записей: {count}.', {
								count: removed,
							}),
						);
						this.update();
					});
			});
	}

	private renderAbout(setting: Setting): void {
		setting.setName(PLUGIN_NAME);
		const desc = setting.descEl;
		desc.empty();
		desc.createEl('p', {
			text: t(
				'LAN Vault Bridge v{version}. Protocol: HTTP + Bearer token, SHA-256 comparison, tombstone protection.',
				'LAN Vault Bridge v{version}. Протокол: HTTP + Bearer-токен, сравнение по SHA-256, tombstone-защита.',
				{ version: this.plugin.manifest.version },
			),
		});
		desc.createEl('p', {
			cls: 'lan-sync-hint',
			text: t(
				'Security: traffic is not encrypted (HTTP). Use a trusted home network or a VPN (Tailscale/ZeroTier). The token is stored in plain text in the plugin data.json.',
				'Безопасность: трафик не шифруется (HTTP). Используйте доверенную домашнюю сеть или VPN (Tailscale/ZeroTier). Токен хранится в data.json плагина в открытом виде.',
			),
		});
		desc.createEl('p', {
			cls: 'lan-sync-hint',
			text: t('Manifest: {path}', 'Манифест: {path}', {
				path: this.plugin.manager.getPath(),
			}),
		});
	}

	private async updateQr(): Promise<void> {
		const container = this.qrContainer;
		if (!container || !this.qrAddress) {
			return;
		}
		const settings = this.plugin.settings;
		try {
			const dataUrl = await QRCode.toDataURL(
				connectionJson(this.qrAddress, settings.serverPort, settings.authToken),
				{
					width: 236,
					margin: 1,
					errorCorrectionLevel: 'M',
					color: { dark: '#000000', light: '#ffffff' },
				},
			);
			if (!container.isConnected) {
				return;
			}
			container.empty();
			const image = container.createEl('img', { cls: 'lan-sync-qr-image' });
			image.src = dataUrl;
			image.alt = t(
				'QR code for connecting LAN Vault Bridge',
				'QR-код для подключения LAN Vault Bridge',
			);
			image.width = 236;
			container.createDiv({
				cls: 'lan-sync-qr-caption',
				text: `${this.qrAddress}:${settings.serverPort}`,
			});
		} catch (error) {
			container.setText(
				t(
					'Could not build the QR code: {error}',
					'Не удалось построить QR-код: {error}',
					{ error: errorMessage(error) },
				),
			);
		}
	}

	private serverStatusText(): string {
		const settings: LanSyncSettings = this.plugin.settings;
		if (!settings.serverEnabled) {
			return t('Server is disabled in settings.', 'Сервер выключен в настройках.');
		}
		const server = this.plugin.server;
		if (server?.isRunning) {
			return t(
				'Running on 0.0.0.0:{port}. The phone must be on the same network.',
				'Работает на 0.0.0.0:{port}. Телефон должен быть в той же сети.',
				{ port: server.getPort() },
			);
		}
		return t(
			'Server is not running. Check that the port is free and press "Restart server".',
			'Сервер не запущен. Проверьте, что порт свободен, и нажмите «Перезапустить сервер».',
		);
	}
}

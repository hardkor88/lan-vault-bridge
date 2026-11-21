import type { App, TextAreaComponent } from 'obsidian';
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

	constructor(app: App, plugin: LanSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('lan-sync-settings');

		new Setting(containerEl)
			.setName(PLUGIN_NAME)
			.setDesc(
				t(
					'Sync your vault bidirectionally over the local network, without a cloud.',
					'Двусторонняя синхронизация хранилища по локальной сети — без облака.',
				),
			)
			.setHeading();

		this.renderDevice(containerEl);
		if (Platform.isDesktop) {
			this.renderServer(containerEl);
		}
		this.renderClient(containerEl);
		this.renderOptions(containerEl);
		this.renderTombstones(containerEl);
		this.renderAbout(containerEl);
	}

	private renderDevice(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t('This device', 'Это устройство'))
			.setHeading();

		new Setting(containerEl)
			.setName(t('Device name', 'Имя устройства'))
			.setDesc(
				t(
					'Stored in the manifest and shown in the conflict review window.',
					'Попадает в манифест и в интерфейс разрешения конфликтов.',
				),
			)
			.addText((text) => {
				text.setPlaceholder(t('Windows desktop', 'Windows-ПК'));
				text.setValue(this.plugin.settings.deviceName);
				text.onChange(async (value) => {
					const name = value.trim().slice(0, 64);
					if (!name) {
						return;
					}
					this.plugin.settings.deviceName = name;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t('Interface language', 'Язык интерфейса'))
			.setDesc(
				t(
					'Auto follows the Obsidian display language.',
					'«Авто» следует языку интерфейса Obsidian.',
				),
			)
			.addDropdown((dropdown) => {
				dropdown.addOption(
					'auto',
					t('Auto (Obsidian language)', 'Авто (язык Obsidian)'),
				);
				dropdown.addOption('en', 'English');
				dropdown.addOption('ru', 'Русский');
				dropdown.setValue(this.plugin.settings.uiLanguage);
				dropdown.onChange(async (value) => {
					this.plugin.settings.uiLanguage = value as UiLanguage;
					await this.plugin.saveSettings();
					setUiLanguage(this.plugin.settings.uiLanguage);
					this.display();
				});
			});
	}

	private renderServer(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t('Server on this desktop', 'Сервер на этом ПК'))
			.setHeading();

		new Setting(containerEl)
			.setName(t('Server status', 'Состояние сервера'))
			.setDesc(this.serverStatusText())
			.addButton((button) => {
				button.setButtonText(t('Restart server', 'Перезапустить сервер')).onClick(async () => {
					await this.plugin.restartServer();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName(t('Start server when Obsidian launches', 'Запускать сервер при старте Obsidian'))
			.setDesc(
				t(
					'The server listens on 0.0.0.0 and is reachable by other devices on the same network.',
					'Сервер слушает 0.0.0.0 и доступен другим устройствам в этой же сети.',
				),
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.serverEnabled);
				toggle.onChange(async (value) => {
					this.plugin.settings.serverEnabled = value;
					await this.plugin.saveSettings();
					await this.plugin.restartServer();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName(t('Server port', 'Порт сервера'))
			.setDesc(
				t(
					'Default is 27123. Must match the port configured on the phone.',
					'По умолчанию 27123. Должен совпадать с портом в настройках телефона.',
				),
			)
			.addText((text) => {
				text.setValue(String(this.plugin.settings.serverPort));
				text.inputEl.type = 'number';
				text.inputEl.min = '1024';
				text.inputEl.max = '65535';
				text.onChange(async (value) => {
					const port = Number(value);
					if (!isValidPort(port) || port < 1024) {
						text.inputEl.addClass('is-invalid');
						return;
					}
					text.inputEl.removeClass('is-invalid');
					this.plugin.settings.serverPort = port;
					await this.plugin.saveSettings();
					this.plugin.scheduleServerRestart();
					void this.updateQr();
				});
			});

		new Setting(containerEl)
			.setName(t('Authorization token', 'Токен авторизации'))
			.setDesc(
				t(
					'32 hex characters. Shared secret for the Authorization: Bearer header. Stored in the plugin data.json.',
					'32 hex-символа. Общий секрет для заголовка Authorization: Bearer. Хранится в data.json плагина.',
				),
			)
			.addText((text) => {
				text.setValue(this.plugin.settings.authToken);
				text.inputEl.addClass('lan-sync-token-input');
				text.onChange(async (value) => {
					this.plugin.settings.authToken = value.trim();
					await this.plugin.saveSettings();
					this.plugin.scheduleServerRestart();
					void this.updateQr();
				});
			})
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
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.authToken = randomHex(16);
						await this.plugin.saveSettings();
						this.plugin.scheduleServerRestart();
						this.display();
						new Notice(
							t(
								'A new token was generated. Reconnect the phone.',
								'Создан новый токен. Переподключите телефон заново.',
							),
						);
					});
			});

		this.renderPairing(containerEl);
	}

	private renderPairing(containerEl: HTMLElement): void {
		const wrapper = containerEl.createDiv({ cls: 'lan-sync-qr-block' });
		new Setting(wrapper)
			.setName(t('Pairing a phone', 'Сопряжение телефона'))
			.setHeading();
		const addresses = detectLocalAddresses();
		if (addresses.length === 0) {
			this.qrContainer = null;
			wrapper.createEl('p', {
				cls: 'lan-sync-hint',
				text: t(
					'Could not determine an external IPv4 address. Check the Wi-Fi or Ethernet connection; for Tailscale or ZeroTier you can enter the address manually.',
					'Не удалось определить внешний IPv4. Проверьте, что ПК подключён к Wi-Fi/Ethernet; для Tailscale/ZeroTier адрес можно ввести вручную.',
				),
			});
			return;
		}
		const primary = addresses[0].address;
		if (!this.qrAddress || !addresses.some((info) => info.address === this.qrAddress)) {
			this.qrAddress = primary;
		}

		new Setting(wrapper)
			.setName(t('Address for connection', 'Адрес для подключения'))
			.setDesc(
				t(
					'Choose an IP from the list. Priority: 192.168.*, 10.*, 172.16–31.*, then Tailscale 100.64/10.',
					'Выберите IP из списка: приоритет у 192.168.*, 10.*, 172.16–31.*, затем Tailscale 100.64/10.',
				),
			)
			.addDropdown((dropdown) => {
				for (const info of addresses) {
					dropdown.addOption(info.address, `${info.address} · ${info.iface}`);
				}
				dropdown.setValue(this.qrAddress ?? primary);
				dropdown.onChange((value) => {
					this.qrAddress = value;
					void this.updateQr();
				});
			});

		wrapper.createEl('p', {
			cls: 'lan-sync-ip-list',
			text: t(
				'All discovered IPv4 addresses: {list}',
				'Все найденные IPv4-адреса: {list}',
				{
					list: addresses.map((info) => `${info.address} (${info.iface})`).join(' · '),
				},
			),
		});

		this.qrContainer = wrapper.createDiv({ cls: 'lan-sync-qr-container' });

		new Setting(wrapper)
			.setName(t('Connection string', 'Строка подключения'))
			.setDesc(
				t(
					'JSON with the IP, port and token. You can transfer it to the phone manually.',
					'JSON с IP, портом и токеном. Его можно передать на телефон вручную.',
				),
			)
			.addButton((button) => {
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

		void this.updateQr();
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

	private renderClient(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(
				Platform.isMobile
					? t('Connect to a desktop', 'Подключение к ПК')
					: t('Client: connect to a desktop', 'Клиент: подключение к ПК'),
			)
			.setHeading();

		let importValue = '';
		let textArea: TextAreaComponent | null = null;
		new Setting(containerEl)
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
				text.onChange((value) => {
					importValue = value;
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
							importValue = text;
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
							const parsed = parseConnectionPayload(importValue);
							this.plugin.settings.clientHost = parsed.ip;
							this.plugin.settings.clientPort = parsed.port;
							this.plugin.settings.clientToken = parsed.token;
							await this.plugin.saveSettings();
							new Notice(
								t('Connection settings saved.', 'Параметры подключения сохранены.'),
							);
							this.display();
						} catch (error) {
							new Notice(errorMessage(error), 8000);
						}
					});
			});

		new Setting(containerEl)
			.setName(t('Host/IP', 'IP-адрес ПК'))
			.setDesc(
				t(
					'Desktop IP address on the local network. You can paste it with the port: 192.168.1.5:27123.',
					'IP-адрес ПК в локальной сети. Можно вставить вместе с портом: 192.168.1.5:27123.',
				),
			)
			.addText((text) => {
				text.setPlaceholder('192.168.1.5');
				text.setValue(this.plugin.settings.clientHost);
				text.onChange(async (value) => {
					this.plugin.settings.clientHost = value.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t('Port', 'Порт'))
			.setDesc(
				t(
					'LAN server port on the desktop (default 27123).',
					'Порт LAN-сервера на ПК (по умолчанию 27123).',
				),
			)
			.addText((text) => {
				text.setValue(String(this.plugin.settings.clientPort));
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = '65535';
				text.onChange(async (value) => {
					const port = Number(value);
					if (!isValidPort(port)) {
						text.inputEl.addClass('is-invalid');
						return;
					}
					text.inputEl.removeClass('is-invalid');
					this.plugin.settings.clientPort = port;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t('Auth token', 'Токен'))
			.setDesc(
				t('Token from the desktop (32 hex characters).', 'Токен с ПК (32 hex-символа).'),
			)
			.addText((text) => {
				text.setValue(this.plugin.settings.clientToken);
				text.inputEl.addClass('lan-sync-token-input');
				text.onChange(async (value) => {
					this.plugin.settings.clientToken = value.trim();
					await this.plugin.saveSettings();
				});
			});

		const resultEl = containerEl.createDiv({ cls: 'lan-sync-test-result' });
		new Setting(containerEl)
			.setName(t('Test connection', 'Проверка соединения'))
			.setDesc(
				t(
					'GET /api/ping with the current token. Checks that the desktop is reachable and the token is correct.',
					'GET /api/ping с текущим токеном. Проверяет доступность ПК и правильность токена.',
				),
			)
			.addButton((button) => {
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

		new Setting(containerEl)
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

	private renderOptions(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t('Sync options', 'Параметры синхронизации'))
			.setHeading();

		new Setting(containerEl)
			.setName(t('Excluded folders', 'Исключённые папки'))
			.setDesc(
				t(
					'One per line, relative to the vault root. The .obsidian folder is always ignored.',
					'По одной на строку. Пути относительно корня хранилища. Системная папка .obsidian игнорируется всегда.',
				),
			)
			.addTextArea((text) => {
				text.setPlaceholder(t('Archive\nTemplates', 'Архив\nШаблоны'));
				text.inputEl.rows = 4;
				text.setValue(this.plugin.settings.excludedFolders.join('\n'));
				text.onChange(async (value) => {
					this.plugin.settings.excludedFolders = value
						.split('\n')
						.map((line) => line.trim())
						.filter((line) => line.length > 0);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t('Maximum file size', 'Максимальный размер файла'))
			.setDesc(
				t(
					'In megabytes. Files above the limit are excluded from the manifest and are not transferred.',
					'В мегабайтах. Файлы больше лимита не попадают в манифест и не передаются.',
				),
			)
			.addText((text) => {
				text.setValue(String(this.plugin.settings.maxFileSizeMb));
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = '500';
				text.onChange(async (value) => {
					const megabytes = Number(value);
					if (!Number.isFinite(megabytes) || megabytes < 1 || megabytes > 500) {
						text.inputEl.addClass('is-invalid');
						return;
					}
					text.inputEl.removeClass('is-invalid');
					this.plugin.settings.maxFileSizeMb = Math.round(megabytes);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t('Request timeout', 'Таймаут запроса'))
			.setDesc(
				t(
					'In seconds. File transfers use a larger timeout automatically.',
					'В секундах. Для передачи файлов таймаут увеличивается автоматически.',
				),
			)
			.addText((text) => {
				text.setValue(String(Math.round(this.plugin.settings.requestTimeoutMs / 1000)));
				text.inputEl.type = 'number';
				text.inputEl.min = '3';
				text.inputEl.max = '300';
				text.onChange(async (value) => {
					const seconds = Number(value);
					if (!Number.isFinite(seconds) || seconds < 3 || seconds > 300) {
						text.inputEl.addClass('is-invalid');
						return;
					}
					text.inputEl.removeClass('is-invalid');
					this.plugin.settings.requestTimeoutMs = Math.round(seconds * 1000);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl).setName(t('Advanced', 'Дополнительно')).setHeading();
		new Setting(containerEl)
			.setName(t('Debug logging', 'Отладочный лог'))
			.setDesc(
				t(
					'Write diagnostic messages to the developer console. Disabled by default.',
					'Писать диагностические сообщения в консоль разработчика. По умолчанию выключено.',
				),
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.debugLogging);
				toggle.onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					setDebugLogging(value);
					await this.plugin.saveSettings();
				});
			});
	}

	private renderTombstones(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t('Tombstone protection', 'Защита от удаления'))
			.setHeading();
		const count = this.plugin.manager.getTombstoneCount();
		new Setting(containerEl)
			.setName(t('Tombstones', 'Tombstone-записи'))
			.setDesc(
				t(
					'Stored now: {count}. Tombstones prevent deleted files from coming back and are kept indefinitely. Cleaning is irreversible.',
					'Сейчас сохранено: {count}. Записи не дают «воскресить» удалённые файлы и хранятся бессрочно. Очистка необратима.',
					{ count },
				),
			)
			.addButton((button) => {
				button
					.setButtonText(t('Clear tombstones', 'Очистить tombstone-записи'))
					.setWarning()
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
						this.display();
					});
			});
	}

	private renderAbout(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t('About', 'О плагине')).setHeading();
		const about = containerEl.createDiv({ cls: 'lan-sync-about' });
		about.createEl('p', {
			text: t(
				'LAN Vault Bridge v{version}. Protocol: HTTP + Bearer token, SHA-256 comparison, tombstone protection.',
				'LAN Vault Bridge v{version}. Протокол: HTTP + Bearer-токен, сравнение по SHA-256, tombstone-защита.',
				{ version: this.plugin.manifest.version },
			),
		});
		about.createEl('p', {
			cls: 'lan-sync-hint',
			text: t(
				'Security: traffic is not encrypted (HTTP). Use a trusted home network or a VPN (Tailscale/ZeroTier). The token is stored in plain text in the plugin data.json.',
				'Безопасность: трафик не шифруется (HTTP). Используйте доверенную домашнюю сеть или VPN (Tailscale/ZeroTier). Токен хранится в data.json плагина в открытом виде.',
			),
		});
		about.createEl('p', {
			cls: 'lan-sync-hint',
			text: t('Manifest: {path}', 'Манифест: {path}', {
				path: this.plugin.manager.getPath(),
			}),
		});
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

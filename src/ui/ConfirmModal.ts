import type { App } from 'obsidian';
import { Modal } from 'obsidian';
import { t } from '../i18n';

export interface ConfirmOptions {
	title: string;
	message: string;
	confirmText?: string;
	cancelText?: string;
	destructive?: boolean;
}

/**
 * Небольшое подтверждение в стиле Obsidian. Возвращает Promise<boolean>.
 */
export class ConfirmModal extends Modal {
	private readonly options: ConfirmOptions;
	private readonly onResolve: (value: boolean) => void;
	private result = false;

	constructor(app: App, options: ConfirmOptions, onResolve: (value: boolean) => void) {
		super(app);
		this.options = options;
		this.onResolve = onResolve;
	}

	override onOpen(): void {
		this.titleEl.setText(this.options.title);
		this.contentEl.addClass('lan-sync-confirm');
		this.contentEl.createEl('p', { text: this.options.message });
		const row = this.contentEl.createDiv({ cls: 'modal-button-container lan-sync-confirm-buttons' });
		const cancel = row.createEl('button', {
			text: this.options.cancelText ?? t('Cancel', 'Отмена'),
		});
		cancel.addEventListener('click', () => {
			this.result = false;
			this.close();
		});
		const confirm = row.createEl('button', {
			cls: this.options.destructive ? 'mod-warning' : 'mod-cta',
			text: this.options.confirmText ?? t('Continue', 'Продолжить'),
		});
		confirm.addEventListener('click', () => {
			this.result = true;
			this.close();
		});
	}

	override onClose(): void {
		this.contentEl.empty();
		this.onResolve(this.result);
	}
}

export function confirmAction(app: App, options: ConfirmOptions): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		new ConfirmModal(app, options, resolve).open();
	});
}

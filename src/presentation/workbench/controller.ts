import { t } from '../../shared/i18n';
import { iconHtml } from '../../shared/icons';

export type BottomPanelId = 'log' | 'mcSummary' | 'mcSamples' | 'wcSummary' | 'wcImpact' | 'wcCases';

interface WorkbenchElements {
	app: HTMLElement;
	inputDock: HTMLElement;
	inputDockButton: HTMLButtonElement;
	verticalSplitter: HTMLElement;
	horizontalSplitter: HTMLElement;
	chartToolbar: HTMLElement;
	expandButton: HTMLButtonElement;
	bottomTabs: HTMLButtonElement[];
	bottomPanes: HTMLElement[];
	resizeChart: () => void;
}

/** 工作台布局、面板和拖拽交互控制器。 */
export class WorkbenchController {
	constructor(private readonly elements: WorkbenchElements) {}

	install() {
		this.installSplitters();
		this.installBlankClickCollapse();
		installHorizontalWheelScroll(this.elements.chartToolbar);
	}

	toggleWaveExpanded(force?: boolean) {
		const { app, expandButton } = this.elements;
		const shouldExpand = typeof force === 'boolean' ? force : !app.classList.contains('wave-expanded');
		app.classList.toggle('wave-expanded', shouldExpand);
		expandButton.innerHTML = shouldExpand
			? `${iconHtml('restore')}${t('action.restore')}`
			: `${iconHtml('expand')}${t('action.expand')}`;
		window.setTimeout(() => this.elements.resizeChart(), 30);
		window.setTimeout(() => this.elements.resizeChart(), 180);
	}

	refreshLocale() {
		const { app, inputDockButton } = this.elements;
		inputDockButton.title = app.classList.contains('input-collapsed')
			? t('tooltip.expandNetlist')
			: t('tooltip.collapseNetlist');
		this.toggleWaveExpanded(app.classList.contains('wave-expanded'));
	}

	activateBottomPanel(panel: BottomPanelId) {
		for (const button of this.elements.bottomTabs) {
			button.classList.toggle('active', (button.dataset.panel || 'log') === panel);
		}
		for (const pane of this.elements.bottomPanes) {
			pane.classList.toggle('active', bottomPanelIdForPane(pane) === panel);
		}
		window.setTimeout(() => this.elements.resizeChart(), 30);
	}

	toggleInputCollapsed(force?: boolean) {
		const { app, inputDockButton } = this.elements;
		const collapsed = typeof force === 'boolean' ? force : !app.classList.contains('input-collapsed');
		app.classList.toggle('input-collapsed', collapsed);
		inputDockButton.setAttribute('aria-expanded', String(!collapsed));
		inputDockButton.title = collapsed ? t('tooltip.expandNetlist') : t('tooltip.collapseNetlist');
		window.setTimeout(() => this.elements.resizeChart(), 60);
	}

	toggleBottomCollapsed(force?: boolean) {
		const { app } = this.elements;
		const collapsed = typeof force === 'boolean' ? force : !app.classList.contains('bottom-collapsed');
		app.classList.toggle('bottom-collapsed', collapsed);
		window.setTimeout(() => this.elements.resizeChart(), 60);
	}

	/** 点击 tab 栏空白区域（非 tab 按钮）切换面板收起/展开。
	 *  pointerdown 阶段阻止默认行为，避免连续点击触发浏览器选中文本。 */
	private installBlankClickCollapse() {
		this.elements.inputDock.addEventListener('pointerdown', (event) => {
			if (event.target !== this.elements.inputDock) return;
			event.preventDefault();
		});
		this.elements.inputDock.addEventListener('click', (event) => {
			if (event.target !== this.elements.inputDock) return;
			this.toggleInputCollapsed();
		});
		const bottomTabs = this.elements.bottomTabs[0]?.parentElement;
		if (!bottomTabs) return;
		bottomTabs.addEventListener('pointerdown', (event) => {
			if (event.target !== bottomTabs) return;
			event.preventDefault();
		});
		bottomTabs.addEventListener('click', (event) => {
			if (event.target !== bottomTabs) return;
			this.toggleBottomCollapsed();
		});
	}

	private installSplitters() {
		const { app, inputDock, verticalSplitter, horizontalSplitter } = this.elements;
		verticalSplitter.addEventListener('pointerdown', (event) => {
			event.preventDefault();
			this.toggleInputCollapsed(false);
			const bounds = app.getBoundingClientRect();
			const dockWidth = inputDock.getBoundingClientRect().width;
			const onMove = (move: PointerEvent) => {
				const maxWidth = Math.max(0, bounds.width / 2 - dockWidth);
				const minWidth = Math.min(220, maxWidth);
				const width = Math.min(Math.max(move.clientX - bounds.left - dockWidth, minWidth), maxWidth);
				app.style.setProperty('--left-panel-width', `${width}px`);
				this.elements.resizeChart();
			};
			installPointerMove(onMove);
		});

		horizontalSplitter.addEventListener('pointerdown', (event) => {
			event.preventDefault();
			this.toggleBottomCollapsed(false);
			const bounds = app.getBoundingClientRect();
			const onMove = (move: PointerEvent) => {
				const height = Math.min(Math.max(bounds.bottom - move.clientY, 120), Math.max(180, bounds.height - 220));
				app.style.setProperty('--bottom-panel-height', `${height}px`);
				this.elements.resizeChart();
			};
			installPointerMove(onMove);
		});
	}
}

export function normalizedHorizontalWheelDelta(
	event: Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>,
	pageSize: number,
): number {
	const dominantDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
		? event.deltaX
		: event.deltaY;
	if (event.deltaMode === 1) return dominantDelta * 16;
	if (event.deltaMode === 2) return dominantDelta * pageSize;
	return dominantDelta;
}

function installHorizontalWheelScroll(element: HTMLElement) {
	element.addEventListener('wheel', (event) => {
		if (element.scrollWidth <= element.clientWidth) return;
		const delta = normalizedHorizontalWheelDelta(event, element.clientWidth);
		if (!delta) return;

		const maxScrollLeft = element.scrollWidth - element.clientWidth;
		const nextScrollLeft = Math.min(Math.max(element.scrollLeft + delta, 0), maxScrollLeft);
		if (nextScrollLeft === element.scrollLeft) return;

		event.preventDefault();
		element.scrollLeft = nextScrollLeft;
	}, { passive: false });
}

function bottomPanelIdForPane(pane: HTMLElement): BottomPanelId {
	if (pane.id === 'mcSummaryPanel') return 'mcSummary';
	if (pane.id === 'mcSamplesPanel') return 'mcSamples';
	if (pane.id === 'wcSummaryPanel') return 'wcSummary';
	if (pane.id === 'wcImpactPanel') return 'wcImpact';
	if (pane.id === 'wcCasesPanel') return 'wcCases';
	return 'log';
}

function installPointerMove(onMove: (event: PointerEvent) => void) {
	const onUp = () => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
	};
	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp, { once: true });
}

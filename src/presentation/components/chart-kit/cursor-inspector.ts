import { clamp, escapeHtml, formatWaveformValue } from "./axis-format";

export interface InspectorRowView {
	/** 行标识(结构变化检测用,如 traceId)。 */
	id: string;
	color: string;
	text: string;
}

export interface InspectorUnit {
	/** 显示单位(如 "ms"/"mA");空串表示不带单位。 */
	label: string;
	/** 显示单位 → 数据值的换算因子(数据值 = 输入值 × factor)。 */
	factor: number;
}

export interface InspectorBounds {
	min: number;
	max: number;
	isLog: boolean;
}

export interface InspectorPosition {
	/** 游标像素 x(面板贴其左右)。 */
	pixel: number;
	boundsLeft: number;
	boundsRight: number;
	boundsTop: number;
	boundsBottom: number;
	/** 固定面板 top(缺省贴 boundsTop + 8)。 */
	fixedTop?: number;
}

export interface CursorInspectorOptions {
	/** 面板挂载的画布根元素。 */
	container: HTMLElement;
	/** 输入提交(回车/失焦):参数已按数据范围钳制;吸附采样点、视野居中由宿主完成。 */
	onCommit: (dataValue: number) => void;
	/** 输入框 aria 文案(语言切换时经 setAriaLabel 更新)。 */
	inputAriaLabel: string;
}

/**
 * 固定游标的悬浮读数面板(波形图/逻辑图共用)。
 * 行为:Enter 提交 + Escape 失焦不提交 + change 兜底提交;输入按数据范围钳制,
 * 非法输入标红(aria-invalid);面板内鼠标事件不穿透到底下画布;输入框宽度随内容自适应。
 */
export class CursorInspectorPanel {
	private readonly root: HTMLDivElement;
	private readonly axisNameEl: HTMLSpanElement;
	private readonly inputEl: HTMLInputElement;
	private readonly unitEl: HTMLSpanElement;
	private readonly rowsEl: HTMLDivElement;
	private rowElements: Array<{ id: string; row: HTMLDivElement; swatch: HTMLSpanElement; value: HTMLSpanElement }> = [];
	private unitFactor = 1;
	private bounds: InspectorBounds = { min: 0, max: 1, isLog: false };
	/** 最近一次已确认的游标数据值（Escape 时恢复输入框用）。 */
	private committedX = Number.NaN;

	constructor(private readonly options: CursorInspectorOptions) {
		this.root = document.createElement("div");
		this.root.className = "waveform-inspector hidden";
		this.root.innerHTML = `
			<div class="waveform-inspector-header">
				<span class="waveform-inspector-axis"></span>
				<input class="waveform-inspector-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="${escapeHtml(options.inputAriaLabel)}" />
				<span class="waveform-inspector-unit"></span>
			</div>
			<div class="waveform-inspector-rows"></div>
		`;
		this.axisNameEl = this.root.querySelector(".waveform-inspector-axis") as HTMLSpanElement;
		this.inputEl = this.root.querySelector(".waveform-inspector-input") as HTMLInputElement;
		this.unitEl = this.root.querySelector(".waveform-inspector-unit") as HTMLSpanElement;
		this.rowsEl = this.root.querySelector(".waveform-inspector-rows") as HTMLDivElement;
		// 面板范围内的鼠标/滚轮事件只属于面板,不穿透到底下画布(缩放/平移/点击)。
		for (const eventName of ["mousedown", "mouseup", "mousemove", "click", "dblclick", "wheel"]) {
			this.root.addEventListener(eventName, (event) => event.stopPropagation());
		}
		this.inputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				this.commit();
				this.inputEl.select();
			}
			else if (event.key === "Escape") {
				event.preventDefault();
				// 取消编辑：恢复为最近确认的游标值再失焦，避免 blur 触发 change 误提交。
				if (Number.isFinite(this.committedX)) {
					this.setInputValue(formatWaveformValue(this.committedX / this.unitFactor));
				}
				this.inputEl.blur();
			}
		});
		this.inputEl.addEventListener("focus", () => requestAnimationFrame(() => this.inputEl.select()));
		this.inputEl.addEventListener("click", () => this.inputEl.select());
		this.inputEl.addEventListener("input", () => this.updateInputWidth());
		this.inputEl.addEventListener("change", () => this.commit());
		options.container.appendChild(this.root);
	}

	setAriaLabel(text: string): void {
		this.inputEl.setAttribute("aria-label", text);
	}

	isVisible(): boolean {
		return !this.root.classList.contains("hidden");
	}

	hide(): void {
		this.root.classList.add("hidden");
	}

	/** 提交后由宿主回写游标最终数据值(吸附采样点后)。 */
	setValue(dataValue: number): void {
		this.committedX = dataValue;
		this.setInputValue(formatWaveformValue(dataValue / this.unitFactor));
	}

	private setInputValue(value: string): void {
		this.inputEl.value = value;
		this.updateInputWidth();
	}

	private updateInputWidth(): void {
		const characterCount = Math.max(1, this.inputEl.value.length);
		this.inputEl.style.width = `calc(${characterCount}ch + 6px)`;
	}

	/** 刷新面板内容与位置(游标移动/缩放平移后调用)。 */
	update(params: {
		axisName: string;
		inputTitle: string;
		unit: InspectorUnit;
		bounds: InspectorBounds;
		x: number;
		rows: InspectorRowView[];
		position: InspectorPosition;
	}): void {
		const { axisName, inputTitle, unit, bounds, x, rows, position } = params;
		const unitChanged = this.unitFactor !== unit.factor;
		this.unitFactor = unit.factor;
		this.bounds = bounds;
		this.committedX = x;
		this.axisNameEl.textContent = `${axisName}:`;
		this.unitEl.textContent = unit.label;
		this.inputEl.title = inputTitle;
		this.inputEl.min = formatWaveformValue(bounds.min / unit.factor);
		this.inputEl.max = formatWaveformValue(bounds.max / unit.factor);
		if (document.activeElement !== this.inputEl || unitChanged) {
			this.setInputValue(formatWaveformValue(x / unit.factor));
		}
		this.inputEl.removeAttribute("aria-invalid");
		this.renderRows(rows);

		this.root.classList.remove("hidden");
		const panelWidth = this.root.offsetWidth || 228;
		const panelHeight = this.root.offsetHeight || 44;
		const gap = 10;
		const left = position.pixel + panelWidth + gap > position.boundsRight
			? Math.max(position.boundsLeft + 6, position.pixel - panelWidth - gap)
			: Math.min(position.boundsRight - panelWidth, Math.max(position.boundsLeft + 6, position.pixel + gap));
		const top = position.fixedTop ?? position.boundsTop + 8;
		this.root.style.left = `${left}px`;
		this.root.style.top = `${top}px`;
	}

	private renderRows(rows: InspectorRowView[]): void {
		const structureChanged = rows.length !== this.rowElements.length
			|| rows.some((row, index) => row.id !== this.rowElements[index]?.id);
		if (structureChanged) {
			const fragment = document.createDocumentFragment();
			this.rowElements = rows.map((row) => {
				const rowEl = document.createElement("div");
				rowEl.className = "waveform-inspector-row";
				const swatch = document.createElement("span");
				swatch.className = "waveform-inspector-swatch";
				const value = document.createElement("span");
				value.className = "waveform-inspector-value";
				rowEl.append(swatch, value);
				fragment.appendChild(rowEl);
				return { id: row.id, row: rowEl, swatch, value };
			});
			this.rowsEl.replaceChildren(fragment);
		}
		rows.forEach((row, index) => {
			const elements = this.rowElements[index];
			elements.swatch.style.backgroundColor = row.color;
			elements.value.textContent = row.text;
		});
	}

	private commit(): void {
		const raw = this.inputEl.value.trim();
		const parsed = raw ? Number(raw) * this.unitFactor : Number.NaN;
		if (!Number.isFinite(parsed) || (this.bounds.isLog && parsed <= 0)) {
			this.inputEl.setAttribute("aria-invalid", "true");
			return;
		}
		this.inputEl.removeAttribute("aria-invalid");
		const min = Math.min(this.bounds.min, this.bounds.max);
		const max = Math.max(this.bounds.min, this.bounds.max);
		this.options.onCommit(clamp(parsed, min, max));
	}
}

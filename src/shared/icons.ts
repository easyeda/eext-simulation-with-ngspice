import {
	ChartSpline,
	Crosshair,
	Download,
	FileUp,
	ListChecks,
	Maximize2,
	Minimize2,
	Play,
	Scan,
	Trash2,
	Waves,
	createElement,
	type IconNode,
} from 'lucide';

export type AppIconName =
	| 'clear'
	| 'cursor'
	| 'display'
	| 'expand'
	| 'export'
	| 'fit'
	| 'import'
	| 'restore'
	| 'run'
	| 'traces'
	| 'unwrap';

const APP_ICONS: Record<AppIconName, IconNode> = {
	clear: Trash2,
	cursor: Crosshair,
	display: ChartSpline,
	expand: Maximize2,
	export: Download,
	fit: Scan,
	import: FileUp,
	restore: Minimize2,
	run: Play,
	traces: ListChecks,
	unwrap: Waves,
};

export function iconHtml(name: AppIconName): string {
	return createElement(APP_ICONS[name], {
		class: 'icon',
		width: 16,
		height: 16,
		'stroke-width': 2,
		'aria-hidden': 'true',
		focusable: 'false',
	}).outerHTML;
}

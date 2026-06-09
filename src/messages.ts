import type { AnalysisType } from './shared/types';

export const NETLIST_TOPIC = 'jlc-ngspice-waveform:netlist';
export const REQUEST_NETLIST_TOPIC = 'jlc-ngspice-waveform:request-netlist';
export const LAUNCH_ENGINE_TOPIC = 'jlc-ngspice-waveform:launch-engine';
export const INSTALL_LAUNCHER_TOPIC = 'jlc-ngspice-waveform:install-launcher';

export interface NetlistImportMessage {
	type: 'simulation-netlist';
	source: 'EasyEDA Pro' | 'local-file' | 'paste';
	fileName: string;
	netlist: string;
	analysisType: AnalysisType;
	command: string;
	lineCount: number;
	importedAt: number;
}

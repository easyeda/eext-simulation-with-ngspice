/** 仿真内核使用的规范探针描述；外部协议字段只能在 integration 层转换到此结构。 */

export const enum ProbeType {
	LMITATE = 0,
	DIGITAL = 1,
}
export interface ProbeTarget {
	node: string;
	probeType?: ProbeType;
	lowLevel?: number;
	highLevel?: number;
}

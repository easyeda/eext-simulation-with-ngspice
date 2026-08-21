import type { WorstCaseObjective } from "../features/worst-case/types";

export const sampleNetlists = {
	transient: `* Transient RC sample
V1 in 0 PULSE(0 5 0 1n 1n 1m 2m)
R1 in out 1k
C1 out 0 1u
.tran 10u 8m
.save v(in) v(out)
.end`,
	ac: `* AC RC low-pass sample
V1 in 0 AC 1
R1 in out 1k
C1 out 0 1u
.ac dec 40 10 1Meg
.save v(out)
.end`,
	dc: `* DC divider sample
V1 in 0 0
R1 in out 1k
R2 out 0 1k
.dc V1 0 5 0.05
.save v(out)
.end`,
	mcDivider: `* Monte Carlo AC low-pass sample
.param R1_nom=1k C1_nom=1u tolr=0.1
.param R1_val=agauss(R1_nom, R1_nom*tolr, 3)
.param C1_val=agauss(C1_nom, C1_nom*tolr, 3)
V1 in 0 AC 1
R1 in out {R1_val}
C1 out 0 {C1_val}
.ac dec 40 10 1Meg
.meas ac __JLC_PARAM_R1_VAL PARAM='R1_val'
.meas ac __JLC_PARAM_C1_VAL PARAM='C1_val'
.meas ac GAIN_1K FIND vdb(out) AT=1k
.meas ac __JLC_SPEC_MIN_GAIN_1K PARAM='-17'
.meas ac __JLC_SPEC_MAX_GAIN_1K PARAM='-15'
.meas ac __JLC_PHASE_PHASE_100 FIND vp(out) AT=100
.meas ac __JLC_SPEC_MIN_PHASE_100 PARAM='-34'
.meas ac __JLC_SPEC_MAX_PHASE_100 PARAM='-30'
.end`,
	wcTransient: `* Worst Case transient divider sample
.param WC_R1_NOM=10k WC_R1_MIN=9k WC_R1_MAX=11k
.param WC_R2_NOM=10k WC_R2_MIN=9k WC_R2_MAX=11k
.param WC_R1={WC_R1_NOM} WC_R2={WC_R2_NOM}
V1 in 0 DC 5
R1 in out {WC_R1}
R2 out 0 {WC_R2}
.tran 1n 1u
.meas tran __JLC_PARAM_WC_R1 PARAM='WC_R1'
.meas tran __JLC_WC_MIN_WC_R1 PARAM='WC_R1_MIN'
.meas tran __JLC_WC_MAX_WC_R1 PARAM='WC_R1_MAX'
.meas tran __JLC_PARAM_WC_R2 PARAM='WC_R2'
.meas tran __JLC_WC_MIN_WC_R2 PARAM='WC_R2_MIN'
.meas tran __JLC_WC_MAX_WC_R2 PARAM='WC_R2_MAX'
.meas tran VOUT_FINAL FIND v(out) AT=1u
.end`,
	wcAc: `* Worst Case AC low-pass sample
.param WC_R1_NOM=1k WC_R1_MIN=900 WC_R1_MAX=1100
.param WC_C1_NOM=1u WC_C1_MIN=0.9u WC_C1_MAX=1.1u
.param WC_R1={WC_R1_NOM} WC_C1={WC_C1_NOM}
V1 in 0 AC 1
R1 in out {WC_R1}
C1 out 0 {WC_C1}
.ac dec 40 10 1Meg
.meas ac __JLC_PARAM_WC_R1 PARAM='WC_R1'
.meas ac __JLC_WC_MIN_WC_R1 PARAM='WC_R1_MIN'
.meas ac __JLC_WC_MAX_WC_R1 PARAM='WC_R1_MAX'
.meas ac __JLC_PARAM_WC_C1 PARAM='WC_C1'
.meas ac __JLC_WC_MIN_WC_C1 PARAM='WC_C1_MIN'
.meas ac __JLC_WC_MAX_WC_C1 PARAM='WC_C1_MAX'
.meas ac GAIN_1K FIND vdb(out) AT=1k
.end`,
	wcDc: `* Worst Case DC divider sample
.param WC_R1_NOM=10k WC_R1_MIN=9k WC_R1_MAX=11k
.param WC_R2_NOM=10k WC_R2_MIN=9k WC_R2_MAX=11k
.param WC_R1={WC_R1_NOM} WC_R2={WC_R2_NOM}
V1 in 0 0
R1 in out {WC_R1}
R2 out 0 {WC_R2}
.dc V1 0 5 0.05
.meas dc __JLC_PARAM_WC_R1 PARAM='WC_R1'
.meas dc __JLC_WC_MIN_WC_R1 PARAM='WC_R1_MIN'
.meas dc __JLC_WC_MAX_WC_R1 PARAM='WC_R1_MAX'
.meas dc __JLC_PARAM_WC_R2 PARAM='WC_R2'
.meas dc __JLC_WC_MIN_WC_R2 PARAM='WC_R2_MIN'
.meas dc __JLC_WC_MAX_WC_R2 PARAM='WC_R2_MAX'
.meas dc VOUT_AT_4P9 FIND v(out) AT=4.9
.end`,
};

export const worstCaseSampleObjectives: Partial<Record<keyof typeof sampleNetlists, WorstCaseObjective>> = {
	wcTransient: {
		measurementId: "VOUT_FINAL",
		label: "V(out) at 1 us",
		unit: "V",
	},
	wcAc: {
		measurementId: "GAIN_1K",
		label: "Gain at 1 kHz",
		unit: "dB",
	},
	wcDc: {
		measurementId: "VOUT_AT_4P9",
		label: "V(out) at 4.9 V sweep",
		unit: "V",
	},
};

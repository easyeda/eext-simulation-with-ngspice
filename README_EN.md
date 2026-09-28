# NGspice Simulation

English | [简体中文](./README.md)

Version: V1.9.1

Author: LCEDA

License: BSD-3-Clause

Third-party licenses: The plugin package bundles the ngspice WASM build, ECharts and zrender. See `THIRD_PARTY_NOTICES.md`, `licenses/` and `iframe/wasm/NGSPICE-COPYING.txt` for the license texts.

NGspice Simulation is a local simulation and waveform viewer plugin for EasyEDA Pro. The plugin receives the NGspice netlist and probe information passed in by EDA simulation events, and also supports pasting or importing plain NGspice netlist text directly in the waveform view. It uses its built-in real NGspice WASM engine to run simulations and waveform analysis entirely inside the local browser.

## Feature Overview

![NGspice Simulation feature overview](./images/UI.png)

## Feature Demo

![NGspice Simulation demo](./images/sim_ng.gif)

![NGspice logic analysis demo](./images/sim_ng_d.gif)


## Core Features

### Simulation Engine

- Built-in NGspice runs simulations locally in the browser, with no extra download or resident local simulator required.
- Supports parsing and waveform rendering of the three standard analysis types: transient, AC and DC.
- Logic analysis chart: 0/1/U timing diagrams for XSPICE digital nodes and logic probes. Digital and analog data are automatically routed to the logic chart and the waveform chart respectively; when a logic probe points to an analog node, values are converted by a level threshold.
- Netlist compatibility: LTspice / PSpice / HSPICE dialect selectable via dropdown, auto-applied when importing netlists.

### Monte Carlo and Worst-Case Analysis

- Monte Carlo analysis: samples render on screen in real time; zooming and panning stay smooth even with a thousand overlaid sample waveforms.
- Statistics summary and histograms: outputs mean, standard deviation, quantiles and yield for each measurement; the histogram supports count / percentage display and annotates the mean and the upper/lower spec limits; clicking a sample highlights and locates it in the overlaid waveform chart, and details can be exported.
- Worst-case analysis: automatically identifies parameters and tolerance bounds from netlist measurements, synthesizes Worst Low / Worst High combinations by parameter sensitivity; provides a corner summary, parameter impact and run detail tables, with nominal and both worst-case waveforms overlaid.

### Waveform Interaction

- Multi-curve legend toggles, curve picker dialog, zoom at mouse position, drag panning and full-screen waveform viewing.
- Value lines support both mouse-following and fixed cursor modes: line-only mode interpolates and follows continuously, while point/line-point modes snap to the nearest sample; fixed cursors are draggable and support positioning by entering a value in horizontal-axis units; intersection dots stay pinned to the on-screen polyline and do not drift while zooming or panning.
- Large data renders the data within the current window first, and uses peak-preserving downsampling when zoomed out; the render point budget is shared across curves, staying smooth with many curves overlaid.
- Auto-fit computes the view range from currently unhidden curves only, and clamps the horizontal axis to the valid data bounds to reduce empty, data-free space.

### Data Import and Export

- After an EDA simulation event is triggered, the waveform view opens automatically, imports the netlist and probes and runs the simulation; when finished, probe-matched curves are selected by default.
- Supports manually importing `.txt` / `.cir` / `.net` / `.spice` netlists, or pasting netlist content directly.
- Recognizes `XAM` current probes in netlists, automatically adds voltage save items for both terminals and synthesizes current curves from the voltage difference.
- Supports exporting complete waveform data for every analysis type: single datasets produce a CSV, multiple datasets produce a ZIP containing per-dataset CSVs.

### Compatibility and Experience

- AC analysis accepts common `1M` / `10M` frequency notations and automatically converts them to ngspice's `1Meg` / `10Meg` before running.
- Deduplicates the same EDA netlist message to avoid repeated broadcasts wiping freshly generated waveforms; the curve picker dialog opens reliably after chart refreshes.
- On run failure, the bottom log area shows NGspice output, the cause of the error and key diagnostic information.
- Simplified Chinese and English UI, following the current EDA language and responding to runtime switches; the toolbar scrolls horizontally when the canvas narrows.

## Usage

1. After triggering an EDA simulation event in the schematic editor, the plugin automatically opens the waveform view.
2. The plugin imports the netlist and probe information from the event and immediately starts the simulation.
3. When the simulation completes, the probe-matched curves are selected and displayed by default.
4. To use a custom netlist, click `NGspice Waveform` -> `Open Waveform View` on the schematic page, then import / paste a netlist manually.

## Supported Data

- Transient analysis: `.tran`, horizontal axis is time, supports voltage / current dual-axis display.
- AC analysis: `.ac`, horizontal axis is frequency, supports gain dB and phase deg display.
- DC sweep: `.dc`, horizontal axis is the sweep variable, supports voltage / current curves.
- Monte Carlo analysis: per-sample resampling statistics over random parameters; measurements can declare upper/lower spec limits and compute yield.
- Worst-case analysis: parameter sensitivity sweeps and Worst Low / Worst High combination waveform comparison.
- Logic analysis: digital node event data converted to 0/1/U timing; logic probes may point to analog nodes and convert by threshold.
- EDA probes: matches existing curves for probes placed in the EDA and uses the matched results as the default displayed curves.
- Current probes: recognizes the `XAM` probe form and synthesizes current waveforms from the voltage difference across both terminals.
- Netlist compatibility: supports PSpice (psa), LTspice (lta), HSPICE (hsa) and combined modes.

## Requirements

- EasyEDA Pro 4.1 or later.
- The plugin bundles an NGspice 46 WASM build.
- The simulation runs in the plugin iframe on the local machine; netlist file paths or simulation results are never uploaded.

## Development Structure

For detailed source-code layering, root-directory responsibilities and the difference between `build/` and `wasm-build/`, see `CODEBASE_GUIDE.md`.

Quick rules:

- `src/` and `iframe/styles/` contain the plugin's business logic and UI source code.
- `build/` is the directory for plugin packaging, temporary harnesses and `.eext` output.
- `wasm-build/` holds the ngspice WASM build scripts and wrapper source code.
- `wasm-lib/` holds intermediate artifacts of the compiled ngspice WASM; the final runtime assets are synced into `iframe/wasm/`.
- `build/ngspice-wasm-kit/`, if present locally, is only a snapshot of early portable WASM build reference material, not the current main build entry.

## Known Limitations

- V1.9.1 supports netlist text input only: LTspice / PSpice / HSPICE dialect syntax (ngbehavior) is supported, but importing schematic project files (e.g. `.sch` / `.asc`) is not, and dialect-specific syntax is not guaranteed to parse in full.
- Simulation capability is limited by the current bundled NGspice WASM build: XSPICE is enabled, while CIDER, OSDI, OpenMP and KLU are not yet enabled.
- Large circuits or long simulations are constrained by browser memory and single-threaded execution time.

## Acknowledgements

- **The NGspice project** ([ngspice.sourceforge.io](https://ngspice.sourceforge.io/)) - for providing the open-source SPICE circuit simulation core and XSPICE extension capabilities.
- **The Emscripten team** - for making NGspice C/C++ code run in the browser as WebAssembly.
- **The Apache ECharts project** ([echarts.apache.org](https://echarts.apache.org/)) - for the visualization rendering behind the waveform and logic analysis charts.
- All project contributors and the open-source community.

## Related Resources

- [NGspice official website](https://ngspice.sourceforge.io/)
- [NGspice 46 user manual](https://ngspice.sourceforge.io/docs/ngspice-46-manual.pdf)
- [WebAssembly official documentation](https://webassembly.org/)
- [Emscripten documentation](https://emscripten.org/docs/)
- [Apache ECharts documentation](https://echarts.apache.org/handbook/)

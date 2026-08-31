import { iconHtml } from '../shared/icons';

export const iframeTemplate = `
  <div class="eda-app" data-theme="light">
    <header class="top-bar">
      <div class="brand-block">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <rect x="1" y="1" width="22" height="22" rx="5" fill="var(--brand-mark-bg)" stroke="var(--brand-mark-border)" />
            <path d="M6 17V7L18 17V7" fill="none" stroke="var(--brand-mark-stroke)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            <circle cx="6" cy="7" r="1.7" fill="var(--brand-mark-node)" />
            <circle cx="18" cy="17" r="1.7" fill="var(--brand-mark-node)" />
          </svg>
        </span>
        <div>
          <div class="app-title" data-i18n="app.title">NGspice 仿真</div>
        </div>
      </div>
      <div class="toolbar">
        <label class="eda-button default file-button" title="导入本地 TXT 网表" data-i18n-title="tooltip.importTxt">
          <input id="fileInput" type="file" accept=".txt,.cir,.net,.spice" />
          ${iconHtml('import')}
          <span data-i18n="action.importTxt">导入 TXT</span>
        </label>
        <span class="mode-control sample-control" title="载入示例网表" data-i18n-title="tooltip.sampleNetlist">
          <span data-i18n="sample.label">示例网表</span>
          <select id="sampleSelect" class="eda-select" title="载入示例网表" data-i18n-title="tooltip.sampleNetlist">
            <option value="" data-i18n="sample.placeholder">选择</option>
            <option value="transient">Tran RC</option>
            <option value="ac">AC RC</option>
            <option value="dc">DC Div</option>
            <option value="mcDivider">MC Div</option>
            <option value="wcTransient">WCA Tran</option>
            <option value="wcAc">WCA AC</option>
            <option value="wcDc">WCA DC</option>
          </select>
        </span>
        <span class="mode-control compat-control" title="ngspice 兼容网表" data-i18n-title="tooltip.compatMode">
          <span data-i18n="compat.label">兼容网表</span>
          <select id="compatModeSelect" class="eda-select compact" data-i18n-aria-label="compat.label" aria-label="兼容网表">
            <option value="" data-i18n="compat.none">无</option>
            <option value="psa" data-i18n="compat.psa">PSpice</option>
            <option value="lta" data-i18n="compat.lta">LTspice</option>
            <option value="hsa" data-i18n="compat.hsa">HSPICE</option>
            <option value="ltpsa" data-i18n="compat.ltpsa">LTspice + PSpice</option>
          </select>
        </span>
        <label class="mode-control analysis-type-control" title="EDA 仿真事件决定分析类型" data-i18n-title="tooltip.analysisType">
          <span data-i18n="analysis.type">分析类型</span>
          <span id="analysisTypeValue" class="analysis-type-pill">TRAN</span>
          <input id="analysisModeSelect" type="hidden" value="transient" />
          <input id="mcSampleCountInput" type="hidden" value="30" />
          <input id="mcSeedInput" type="hidden" value="12345" />
        </label>
        <button id="runButton" class="eda-button primary" type="button" title="使用插件内置 NGspice WASM 运行" data-i18n-title="tooltip.run">
          ${iconHtml('run')}
          <span data-i18n="action.run">运行</span>
        </button>
        <button id="clearButton" class="eda-button default" type="button" title="清空输入和波形" data-i18n-title="tooltip.clear">
          ${iconHtml('clear')}
          <span data-i18n="action.clear">清空</span>
        </button>
      </div>
    </header>

    <main class="workbench">
      <nav class="input-dock" aria-label="仿真网表面板" data-i18n-aria-label="aria.netlistPanel">
        <button id="inputDockButton" class="input-dock-tab active" type="button" title="收回仿真网表" data-i18n-title="tooltip.collapseNetlist" aria-expanded="true">
          <span data-i18n="dock.netlist.1">仿</span><span data-i18n="dock.netlist.2">真</span><span data-i18n="dock.netlist.3">网</span><span data-i18n="dock.netlist.4">表</span><span data-i18n="dock.netlist.5"></span><span data-i18n="dock.netlist.6"></span><span data-i18n="dock.netlist.7"></span>
        </button>
        <button id="toleranceDockButton" class="input-dock-tab hidden" type="button" title="容差参数" data-i18n-title="tooltip.toleranceParameters" aria-expanded="true">
          <span data-i18n="dock.tolerance.1">容</span><span data-i18n="dock.tolerance.2">差</span><span data-i18n="dock.tolerance.3">参</span><span data-i18n="dock.tolerance.4">数</span>
        </button>
      </nav>

      <section class="input-panel">
        <div id="netlistInputView" class="input-view active">
          <div class="panel-head">
            <div>
              <h2 data-i18n="netlist.panelTitle">NGspice 仿真网表</h2>
              <p data-i18n="netlist.panelDescription">由 EDA 仿真事件导入，或手动导入 / 粘贴纯文本网表</p>
            </div>
            <div class="panel-actions">
              <span id="netlistMeta" class="eda-tag neutral" data-i18n="netlist.notLoaded">未载入</span>
            </div>
          </div>
          <textarea id="netlistInput" class="netlist-editor" spellcheck="false" placeholder="等待 EDA 仿真事件导入网表，或粘贴 .tran / .ac / .dc 网表" data-i18n-placeholder="netlist.placeholder"></textarea>
        </div>
        <div id="toleranceInputView" class="input-view">
          <div class="panel-head">
            <div>
              <h2 data-i18n="wca.toleranceTitle">器件容差参数</h2>
              <p data-i18n="wca.toleranceDescription">本次分析使用的标称值和上下限，只读展示</p>
            </div>
          </div>
          <div id="toleranceParameterTable" class="tolerance-parameter-table"></div>
        </div>
      </section>

      <div id="verticalSplitter" class="splitter splitter-vertical" title="拖动调整网表宽度" data-i18n-title="tooltip.resizeNetlist"></div>

      <section class="wave-panel">
        <article class="chart-card">
          <div class="chart-head">
            <div id="waveformChartContext" class="chart-context">
              <h2 id="chartTitle">NGspice 波形结果</h2>
              <div class="head-actions">
                <div id="chartBadges" class="badges"></div>
                <button id="fitButton" class="tool-button" type="button" title="适应窗口" data-i18n-title="tooltip.fitWaveform">
                  ${iconHtml('fit')}
                  <span data-i18n="action.fit">适应</span>
                </button>
                <button id="traceSelectButton" class="tool-button" type="button" title="选择显示波形" data-i18n-title="tooltip.selectTraces">
                  ${iconHtml('traces')}
                  <span data-i18n="action.traces">曲线</span>
                </button>
                <button id="displayButton" class="tool-button active" type="button" title="切换线/点显示" data-i18n-title="tooltip.displayMode">
                  ${iconHtml('display')}
                  <span data-i18n="display.label">显示：</span><span id="displayLabel">仅线</span>
                </button>
                <button id="cursorModeButton" class="tool-button active" type="button" title="切换数值线模式" data-i18n-title="tooltip.cursorMode">
                  ${iconHtml('cursor')}
                  <span data-i18n="cursor.label">数值：</span><span id="cursorModeLabel">跟随</span>
                </button>
              </div>
            </div>
            <div id="histogramChartContext" class="chart-context hidden">
              <h2 id="histogramTitle">Monte Carlo 分布直方图</h2>
              <div class="head-actions histogram-actions">
                <div id="histogramBadges" class="badges"></div>
                <button id="histogramFitButton" class="tool-button" type="button" title="恢复完整直方图范围" data-i18n-title="tooltip.fitHistogram">
                  ${iconHtml('fit')}
                  <span data-i18n="action.fit">适应</span>
                </button>
                <label class="histogram-measurement-control">
                  <span data-i18n="histogram.measurement">测量项</span>
                  <select id="histogramMeasurementSelect" class="eda-select" aria-label="直方图测量项" data-i18n-aria-label="aria.histogramMeasurement"></select>
                </label>
                <div class="histogram-mode-control" aria-label="直方图纵轴模式" data-i18n-aria-label="aria.histogramYAxis">
                  <button id="histogramCountButton" class="histogram-mode-button active" type="button" data-i18n="histogram.frequency">频数</button>
                  <button id="histogramPercentButton" class="histogram-mode-button" type="button" data-i18n="histogram.percent">占比</button>
                </div>
                <label class="histogram-spec-control">
                  <input id="histogramSpecToggle" type="checkbox" checked />
                  <span data-i18n="histogram.spec">规格线</span>
                </label>
              </div>
            </div>
            <div id="logicChartContext" class="chart-context hidden">
              <h2 data-i18n="analysis.view.logic">逻辑分析</h2>
              <div class="head-actions">
                <button id="logicFitButton" class="tool-button" type="button" title="适应窗口" data-i18n-title="tooltip.fitWaveform">
                  ${iconHtml('fit')}
                  <span data-i18n="action.fit">适应</span>
                </button>
                <button id="logicTraceSelectButton" class="tool-button" type="button" title="选择显示波形" data-i18n-title="tooltip.selectTraces">
                  ${iconHtml('traces')}
                  <span data-i18n="action.traces">曲线</span>
                </button>
                <button id="logicDisplayButton" class="tool-button active" type="button" title="切换线/点显示" data-i18n-title="tooltip.displayMode">
                  ${iconHtml('display')}
                  <span data-i18n="display.label">显示：</span><span id="logicDisplayLabel">仅线</span>
                </button>
                <button id="logicCursorModeButton" class="tool-button active" type="button" title="切换数值线模式" data-i18n-title="tooltip.cursorMode">
                  ${iconHtml('cursor')}
                  <span data-i18n="cursor.label">数值：</span><span id="logicCursorModeLabel">跟随</span>
                </button>
              </div>
            </div>
            <div class="analysis-common-actions">
              <button id="waveformExportButton" class="tool-button" type="button" title="导出当前仿真的全部波形数据" data-i18n-title="tooltip.exportWaveform" disabled>
                ${iconHtml('export')}
                <span data-i18n="action.export">导出</span>
              </button>
              <button id="expandButton" class="tool-button" type="button" title="单独放大图表" data-i18n-title="tooltip.expandChart">
                ${iconHtml('expand')}
                <span data-i18n="action.expand">放大</span>
              </button>
            </div>
          </div>
          <div id="analysisViewTabs" class="analysis-view-tabs hidden" role="tablist" aria-label="分析视图" data-i18n-aria-label="aria.analysisViews">
            <button id="waveformViewTab" class="analysis-view-tab active" type="button" role="tab" aria-selected="true" data-view="waveform" data-i18n="analysis.view.waveform">波形图</button>
            <button id="histogramViewTab" class="analysis-view-tab" type="button" role="tab" aria-selected="false" data-view="histogram" data-i18n="analysis.view.histogram">分布直方图</button>
            <button id="logicViewTab" class="analysis-view-tab hidden" type="button" role="tab" aria-selected="false" data-view="logic" data-i18n="analysis.view.logic">逻辑分析</button>
          </div>
          <div id="resultTabs" class="result-tabs hidden"></div>
          <div class="plot-shell">
            <div id="chart"></div>
            <div id="histogramChart" class="hidden"></div>
            <div id="logicChart" class="hidden"></div>
          </div>
        </article>
      </section>
    </main>

    <div id="horizontalSplitter" class="splitter splitter-horizontal" title="拖动调整底部面板高度" data-i18n-title="tooltip.resizeBottom"></div>

    <section class="bottom-panel">
      <div class="bottom-content">
        <section id="bottomLogPanel" class="bottom-pane log-pane active">
          <pre id="logOutput" class="log-output"></pre>
          <button id="clearLogButton" class="log-clear-button" type="button" title="清空运行日志" data-i18n-title="tooltip.clearLog">
            ${iconHtml('clear')}
            <span data-i18n="action.clearLog">清空日志</span>
          </button>
        </section>
        <section id="mcSummaryPanel" class="bottom-pane">
          <div id="mcSummaryTable" class="mc-table-wrap"></div>
        </section>
        <section id="mcSamplesPanel" class="bottom-pane">
          <div id="mcSampleTable" class="mc-table-wrap"></div>
        </section>
        <section id="wcSummaryPanel" class="bottom-pane">
          <div id="wcSummaryTable" class="mc-table-wrap"></div>
        </section>
        <section id="wcImpactPanel" class="bottom-pane">
          <div id="wcImpactTable" class="mc-table-wrap"></div>
        </section>
        <section id="wcCasesPanel" class="bottom-pane">
          <div id="wcCasesTable" class="mc-table-wrap"></div>
        </section>
      </div>
      <div class="bottom-tabs">
        <button class="bottom-tab active" type="button" data-panel="log" data-i18n="bottom.log">运行日志</button>
        <button id="mcSummaryTab" class="bottom-tab hidden" type="button" data-panel="mcSummary" data-i18n="bottom.summary">统计摘要</button>
        <button id="mcSamplesTab" class="bottom-tab hidden" type="button" data-panel="mcSamples" data-i18n="bottom.samples">样本数据</button>
        <button id="wcSummaryTab" class="bottom-tab hidden" type="button" data-panel="wcSummary" data-i18n="bottom.wcSummary">结果摘要</button>
        <button id="wcImpactTab" class="bottom-tab hidden" type="button" data-panel="wcImpact" data-i18n="bottom.wcImpact">参数影响</button>
        <button id="wcCasesTab" class="bottom-tab hidden" type="button" data-panel="wcCases" data-i18n="bottom.wcCases">运行明细</button>
        <span id="mcStatusText" class="bottom-status hidden">未运行</span>
        <button id="mcExportButton" class="eda-button default compact hidden" type="button">
          ${iconHtml('export')}
          <span data-i18n="action.exportSamplesCsv">导出样本 CSV</span>
        </button>
        <span id="wcStatusText" class="bottom-status hidden">未运行</span>
        <button id="wcExportButton" class="eda-button default compact hidden" type="button">
          ${iconHtml('export')}
          <span data-i18n="action.exportWorstCaseCsv">导出结果 CSV</span>
        </button>
      </div>
    </section>

    <div id="traceDialog" class="modal-mask hidden" role="dialog" aria-modal="true">
      <div class="lc-modal trace-dialog">
        <div class="lc-modal__header">
          <h2 data-i18n="dialog.traceTitle">选择显示波形</h2>
          <button id="closeTraceDialog" class="modal-close" type="button" title="关闭" data-i18n-title="tooltip.close">×</button>
        </div>
        <div class="lc-modal__body">
          <div class="trace-dialog-toolbar">
            <input id="traceFilterInput" class="trace-filter-input" type="search" placeholder="筛选曲线名" aria-label="筛选曲线名" data-i18n-placeholder="dialog.filterPlaceholder" data-i18n-aria-label="dialog.filterPlaceholder" />
            <span id="traceCount" class="eda-tag neutral">0/0 已选</span>
            <button id="traceAllButton" class="eda-button default compact" type="button" data-i18n="action.selectAll">全选</button>
            <button id="traceClearButton" class="eda-button default compact" type="button" data-i18n="action.clear">清空</button>
            <button id="traceInvertButton" class="eda-button default compact" type="button" data-i18n="action.invert">反选</button>
          </div>
          <div id="traceList" class="trace-list"></div>
        </div>
        <div class="lc-modal__footer">
          <button id="traceCancelButton" class="eda-button default" type="button" data-i18n="action.cancel">取消</button>
          <button id="traceApplyButton" class="eda-button primary" type="button" data-i18n="action.applySelection">显示选中</button>
        </div>
      </div>
    </div>
  </div>
`;

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  buildCurrentStatus,
  buildDailyClearSeries,
  buildForecast,
  findHighTideRuns,
  findLowTideRuns,
  findWaveEvents,
  filterCases,
  getDateTickInterval,
  getRegionGroup,
  hasNote,
  movingAverage,
  normalizeChartView,
} from './analytics';
import type {
  CaseRecord,
  ChartWindowDays,
  CurrentStatus,
  DailyClearPoint,
  Filters,
  ForecastPoint,
  LowTideThreshold,
  TimeRangeDays,
  VisaGroup,
  VisaSubtype,
  WebData,
} from './types';
import { DONATE_PATH, DONATE_QR_PATH, GITHUB_URL } from './site';

const DEFAULT_FILTERS: Filters = {
  checkDepth: 'gte60',
  noteCohort: 'all',
  region: 'all',
  selectedDate: null,
  timeRangeDays: 'all',
  visaGroup: 'all',
  visaSubtype: 'all',
};

const numberFormatter = new Intl.NumberFormat('zh-CN');
const TIME_RANGE_MAP: Record<string, TimeRangeDays> = {
  all: 'all',
  '30': 30,
  '60': 60,
  '90': 90,
  '180': 180,
};
const LOW_TIDE_THRESHOLD_MAP: Record<string, LowTideThreshold> = {
  '1': 1,
  '2': 2,
  '5': 5,
};
const VISA_SUBTYPE_OPTIONS: Record<VisaGroup, Array<{ value: VisaSubtype; label: string }>> = {
  all: [{ value: 'all', label: '全部类型' }],
  b: [{ value: 'all', label: 'B1 + B2' }],
  other: [{ value: 'all', label: '其他类型' }],
  work: [
    { value: 'all', label: 'H + L + O' },
    { value: 'h', label: 'H' },
    { value: 'l', label: 'L' },
    { value: 'o', label: 'O' },
  ],
  student: [
    { value: 'all', label: 'F + J' },
    { value: 'f', label: 'F' },
    { value: 'j', label: 'J' },
  ],
};

export default function App() {
  const [data, setData] = useState<WebData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [lowTideThreshold, setLowTideThreshold] = useState<LowTideThreshold>(5);
  const [chartWindowDays, setChartWindowDays] = useState<ChartWindowDays>(180);
  const [chartOffset, setChartOffset] = useState(0);
  const [route, setRoute] = useState(window.location.pathname);

  useEffect(() => {
    fetch('/data/app-data.json')
      .then((response) => {
        if (!response.ok) {
          throw new Error(`加载数据失败：${response.status}`);
        }
        return response.json() as Promise<WebData>;
      })
      .then(setData)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '加载数据失败');
      });
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const consulates = useMemo(() => {
    if (!data) {
      return [];
    }
    return [...new Set(data.cases.map((record) => record.consulate))].sort((left, right) =>
      left.localeCompare(right),
    );
  }, [data]);

  const filteredCases = useMemo(() => (data ? filterCases(data.cases, filters) : []), [data, filters]);
  const clearSeries = useMemo(() => buildDailyClearSeries(filteredCases), [filteredCases]);
  const chartView = useMemo(
    () => normalizeChartView(chartWindowDays, chartOffset, clearSeries.length),
    [chartOffset, chartWindowDays, clearSeries.length],
  );
  const fullAverageSeries = useMemo(() => movingAverage(clearSeries, 7), [clearSeries]);
  const visibleClearSeries = useMemo(() => sliceSeriesByWindow(clearSeries, chartView.windowDays, chartView.offset), [chartView, clearSeries]);
  const averageSeries = useMemo(() => sliceSeriesByWindow(fullAverageSeries, chartView.windowDays, chartView.offset), [chartView, fullAverageSeries]);
  const lowTideRuns = useMemo(
    () => findLowTideRuns(clearSeries, lowTideThreshold, 5).slice(0, 5),
    [clearSeries, lowTideThreshold],
  );
  const highTideRuns = useMemo(() => findHighTideRuns(clearSeries, 8, 3).slice(0, 5), [clearSeries]);
  const allLowTideRuns = useMemo(() => findLowTideRuns(clearSeries, lowTideThreshold, 5), [clearSeries, lowTideThreshold]);
  const forecast = useMemo(() => buildForecast(clearSeries, highTideRuns, allLowTideRuns, 30), [allLowTideRuns, clearSeries, highTideRuns]);
  const currentStatus = useMemo(
    () => buildCurrentStatus(clearSeries, lowTideThreshold, 5),
    [clearSeries, lowTideThreshold],
  );
  const waveEvents = useMemo(
    () => findWaveEvents(allLowTideRuns, highTideRuns, 10).slice(0, 3),
    [allLowTideRuns, highTideRuns],
  );
  const selectedCases = useMemo(() => {
    if (!filters.selectedDate) {
      return [];
    }
    return filteredCases
      .filter((record) => record.status === 'Clear' && record.complete_date === filters.selectedDate)
      .sort((left, right) => {
        if (hasNote(left) !== hasNote(right)) {
          return hasNote(left) ? -1 : 1;
        }
        return (right.waiting_days ?? 0) - (left.waiting_days ?? 0);
      });
  }, [filteredCases, filters.selectedDate]);
  const metrics = useMemo(() => buildMetrics(filteredCases), [filteredCases]);
  const canPanOlder = chartView.offset + chartView.windowDays < clearSeries.length;
  const canPanNewer = chartView.offset > 0;

  if (route === DONATE_PATH) {
    return <DonatePage onNavigateHome={() => navigate('/')} />;
  }

  if (error) {
    return <main className="page"><p className="error">{error}</p></main>;
  }

  if (!data) {
    return <main className="page"><p className="muted">正在加载趋势数据...</p></main>;
  }

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Check Trending</p>
          <h1>签证 Check 出签趋势</h1>
          <p className="lede">
            观察每日 Clear 数量、签证类型趋势、深度 Check 和有 Note 的重点更新人群。
          </p>
          <nav className="hero-links" aria-label="站点链接">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={DONATE_PATH} onClick={(event) => {
              event.preventDefault();
              navigate(DONATE_PATH);
            }}>Donate</a>
          </nav>
        </div>
        <div className="freshness">
          <span>数据范围</span>
          <strong>{data.summary.start_date} 至 {data.summary.end_date}</strong>
          <span>生成时间：{data.summary.generated_at}</span>
        </div>
      </header>

      <section className="filters" aria-label="趋势筛选">
        <Select label="签证组" value={filters.visaGroup} onChange={(visaGroup) => updateFilters({ visaGroup, visaSubtype: getDefaultVisaSubtype(visaGroup) })}>
          <option value="all">全部</option>
          <option value="work">工作签 H/L/O</option>
          <option value="student">学生/学者 F/J</option>
          <option value="b">B 签 B1/B2</option>
        </Select>
        <Select label="签证细分" value={filters.visaSubtype} disabled={filters.visaGroup === 'all' || filters.visaGroup === 'b'} onChange={(visaSubtype) => updateFilters({ visaSubtype })}>
          {getVisaSubtypeOptions(filters.visaGroup).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
        <Select label="Check 深度" value={filters.checkDepth} onChange={(checkDepth) => updateFilters({ checkDepth })}>
          <option value="all">全部</option>
          <option value="gte7">7 天及以上</option>
          <option value="gte30">30 天及以上</option>
          <option value="gte60">60 天及以上</option>
          <option value="gte90">90 天及以上</option>
        </Select>
        <Select label="Note 人群" value={filters.noteCohort} onChange={(noteCohort) => updateFilters({ noteCohort })}>
          <option value="all">全部</option>
          <option value="withNote">有 Note</option>
          <option value="withoutNote">无 Note</option>
        </Select>
        <Select label="地区/领馆" value={filters.region} onChange={(region) => updateFilters({ region })}>
          <option value="all">全部</option>
          <option value="mainland">大陆</option>
          <option value="overseas">海外</option>
          {consulates.map((consulate) => (
            <option key={consulate} value={consulate}>{consulate}</option>
          ))}
        </Select>
        <Select label="时间范围" value={String(filters.timeRangeDays)} onChange={(timeRangeDays) => updateFilters({ timeRangeDays: parseTimeRange(timeRangeDays) })}>
          <option value="all">全部</option>
          <option value="30">最近 30 天</option>
          <option value="60">最近 60 天</option>
          <option value="90">最近 90 天</option>
          <option value="180">最近 180 天</option>
        </Select>
      </section>

      <section className="metrics">
        <Metric label="筛选后样本" value={metrics.total} />
        <Metric label="Clear" value={metrics.clear} />
        <Metric label="Pending" value={metrics.pending} />
        <Metric label="有 Note" value={metrics.withNote} />
        <Metric label="Median 等待" value={`${metrics.medianWait} 天`} />
        <Metric label="P90 等待" value={`${metrics.p90Wait} 天`} />
      </section>

      <section className="status-grid">
        <CurrentStatusCard status={currentStatus} threshold={lowTideThreshold} />
        <ForecastCard forecast={forecast} />
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>每日 Clear 趋势</h2>
            <p>柱状图为自然日每日 Clear 数量，0 clear 的日期也会显示。折线为 7 日移动平均，深色部分代表当天 Clear 中有 Note 的 case。</p>
          </div>
          <div className="chart-actions">
            <label className="zoom-field">
              <span>缩放：{chartView.windowDays} 天</span>
              <input
                type="range"
                min={14}
                max={Math.max(14, clearSeries.length)}
                value={chartView.windowDays}
                onChange={(event) => updateChartView(Number(event.target.value), 0)}
              />
            </label>
            <button className="ghost-button" onClick={() => updateChartView(chartView.windowDays * 0.72, chartView.offset)}>放大</button>
            <button className="ghost-button" onClick={() => updateChartView(chartView.windowDays * 1.38, chartView.offset)}>缩小</button>
            <button className="ghost-button" disabled={!canPanOlder} onClick={() => updateChartView(chartView.windowDays, chartView.offset + Math.round(chartView.windowDays * 0.5))}>更早</button>
            <button className="ghost-button" disabled={!canPanNewer} onClick={() => updateChartView(chartView.windowDays, Math.max(0, chartView.offset - Math.round(chartView.windowDays * 0.5)))}>更新</button>
            {filters.selectedDate && (
              <button className="ghost-button" onClick={() => updateFilters({ selectedDate: null })}>取消日期选择</button>
            )}
          </div>
        </div>
        <ClearWaveChart
          series={visibleClearSeries}
          averageSeries={averageSeries}
          forecast={chartView.offset === 0 ? forecast : []}
          selectedDate={filters.selectedDate}
          onWheel={(deltaX, deltaY, shouldZoom) => {
            if (shouldZoom) {
              updateChartView(chartView.windowDays * (deltaY > 0 ? 1.12 : 0.88), chartView.offset);
              return;
            }
            updateChartView(chartView.windowDays, chartView.offset + Math.round(deltaX / 18));
          }}
          onSelectDate={(selectedDate) => updateFilters({ selectedDate })}
        />
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>趋势摘要</h2>
            <p>把低潮期和随后 10 天内出现的高峰期配对，观察是否存在积压后集中出签。</p>
          </div>
        </div>
        <WaveEventList events={waveEvents} />
      </section>

      <section className="split">
        <div className="panel">
          <h2>当天 Clear Cases</h2>
          {filters.selectedDate ? (
            <CaseTable cases={selectedCases} />
          ) : (
            <p className="muted">点击上方任意日期柱子查看当天 Clear 的 case。会优先展示有 Note 的记录。</p>
          )}
        </div>
        <div className="panel">
          <div className="compact-heading">
            <h2>低潮期</h2>
            <Select label="阈值" value={String(lowTideThreshold)} onChange={(value) => setLowTideThreshold(parseLowTideThreshold(value))}>
              <option value="1">≤ 1 个/天</option>
              <option value="2">≤ 2 个/天</option>
              <option value="5">≤ 5 个/天</option>
            </Select>
          </div>
          <p className="muted">当前筛选下，连续 5 天及以上每日 Clear 不超过 {lowTideThreshold} 个的区间。默认适合观察全量 deep check 是否整体低速。</p>
          <LowTideList runs={lowTideRuns} />
        </div>
      </section>
      <footer className="footer-note">
        <span>登记公开 case 去 <a href="https://www.checkee.info/" target="_blank" rel="noreferrer">Checkee.info</a>。</span>
        <span>个人 case tracking 请使用相关 app 或 <a href="https://ceacmonitor.com/" target="_blank" rel="noreferrer">CEAC Monitor</a>。</span>
      </footer>
    </main>
  );

  function updateFilters(update: Partial<Filters>) {
    setFilters((current) => ({ ...current, selectedDate: current.selectedDate, ...update }));
  }

  function updateChartView(windowDays: number, offset: number) {
    const next = normalizeChartView(windowDays, offset, clearSeries.length);
    setChartWindowDays(next.windowDays);
    setChartOffset(next.offset);
  }

  function navigate(path: string) {
    window.history.pushState({}, '', path);
    setRoute(path);
  }
}

function DonatePage({ onNavigateHome }: { onNavigateHome: () => void }) {
  return (
    <main className="page donate-page">
      <a className="back-link" href="/" onClick={(event) => {
        event.preventDefault();
        onNavigateHome();
      }}>返回趋势页</a>
      <section className="donate-card">
        <p className="eyebrow">Donate</p>
        <h1>支持 Check Trending</h1>
        <p className="lede">可以通过微信收款码支持服务器维护。</p>
        <img className="donate-qr" src={DONATE_QR_PATH} alt="微信收款码" />
        <p className="muted">谢谢支持。</p>
      </section>
    </main>
  );
}

function CurrentStatusCard({ status, threshold }: { status: CurrentStatus; threshold: LowTideThreshold }) {
  return (
    <section className="panel status-card">
      <h2>当前状态</h2>
      {status.currentLow ? (
        <p className="status-title">当前处于低潮：已持续 {status.currentLow.days} 天</p>
      ) : (
        <p className="status-title">当前未处于低潮</p>
      )}
      <div className="status-stats">
        <span>最近 7 天 Clear {status.clears7d} 个</span>
        <span>最近 14 天 Clear {status.clears14d} 个</span>
        <span>最近 30 天 Clear {status.clears30d} 个</span>
      </div>
      <p className="muted">低潮定义：连续 5 天及以上每日 Clear 不超过 {threshold} 个。</p>
    </section>
  );
}

function ForecastCard({ forecast }: { forecast: ForecastPoint[] }) {
  const total = Math.round(forecast.reduce((sum, point) => sum + point.value, 0));
  return (
    <section className="panel status-card">
      <h2>未来 30 天趋势估计</h2>
      <div className="forecast-totals">
        <span>预计 Clear {total} 个</span>
      </div>
      <p className="muted">灰色虚线基于近期速度和历史反弹做平滑外推，不是个人 case 预测。</p>
    </section>
  );
}

function LowTideList({ runs }: { runs: ReturnType<typeof findLowTideRuns> }) {
  if (runs.length === 0) {
    return <p className="muted">当前筛选下没有明显低潮期。</p>;
  }
  return (
    <div className="low-tide-list">
      {runs.map((run) => (
        <div className="low-tide" key={`${run.startDate}-${run.endDate}`}>
          <strong>{run.startDate} 至 {run.endDate}</strong>
          <span>{run.days} 天，合计 Clear {run.totalClears} 个</span>
        </div>
      ))}
    </div>
  );
}

function WaveEventList({ events }: { events: ReturnType<typeof findWaveEvents> }) {
  if (events.length === 0) {
    return <p className="muted">当前筛选下还没有识别到低潮后的集中出签。</p>;
  }
  return (
    <div className="wave-event-list">
      {events.map((event) => (
        <div className="wave-event" key={`${event.low.startDate}-${event.high.startDate}`}>
          <div>
            <span>低潮期</span>
            <strong>{event.low.startDate} 至 {event.low.endDate}</strong>
            <small>{event.low.days} 天，Clear {event.low.totalClears} 个</small>
          </div>
          <div>
            <span>高峰期</span>
            <strong>{event.high.startDate} 至 {event.high.endDate}</strong>
            <small>{event.high.days} 天，Clear {event.high.totalClears} 个</small>
          </div>
          <div>
            <span>间隔</span>
            <strong>{event.gapDays} 天</strong>
            <small>低潮结束后</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function Select<T extends string>({
  children,
  disabled,
  label,
  onChange,
  value,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onChange: (value: T) => void;
  value: T;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value as T)}>
        {children}
      </select>
    </label>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{typeof value === 'number' ? numberFormatter.format(value) : value}</strong>
    </div>
  );
}

function ClearWaveChart({
  averageSeries,
  forecast,
  onWheel,
  onSelectDate,
  selectedDate,
  series,
}: {
  averageSeries: { date: string; value: number }[];
  forecast: ForecastPoint[];
  onWheel: (deltaX: number, deltaY: number, shouldZoom: boolean) => void;
  onSelectDate: (date: string) => void;
  selectedDate: string | null;
  series: DailyClearPoint[];
}) {
  if (series.length === 0) {
    return <p className="muted">当前筛选条件下没有 Clear 数据。</p>;
  }

  const width = 920;
  const height = 360;
  const padding = { top: 24, right: 24, bottom: 42, left: 48 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const forecastValues = forecast.map((point) => point.value);
  const maxCount = Math.max(...series.map((point) => point.count), ...averageSeries.map((point) => point.value), ...forecastValues, 1);
  const totalPoints = series.length + forecast.length;
  const minStep = getMinChartStep(series.length);
  const step = Math.max(plotWidth / totalPoints, minStep);
  const actualPlotWidth = step * totalPoints;
  const barWidth = Math.max(1.5, step - 1);
  const tickInterval = getDateTickInterval(series.length);

  const xForIndex = (index: number) => padding.left + (index + 0.5) * step;
  const yForValue = (value: number) => padding.top + plotHeight - (value / maxCount) * plotHeight;
  const averagePath = smoothPath(averageSeries.map((point, index) => ({
    x: xForIndex(index),
    y: yForValue(point.value),
  })));
  const forecastStart = averageSeries[averageSeries.length - 1];
  const forecastPath = smoothPath([
    ...(forecastStart ? [{ x: xForIndex(series.length - 1), y: yForValue(forecastStart.value) }] : []),
    ...forecast.map((point, index) => ({
      x: xForIndex(series.length + index),
      y: yForValue(point.value),
    })),
  ]);

  return (
    <div
      className="chart-wrap"
      onWheel={(event) => {
        event.preventDefault();
        onWheel(event.deltaX, event.deltaY, event.ctrlKey || Math.abs(event.deltaY) > Math.abs(event.deltaX));
      }}
    >
      <svg className="chart" width={actualPlotWidth + padding.left + padding.right} viewBox={`0 0 ${actualPlotWidth + padding.left + padding.right} ${height}`} role="img" aria-label="每日 Clear 趋势图">
        <line x1={padding.left} y1={padding.top + plotHeight} x2={padding.left + actualPlotWidth} y2={padding.top + plotHeight} />
        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + plotHeight} />
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding.top + plotHeight - ratio * plotHeight;
          return (
            <g key={ratio}>
              <line className="grid-line" x1={padding.left} y1={y} x2={padding.left + actualPlotWidth} y2={y} />
              <text x={12} y={y + 4}>{Math.round(maxCount * ratio)}</text>
            </g>
          );
        })}
        {series.map((point, index) => {
          const x = xForIndex(index) - barWidth / 2;
          const totalHeight = padding.top + plotHeight - yForValue(point.count);
          const noteHeight = point.count === 0 ? 0 : totalHeight * (point.noteCount / point.count);
          return (
            <g key={point.date}>
              <title>{`${point.date}: Clear ${point.count}, 有 Note ${point.noteCount}`}</title>
              <rect
                className={point.date === selectedDate ? 'bar selected' : 'bar'}
                x={x}
                y={yForValue(point.count)}
                width={barWidth}
                height={totalHeight}
                onClick={() => onSelectDate(point.date)}
              />
              {noteHeight > 0 && (
                <rect
                  className="bar-note"
                  x={x}
                  y={padding.top + plotHeight - noteHeight}
                  width={barWidth}
                  height={noteHeight}
                  onClick={() => onSelectDate(point.date)}
                />
              )}
            </g>
          );
        })}
        <path className="avg-line" d={averagePath} />
        <path className="forecast-line" d={forecastPath} />
        {series.map((point, index) => {
          if (index !== 0 && index !== series.length - 1 && !shouldShowDateTick(point.date, tickInterval)) {
            return null;
          }
          return <text key={point.date} className="date-label" x={xForIndex(index) - 18} y={height - 12}>{point.date.slice(5)}</text>;
        })}
      </svg>
    </div>
  );
}

function CaseTable({ cases }: { cases: CaseRecord[] }) {
  if (cases.length === 0) {
    return <p className="muted">这一天在当前筛选条件下没有 Clear case。</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Case</th>
            <th>签证</th>
            <th>领馆</th>
            <th>Check</th>
            <th>Clear</th>
            <th>等待</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((record) => (
            <tr key={record.case_number}>
              <td><a href={record.detail_url} target="_blank" rel="noreferrer">{record.case_number}</a></td>
              <td>{record.visa_type}</td>
              <td>{record.consulate} / {getRegionGroup(record.consulate) === 'mainland' ? '大陆' : '海外'}</td>
              <td>{record.check_date}</td>
              <td>{record.complete_date}</td>
              <td>{record.waiting_days ?? '-'} 天</td>
              <td className="note-cell">{record.detail.Note || '无'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) {
    return '';
  }
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }
  return points.reduce((path, point, index) => {
    if (index === 0) {
      return `M ${point.x} ${point.y}`;
    }
    const previous = points[index - 1];
    const controlX = (previous.x + point.x) / 2;
    return `${path} C ${controlX} ${previous.y}, ${controlX} ${point.y}, ${point.x} ${point.y}`;
  }, '');
}

function getMinChartStep(dayCount: number): number {
  if (dayCount <= 35) {
    return 30;
  }
  if (dayCount <= 70) {
    return 18;
  }
  if (dayCount <= 120) {
    return 12;
  }
  return 5;
}

function shouldShowDateTick(date: string, tickInterval: number): boolean {
  if (tickInterval === 1) {
    return true;
  }
  const day = Number(date.slice(8, 10));
  return day === 1 || (day - 1) % tickInterval === 0;
}

function buildMetrics(records: CaseRecord[]) {
  const waits = records
    .map((record) => record.waiting_days)
    .filter((waitingDays): waitingDays is number => waitingDays !== null)
    .sort((left, right) => left - right);
  return {
    total: records.length,
    clear: records.filter((record) => record.status === 'Clear').length,
    pending: records.filter((record) => record.status === 'Pending').length,
    withNote: records.filter(hasNote).length,
    medianWait: percentile(waits, 0.5),
    p90Wait: percentile(waits, 0.9),
  };
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * ratio))];
}

function parseTimeRange(value: string): TimeRangeDays {
  return TIME_RANGE_MAP[value] ?? 'all';
}

function parseLowTideThreshold(value: string): LowTideThreshold {
  return LOW_TIDE_THRESHOLD_MAP[value] ?? 1;
}

function getDefaultVisaSubtype(visaGroup: VisaGroup): VisaSubtype {
  return VISA_SUBTYPE_OPTIONS[visaGroup][0].value;
}

function getVisaSubtypeOptions(visaGroup: VisaGroup) {
  return VISA_SUBTYPE_OPTIONS[visaGroup];
}

function sliceSeriesByWindow<T>(series: T[], windowDays: ChartWindowDays, offset: number): T[] {
  const end = Math.max(0, series.length - offset);
  return series.slice(Math.max(0, end - windowDays), end);
}

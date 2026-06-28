import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  buildCurrentStatus,
  buildDailyClearSeries,
  buildPendingBacklog,
  findLowTideRuns,
  filterCases,
  getDateTickIndexes,
  getRegionGroup,
  hasNote,
  movingAverage,
} from './analytics';
import type {
  CaseRecord,
  CurrentStatus,
  DailyClearPoint,
  Filters,
  LowTideThreshold,
  PendingBacklog,
  TimeRangeDays,
  VisaGroup,
  VisaSubtype,
  WebData,
} from './types';
import { DONATE_PATH, DONATE_QR_PATH, GITHUB_URL, NOTES_PATH } from './site';

// Code-split: the /notes page (and its search helpers) load only when visited.
const NotesPage = lazy(() => import('./NotesPage'));
import { THEME_STORAGE_KEY, parseThemePreference, resolveTheme, type ThemePreference } from './theme';
import { buildSearchFromViewState, readViewStateFromSearch } from './viewState';

const DEFAULT_FILTERS: Filters = {
  checkDepth: 'all',
  noteCohort: 'all',
  region: 'all',
  selectedDate: null,
  timeRangeDays: 'all',
  visaGroup: 'all',
  visaSubtype: 'all',
};
const DEFAULT_LOW_TIDE_THRESHOLD: LowTideThreshold = 5;

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
const CHART_PADDING = { top: 24, right: 56, bottom: 42, left: 48 } as const;
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
  const initialViewState = useMemo(
    () => readViewStateFromSearch(window.location.search, DEFAULT_FILTERS, DEFAULT_LOW_TIDE_THRESHOLD),
    [],
  );
  const [data, setData] = useState<WebData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageviewsTotal, setPageviewsTotal] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(initialViewState.filters);
  const [lowTideThreshold, setLowTideThreshold] = useState<LowTideThreshold>(initialViewState.lowTideThreshold);
  const [mobileFiltersExpanded, setMobileFiltersExpanded] = useState(false);
  const [dayWidth, setDayWidth] = useState(8);
  const [route, setRoute] = useState(window.location.pathname);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY)),
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const resolvedTheme = useMemo(
    () => resolveTheme(themePreference, systemPrefersDark),
    [themePreference, systemPrefersDark],
  );

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
    const controller = new AbortController();
    fetch('https://song.goatcounter.com/counter/TOTAL.json', { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<{ count?: string }>) : null))
      .then((payload) => {
        if (payload && typeof payload.count === 'string') {
          setPageviewsTotal(payload.count);
        }
      })
      .catch(() => {
        // Silent: adblocker / network failure shouldn't surface to user.
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
  }, [themePreference]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    const onPopState = () => {
      setRoute(window.location.pathname);
      const nextState = readViewStateFromSearch(
        window.location.search,
        DEFAULT_FILTERS,
        DEFAULT_LOW_TIDE_THRESHOLD,
      );
      setFilters(nextState.filters);
      setLowTideThreshold(nextState.lowTideThreshold);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (route === DONATE_PATH || route === NOTES_PATH) {
      return;
    }
    const search = buildSearchFromViewState(
      filters,
      lowTideThreshold,
      DEFAULT_FILTERS,
      DEFAULT_LOW_TIDE_THRESHOLD,
    );
    const path = window.location.pathname;
    const nextUrl = search ? `${path}?${search}` : path;
    const currentUrl = `${path}${window.location.search}`;
    if (currentUrl !== nextUrl) {
      window.history.replaceState({}, '', nextUrl);
    }
  }, [filters, lowTideThreshold, route]);

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
  const averageSeries = useMemo(() => movingAverage(clearSeries, 7), [clearSeries]);
  const lowTideRuns = useMemo(
    () => findLowTideRuns(clearSeries, lowTideThreshold, 5)
      .sort((left, right) => right.endDate.localeCompare(left.endDate))
      .slice(0, 5),
    [clearSeries, lowTideThreshold],
  );
  const currentStatus = useMemo(
    () => buildCurrentStatus(clearSeries, lowTideThreshold, 5),
    [clearSeries, lowTideThreshold],
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
  const pendingBacklog = useMemo(() => buildPendingBacklog(filteredCases), [filteredCases]);
  const activeFilterCount = useMemo(() => countActiveFilters(filters), [filters]);
  const mobileFilterLabel = useMemo(() => {
    if (mobileFiltersExpanded) {
      return '收起筛选条件';
    }
    if (activeFilterCount === 0) {
      return '展开筛选条件';
    }
    return `展开筛选条件（已选 ${activeFilterCount}）`;
  }, [activeFilterCount, mobileFiltersExpanded]);

  if (route === DONATE_PATH) {
    return <DonatePage onNavigateHome={() => navigate('/')} />;
  }

  if (route === NOTES_PATH) {
    return (
      <Suspense fallback={<main className="page"><p className="muted">正在加载 Note 搜索…</p></main>}>
        <NotesPage
          onNavigateHome={() => navigate('/')}
          themeControl={<ThemeSwitch preference={themePreference} onChange={setThemePreference} />}
        />
      </Suspense>
    );
  }

  if (error) {
    return <main className="page"><p className="error">{error}</p></main>;
  }

  if (!data) {
    return (
      <main className="page">
        <LoadingSkeleton />
      </main>
    );
  }

  return (
    <main className="page">
      <header className="hero">
        <div className="hero-main">
          <p className="eyebrow">Check Trending</p>
          <h1>签证 Check 出签趋势</h1>
          <p className="lede">
            基于 Checkee 公开样本，观察每日 Clear 节奏与等待时长变化。
          </p>
          <nav className="hero-links" aria-label="站点链接">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={DONATE_PATH} onClick={(event) => {
              event.preventDefault();
              navigate(DONATE_PATH);
            }}>支持</a>
            <ThemeSwitch preference={themePreference} onChange={setThemePreference} />
          </nav>
        </div>
        <div className="hero-aside">
          <div className="freshness">
            <span>数据范围</span>
            <strong>{data.summary.start_date} 至 {data.summary.end_date}</strong>
            <span>更新于 {formatGeneratedAt(data.summary.generated_at)}</span>
          </div>
          <a
            className="notes-cta"
            href={NOTES_PATH}
            onClick={(event) => {
              event.preventDefault();
              navigate(NOTES_PATH);
            }}
          >
            <span className="notes-cta-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <line x1="20.5" y1="20.5" x2="16.5" y2="16.5" />
              </svg>
            </span>
            <span className="notes-cta-text">
              <strong>Note 全文搜索</strong>
              <span>搜 2017 年至今的案例 Note</span>
            </span>
            <span className="notes-cta-arrow" aria-hidden="true">›</span>
          </a>
        </div>
      </header>

      <div className="filters-mobile-control">
        <button
          type="button"
          className="filters-toggle"
          aria-controls="trend-filters"
          aria-expanded={mobileFiltersExpanded}
          onClick={() => setMobileFiltersExpanded((current) => !current)}
        >
          {mobileFilterLabel}
        </button>
      </div>
      <section
        id="trend-filters"
        className={mobileFiltersExpanded ? 'filters mobile-expanded' : 'filters'}
        aria-label="趋势筛选"
      >
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
        <Select label="等待时长" value={filters.checkDepth} onChange={(checkDepth) => updateFilters({ checkDepth })}>
          <option value="all">全部</option>
          <option value="gte7">7 天及以上</option>
          <option value="gte30">30 天及以上</option>
          <option value="gte60">60 天及以上</option>
          <option value="gte90">90 天及以上</option>
          <option value="gte180">180 天及以上</option>
          <option value="gte270">270 天及以上</option>
        </Select>
        <Select label="Note 样本" value={filters.noteCohort} onChange={(noteCohort) => updateFilters({ noteCohort })}>
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
        <Metric label="样本量" value={metrics.total} />
        <Metric label="已 Clear" value={metrics.clear} />
        <Metric label="处理中" value={metrics.pending} />
        <Metric label="含 Note" value={metrics.withNote} />
        <Metric label="中位等待" value={`${metrics.medianWait} 天`} />
        <Metric label="P90 等待" value={`${metrics.p90Wait} 天`} />
      </section>

      <BacklogRow backlog={pendingBacklog} totalPending={metrics.pending} />

      <section className="panel chart-panel">
        <div className="section-heading">
          <div>
            <h2>每日 Clear 趋势</h2>
            <p>柱子表示每天 Clear 数量（含 0 Clear 日期），橙线表示 7 日平均，深蓝部分表示当天含 Note 的 Clear。</p>
          </div>
          <div className="chart-actions">
            <span className="zoom-indicator">图表缩放：{getZoomLabel(dayWidth)}</span>
            <button
              className="icon-button"
              aria-label="放大"
              onClick={() => setDayWidth((current) => clamp(current * 1.2, 3, 30))}
            >
              +
            </button>
            <button
              className="icon-button"
              aria-label="缩小"
              onClick={() => setDayWidth((current) => clamp(current / 1.2, 3, 30))}
            >
              −
            </button>
            {filters.selectedDate && (
              <button className="ghost-button" onClick={() => updateFilters({ selectedDate: null })}>取消日期选择</button>
            )}
          </div>
        </div>
        <ClearWaveChart
          dayWidth={dayWidth}
          series={clearSeries}
          averageSeries={averageSeries}
          selectedDate={filters.selectedDate}
          onSelectDate={(selectedDate) => updateFilters({ selectedDate })}
        />
      </section>

      <section className="split">
        <div className="panel">
          <h2>选中日期 Clear 详情</h2>
          {filters.selectedDate ? (
            <CaseTable cases={selectedCases} />
          ) : (
            <p className="muted">点击上方任意日期柱子查看当天 Clear 记录，列表会优先展示含 Note 的样本。</p>
          )}
        </div>
        <RhythmPanel
          status={currentStatus}
          lowTideRuns={lowTideRuns}
          threshold={lowTideThreshold}
          onThresholdChange={(value) => setLowTideThreshold(parseLowTideThreshold(value))}
        />
      </section>
      <footer className="footer-note" aria-label="数据来源与外部工具">
        <span className="footer-title">数据来源与工具</span>
        <div className="footer-links">
          <a href="https://www.checkee.info/" target="_blank" rel="noreferrer">公开样本登记：Checkee.info</a>
          <a href="https://ceacmonitor.com/" target="_blank" rel="noreferrer">个人进度跟踪：CEAC Monitor</a>
        </div>
        {pageviewsTotal && parseInt(pageviewsTotal.replace(/,/g, ''), 10) > 0 && (
          <p className="pageview-counter">
            累计访问 <strong>{pageviewsTotal}</strong> 次
          </p>
        )}
      </footer>
    </main>
  );

  function updateFilters(update: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...update }));
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

function ThemeSwitch({
  preference,
  onChange,
}: {
  preference: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  const nextPreference = getNextThemePreference(preference);
  const label = getThemePreferenceLabel(preference);
  const nextLabel = getThemePreferenceLabel(nextPreference);
  return (
    <button
      type="button"
      className="theme-icon-button"
      onClick={() => onChange(nextPreference)}
      aria-label={`主题：${label}，点击切换到${nextLabel}`}
      title={`主题：${label}，点击切换到${nextLabel}`}
    >
      {getThemePreferenceIcon(preference)}
    </button>
  );
}

function LoadingSkeleton() {
  return (
    <>
      <section className="hero skeleton-card" aria-hidden="true">
        <div className="skeleton-stack">
          <span className="skeleton-line sm" />
          <span className="skeleton-line lg" />
          <span className="skeleton-line md" />
          <span className="skeleton-line md" />
        </div>
        <div className="skeleton-block" />
      </section>
      <section className="filters skeleton-card" aria-hidden="true">
        <span className="skeleton-field" />
        <span className="skeleton-field" />
        <span className="skeleton-field" />
        <span className="skeleton-field" />
        <span className="skeleton-field" />
        <span className="skeleton-field" />
      </section>
      <section className="metrics" aria-hidden="true">
        <div className="metric skeleton-card" />
        <div className="metric skeleton-card" />
        <div className="metric skeleton-card" />
        <div className="metric skeleton-card" />
        <div className="metric skeleton-card" />
        <div className="metric skeleton-card" />
      </section>
    </>
  );
}

function RhythmPanel({
  lowTideRuns,
  onThresholdChange,
  status,
  threshold,
}: {
  lowTideRuns: ReturnType<typeof findLowTideRuns>;
  onThresholdChange: (value: string) => void;
  status: CurrentStatus;
  threshold: LowTideThreshold;
}) {
  return (
    <section className="panel rhythm-panel">
      <div className="compact-heading">
        <h2>近期节奏与低速区间</h2>
        <Select label="阈值" value={String(threshold)} onChange={onThresholdChange}>
          <option value="1">≤ 1 个/天</option>
          <option value="2">≤ 2 个/天</option>
          <option value="5">≤ 5 个/天</option>
        </Select>
      </div>
      {status.currentLow ? (
        <p className="rhythm-title">已连续低速 {status.currentLow.days} 天</p>
      ) : (
        <p className="rhythm-title">近期不在低速区</p>
      )}
      <div className="status-stats">
        <span>近 7 天 Clear {status.clears7d} 个</span>
        <span>近 14 天 Clear {status.clears14d} 个</span>
        <span>近 30 天 Clear {status.clears30d} 个</span>
      </div>
      <p className="muted">连续 5 天及以上，每日 Clear 不超过 {threshold} 个。</p>
      <LowTideList runs={lowTideRuns} />
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

function BacklogRow({ backlog, totalPending }: { backlog: PendingBacklog[]; totalPending: number }) {
  if (backlog.every((entry) => entry.count === 0)) {
    return null;
  }
  return (
    <section className="backlog" aria-label="仍卡在长 Check 的 Pending 积压">
      <div className="backlog-grid">
        {backlog.map((entry) => {
          const share = totalPending > 0 ? (entry.count / totalPending) * 100 : 0;
          return (
            <div key={entry.threshold} className={`backlog-card backlog-card-${entry.threshold}`}>
              <span>≥{entry.threshold} 天仍 Pending</span>
              <strong>{numberFormatter.format(entry.count)}</strong>
              <span className="backlog-sub">占比 {share.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ClearWaveChart({
  averageSeries,
  dayWidth,
  onSelectDate,
  selectedDate,
  series,
}: {
  averageSeries: { date: string; value: number }[];
  dayWidth: number;
  onSelectDate: (date: string) => void;
  selectedDate: string | null;
  series: DailyClearPoint[];
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [stickToRight, setStickToRight] = useState(true);
  const [visibleYear, setVisibleYear] = useState<string>(
    () => series[series.length - 1]?.date.slice(0, 4) ?? '',
  );
  const [chartWrapHeight, setChartWrapHeight] = useState(0);
  const [wrapTopOffset, setWrapTopOffset] = useState(0);

  const normalizedDayWidth = clamp(dayWidth, 3, 30);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) {
      return;
    }
    if (stickToRight) {
      wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth;
    }
    setVisibleYear(computeVisibleYear(wrap, normalizedDayWidth, series));
  }, [normalizedDayWidth, series, stickToRight]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      setChartWrapHeight(entry.contentRect.height);
      const style = window.getComputedStyle(wrap);
      setWrapTopOffset(
        (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0),
      );
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  if (series.length === 0) {
    return <p className="muted">当前筛选条件下没有 Clear 数据。</p>;
  }

  const height = 360;
  const padding = CHART_PADDING;
  const slotCount = Math.max(series.length, 1);
  const plotWidth = slotCount * normalizedDayWidth;
  const svgWidth = plotWidth + padding.left + padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxCount = Math.max(
    ...series.map((point) => point.count),
    ...averageSeries.map((point) => point.value),
    1,
  );
  const barWidth = Math.max(1.5, normalizedDayWidth - 1.2);
  const minLabelSpacingPx = Math.max(72, normalizedDayWidth * 7);
  const historyTickIndexes = getDateTickIndexes(series.map((point) => point.date), normalizedDayWidth, minLabelSpacingPx);

  const xForHistoryIndex = (index: number) => padding.left + (index + 0.5) * normalizedDayWidth;
  const yForValue = (value: number) => padding.top + plotHeight - (value / maxCount) * plotHeight;
  const averagePath = smoothPath(averageSeries.map((point, index) => ({
    x: xForHistoryIndex(index),
    y: yForValue(point.value),
  })));
  const axisLabelCandidates: AxisLabel[] = historyTickIndexes.map((index) => ({
    key: `history-${series[index].date}`,
    text: series[index].date.slice(5),
    x: xForHistoryIndex(index),
  }));
  const axisLabels = pickSpacedAxisLabels(axisLabelCandidates, minLabelSpacingPx);
  const yAxisRatios = [0, 0.25, 0.5, 0.75, 1];
  const yAxisScale = chartWrapHeight > 0 ? chartWrapHeight / height : 0;
  const yAxisLabels = yAxisScale > 0
    ? yAxisRatios.map((ratio) => ({
        ratio,
        top: wrapTopOffset + (padding.top + plotHeight - ratio * plotHeight) * yAxisScale,
        value: Math.round(maxCount * ratio),
      }))
    : [];

  return (
    <div className="chart-shell">
      <div className="year-indicator" aria-live="polite">{visibleYear}</div>
      {yAxisLabels.length > 0 && (
        <div className="y-axis-floating" aria-hidden="true">
          {yAxisLabels.map(({ ratio, top, value }) => (
            <span key={ratio} className="y-axis-floating-label" style={{ top: `${top}px` }}>
              {value}
            </span>
          ))}
        </div>
      )}
      <div
        className="chart-wrap"
        ref={wrapRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          const remain = target.scrollWidth - target.clientWidth - target.scrollLeft;
          setStickToRight(remain < 36);
          const nextYear = computeVisibleYear(target, normalizedDayWidth, series);
          if (nextYear && nextYear !== visibleYear) {
            setVisibleYear(nextYear);
          }
        }}
      >
        <svg className="chart" width={svgWidth} viewBox={`0 0 ${svgWidth} ${height}`} role="img" aria-label="每日 Clear 趋势图">
        <line x1={padding.left} y1={padding.top + plotHeight} x2={padding.left + plotWidth} y2={padding.top + plotHeight} />
        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + plotHeight} />
        {yAxisRatios.map((ratio) => {
          const y = padding.top + plotHeight - ratio * plotHeight;
          return (
            <line
              key={ratio}
              className="grid-line"
              x1={padding.left}
              y1={y}
              x2={padding.left + plotWidth}
              y2={y}
            />
          );
        })}
        {series.map((point, index) => {
          const x = xForHistoryIndex(index) - barWidth / 2;
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
        {axisLabels.map((label) => (
          <text
            key={label.key}
            className="date-label"
            textAnchor="middle"
            x={label.x}
            y={height - 12}
          >
            {label.text}
          </text>
        ))}
      </svg>
      </div>
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

function getZoomLabel(dayWidth: number): string {
  if (dayWidth >= 14) {
    return '放大';
  }
  if (dayWidth <= 6) {
    return '紧凑';
  }
  return '标准';
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

function countActiveFilters(filters: Filters): number {
  let count = 0;
  if (filters.visaGroup !== DEFAULT_FILTERS.visaGroup) {
    count += 1;
  }
  if (filters.visaSubtype !== DEFAULT_FILTERS.visaSubtype) {
    count += 1;
  }
  if (filters.checkDepth !== DEFAULT_FILTERS.checkDepth) {
    count += 1;
  }
  if (filters.noteCohort !== DEFAULT_FILTERS.noteCohort) {
    count += 1;
  }
  if (filters.region !== DEFAULT_FILTERS.region) {
    count += 1;
  }
  if (filters.timeRangeDays !== DEFAULT_FILTERS.timeRangeDays) {
    count += 1;
  }
  return count;
}

function getNextThemePreference(preference: ThemePreference): ThemePreference {
  if (preference === 'system') {
    return 'light';
  }
  if (preference === 'light') {
    return 'dark';
  }
  return 'system';
}

function getThemePreferenceLabel(preference: ThemePreference): string {
  if (preference === 'system') {
    return '跟随系统';
  }
  if (preference === 'light') {
    return '浅色';
  }
  return '深色';
}

function getThemePreferenceIcon(preference: ThemePreference): string {
  if (preference === 'system') {
    return '◐';
  }
  if (preference === 'light') {
    return '☀';
  }
  return '☾';
}

type AxisLabel = {
  key: string;
  text: string;
  x: number;
};

function pickSpacedAxisLabels(labels: AxisLabel[], minSpacingPx: number): AxisLabel[] {
  const sorted = [...labels].sort((left, right) => left.x - right.x);
  const selected: AxisLabel[] = [];
  for (const label of sorted) {
    const previous = selected[selected.length - 1];
    if (!previous) {
      selected.push(label);
      continue;
    }
    if (label.x - previous.x >= minSpacingPx) {
      selected.push(label);
    }
  }
  return selected;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatGeneratedAt(iso: string): string {
  if (!iso) {
    return '';
  }
  const hasExplicitZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso);
  const date = new Date(hasExplicitZone ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mn = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mn}`;
}

function computeVisibleYear(
  wrap: HTMLDivElement,
  dayWidth: number,
  series: DailyClearPoint[],
): string {
  if (series.length === 0) {
    return '';
  }
  const centerX = wrap.scrollLeft + wrap.clientWidth / 2;
  const slot = Math.floor((centerX - CHART_PADDING.left) / dayWidth);
  const clampedSlot = Math.max(0, Math.min(series.length - 1, slot));
  return series[clampedSlot].date.slice(0, 4);
}

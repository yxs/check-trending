import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  bucketClearSeries,
  buildClearWaitScatter,
  buildDailyClearSeries,
  CLEAR_SCATTER_MAX_DAYS,
  filterCases,
  getDateTickIndexes,
  getRegionGroup,
  granularityForRange,
  isStalePending,
  LONG_CHECK_PENDING_MAX_DAYS,
  movingAverage,
  trailingWindowForGranularity,
} from './analytics';
import type {
  CaseRecord,
  ClearWaitScatter,
  DailyClearPoint,
  DetailSort,
  DetailStatus,
  Filters,
  Granularity,
  TimeRangeDays,
  VisaGroup,
  VisaSubtype,
  WebData,
} from './types';
import { DONATE_PATH, DONATE_QR_PATH, GITHUB_URL, NOTES_PATH } from './site';

const NotesPage = lazy(() => import('./NotesPage'));
import { THEME_STORAGE_KEY, parseThemePreference, resolveTheme, type ThemePreference } from './theme';
import { buildSearchFromViewState, readViewStateFromSearch } from './viewState';
import { detailUrl } from './notes';

const DEFAULT_FILTERS: Filters = {
  region: 'all',
  selectedDate: null,
  timeRangeDays: 'all',
  visaGroup: 'all',
  visaSubtype: 'all',
};

const numberFormatter = new Intl.NumberFormat('zh-CN');
const TIME_RANGE_MAP: Record<string, TimeRangeDays> = {
  all: 'all',
  '90': 90,
  '180': 180,
  '365': 365,
  '730': 730,
};
const CHART_PADDING = { top: 24, right: 56, bottom: 42, left: 48 } as const;
const DETAIL_CAP = 100;
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
    () => readViewStateFromSearch(window.location.search, DEFAULT_FILTERS),
    [],
  );
  const [data, setData] = useState<WebData | null>(null);
  const [caseNotes, setCaseNotes] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageviewsTotal, setPageviewsTotal] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(initialViewState.filters);
  const [chartFocus, setChartFocus] = useState<{ start: string; end: string; label: string } | null>(null);
  const [detailStatus, setDetailStatus] = useState<DetailStatus>(initialViewState.detailStatus);
  const [detailSort, setDetailSort] = useState<DetailSort>(initialViewState.detailSort);
  const detailRef = useRef<HTMLElement | null>(null);
  const notesRequested = useRef(false);
  const [mobileFiltersExpanded, setMobileFiltersExpanded] = useState(false);
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

  // Case Note text is ~80% of the data and only shown in the sample table, so it ships
  // separately and loads lazily when the table nears the viewport (most visitors never
  // scroll there). detail_url is reconstructed from case_number, so it isn't shipped either.
  useEffect(() => {
    const el = detailRef.current;
    if (!el || notesRequested.current) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!notesRequested.current && entries.some((entry) => entry.isIntersecting)) {
          notesRequested.current = true;
          observer.disconnect();
          fetch('/data/case-notes.json')
            .then((response) => (response.ok ? response.json() : {}))
            .then((map) => setCaseNotes(map as Record<string, string>))
            .catch(() => setCaseNotes({}));
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [data]);

  useEffect(() => {
    const controller = new AbortController();
    fetch('https://song.goatcounter.com/counter/TOTAL.json', { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<{ count?: string }>) : null))
      .then((payload) => {
        if (payload && typeof payload.count === 'string') {
          setPageviewsTotal(payload.count);
        }
      })
      .catch(() => {});
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
      const nextState = readViewStateFromSearch(window.location.search, DEFAULT_FILTERS);
      setFilters(nextState.filters);
      setDetailStatus(nextState.detailStatus);
      setDetailSort(nextState.detailSort);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (route === DONATE_PATH || route === NOTES_PATH) {
      return;
    }
    const search = buildSearchFromViewState(filters, DEFAULT_FILTERS, detailStatus, detailSort);
    const path = window.location.pathname;
    const nextUrl = search ? `${path}?${search}` : path;
    const currentUrl = `${path}${window.location.search}`;
    if (currentUrl !== nextUrl) {
      window.history.replaceState({}, '', nextUrl);
    }
  }, [filters, route, detailStatus, detailSort]);

  // Drop cases still Pending past 1 year everywhere — they are resolved-offline/abandoned, not real backlog.
  const cases = useMemo(() => (data ? data.cases.filter((record) => !isStalePending(record)) : []), [data]);

  const consulates = useMemo(
    () => [...new Set(cases.map((record) => record.consulate))].sort((left, right) => left.localeCompare(right)),
    [cases],
  );

  const filteredCases = useMemo(() => filterCases(cases, filters), [cases, filters]);
  const backlogBase = useMemo(
    () => filterCases(cases, { ...filters, timeRangeDays: 'all' }),
    [cases, filters],
  );
  const clearSeries = useMemo(() => buildDailyClearSeries(filteredCases), [filteredCases]);
  const baseGranularity = granularityForRange(filters.timeRangeDays);
  const chartGranularity: Granularity = chartFocus ? 'day' : baseGranularity;
  const chartSeries = useMemo(() => {
    const scoped = chartFocus
      ? clearSeries.filter((point) => point.date >= chartFocus.start && point.date <= chartFocus.end)
      : clearSeries;
    return bucketClearSeries(scoped, chartGranularity);
  }, [clearSeries, chartFocus, chartGranularity]);
  const chartAverage = useMemo(
    () => movingAverage(chartSeries, trailingWindowForGranularity(chartGranularity)),
    [chartSeries, chartGranularity],
  );
  const detailView = useMemo(() => {
    let list: CaseRecord[];
    if (detailStatus === 'over1y') {
      list = clearedWaitInRange(backlogBase, LONG_CHECK_PENDING_MAX_DAYS, Infinity);
    } else if (detailStatus === 'over180') {
      list = clearedWaitInRange(backlogBase, CLEAR_SCATTER_MAX_DAYS, LONG_CHECK_PENDING_MAX_DAYS);
    } else {
      list = filteredCases;
      if (detailStatus !== 'all') {
        list = list.filter((record) => record.status === detailStatus);
      }
      if (filters.selectedDate) {
        list = list.filter((record) => record.complete_date === filters.selectedDate);
      } else if (chartFocus) {
        list = list.filter(
          (record) =>
            record.complete_date != null &&
            record.complete_date >= chartFocus.start &&
            record.complete_date <= chartFocus.end,
        );
      }
    }
    const dir = detailSort.dir === 'asc' ? 1 : -1;
    const sorted = [...list].sort((left, right) => {
      if (detailSort.key === 'wait') {
        return ((left.waiting_days ?? -1) - (right.waiting_days ?? -1)) * dir;
      }
      const leftValue = detailSort.key === 'check' ? left.check_date : left.complete_date ?? '';
      const rightValue = detailSort.key === 'check' ? right.check_date : right.complete_date ?? '';
      return leftValue.localeCompare(rightValue) * dir;
    });
    return { total: sorted.length, rows: sorted.slice(0, DETAIL_CAP), cap: DETAIL_CAP };
  }, [filteredCases, backlogBase, detailStatus, filters.selectedDate, chartFocus, detailSort]);
  const scopeLabel = filters.selectedDate
    ? `完成于 ${filters.selectedDate}`
    : chartFocus
      ? chartFocus.label
      : '';
  const metrics = useMemo(() => buildMetrics(filteredCases), [filteredCases]);
  const clearScatter = useMemo(() => buildClearWaitScatter(filteredCases), [filteredCases]);
  const over1yClearedCount = useMemo(
    () => clearedWaitInRange(backlogBase, LONG_CHECK_PENDING_MAX_DAYS, Infinity).length,
    [backlogBase],
  );
  const over180ClearedCount = useMemo(
    () => clearedWaitInRange(backlogBase, CLEAR_SCATTER_MAX_DAYS, LONG_CHECK_PENDING_MAX_DAYS).length,
    [backlogBase],
  );
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
      <Suspense fallback={<main className="page"><p className="muted">正在加载 Case Note 搜索…</p></main>}>
        <NotesPage
          onNavigateHome={() => navigate('/')}
          onNavigateDonate={() => navigate(DONATE_PATH)}
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

  const granularityLabel = chartGranularity === 'month' ? '每月' : chartGranularity === 'week' ? '每周' : '每日';
  const trailingLabel = chartGranularity === 'month' ? '3 月' : chartGranularity === 'week' ? '4 周' : '7 日';

  return (
    <main className="page">
      <header className="hero">
        <div className="hero-main">
          <p className="eyebrow">Check Trending</p>
          <h1>签证 Check 出签趋势</h1>
          <p className="lede">
            基于 Checkee 样本，提供 <span className="lede-cap">Note搜索</span> / <span className="lede-cap">出签停滞与否</span> / <span className="lede-cap">180 天内的 Clear 出签时长分布</span> 能力
          </p>
          <nav className="hero-links" aria-label="站点链接">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={DONATE_PATH} onClick={(event) => {
              event.preventDefault();
              navigate(DONATE_PATH);
            }}>Donate · 支持本站</a>
            <ThemeSwitch preference={themePreference} onChange={setThemePreference} />
          </nav>
        </div>
        <div className="hero-aside">
          <div className="freshness">
            <span>数据范围</span>
            <strong>{data.summary.start_date} 至 {data.summary.end_date}</strong>
            <span>共 {numberFormatter.format(data.summary.case_count)} 条样本 · 更新于 {formatGeneratedAt(data.summary.generated_at)}</span>
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
              <strong>Case Note 全文搜索</strong>
              <span>搜 2014 年至今的 Case Note</span>
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
          <option value="student">学生学者 F/J</option>
          <option value="b">B1/B2</option>
        </Select>
        <Select label="签证细分" value={filters.visaSubtype} disabled={filters.visaGroup === 'all' || filters.visaGroup === 'b'} onChange={(visaSubtype) => updateFilters({ visaSubtype })}>
          {getVisaSubtypeOptions(filters.visaGroup).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
        <Select label="地区/领馆" value={filters.region} onChange={(region) => updateFilters({ region })}>
          <option value="all">全部</option>
          <option value="mainland">大陆</option>
          <option value="overseas">海外</option>
          {consulates.map((consulate) => (
            <option key={consulate} value={consulate}>{consulate}</option>
          ))}
        </Select>
        <Select label="时间范围" value={String(filters.timeRangeDays)} onChange={(value) => { setChartFocus(null); updateFilters({ timeRangeDays: parseTimeRange(value) }); }}>
          <option value="all">全部 / 月度</option>
          <option value="730">最近 24 个月 / 周</option>
          <option value="365">最近 12 个月 / 周</option>
          <option value="180">最近 180 天 / 日</option>
          <option value="90">最近 90 天 / 日</option>
        </Select>
      </section>

      <section className="metrics">
        <Metric label="已 Clear" value={metrics.clear} />
        <Metric label="处理中" value={metrics.pending} note="已排除 Pending 超 1 年" />
        <Metric label="已 Reject" value={metrics.reject} />
        <Metric label="Clear Median" value={`${metrics.medianWait} 天`} />
        <Metric label="Clear P90" value={`${metrics.p90Wait} 天`} />
        <Metric label="Clear P99" value={`${metrics.p99Wait} 天`} />
      </section>

      <ClearWaitScatterChart
        scatter={clearScatter}
        over180Count={over180ClearedCount}
        over1yCount={over1yClearedCount}
        onShowCohort={showCohort}
      />

      <section className="panel chart-panel">
        <div className="section-heading">
          <div>
            <div className="chart-titleline">
              <h2>Clear 趋势 · {granularityLabel}</h2>
              <span className="chart-legend" aria-hidden="true">
                <span className="lg lg-clear">Clear</span>
                <span className="lg lg-reject">Reject</span>
              </span>
            </div>
            <p>
              {chartFocus
                ? `聚焦 ${chartFocus.label} 每日明细 · 灰线 ${trailingLabel}均线`
                : `${granularityLabel} Clear · 灰线 ${trailingLabel}均线${baseGranularity === 'day' ? '' : ` · 点击柱状条查看${baseGranularity === 'month' ? '月' : '周'}详情`}`}
            </p>
          </div>
          <div className="chart-actions">
            {chartFocus && (
              <button className="ghost-button" onClick={() => setChartFocus(null)}>
                ← 返回{baseGranularity === 'month' ? '月度' : '周'}视图
              </button>
            )}
            {filters.selectedDate && (
              <button className="ghost-button" onClick={() => updateFilters({ selectedDate: null })}>取消日期选择</button>
            )}
          </div>
        </div>
        <ClearWaveChart
          granularity={chartGranularity}
          series={chartSeries}
          averageSeries={chartAverage}
          selectedDate={filters.selectedDate}
          onSelectDate={handleBarClick}
        />
      </section>

      <section className="panel" ref={detailRef}>
        <div className="compact-heading">
          <h2>Case 明细</h2>
          <Select label="状态" value={detailStatus} onChange={(value) => selectDetailStatus(value as DetailStatus)}>
            <option value="all">All</option>
            <option value="Clear">Clear</option>
            <option value="Reject">Reject</option>
            <option value="Pending">Pending</option>
            <option value="over180">180 to 365</option>
            <option value="over1y">&gt;365</option>
          </Select>
        </div>
        <p className="note-count muted">
          {detailStatus === 'over1y'
            ? '>365 · '
            : detailStatus === 'over180'
              ? '180 to 365 · '
              : detailStatus === 'Pending'
                ? 'Pending · '
                : scopeLabel
                  ? `${scopeLabel} · `
                  : ''}
          共 {numberFormatter.format(detailView.total)} 条{detailStatus === 'all' && !scopeLabel ? '有效样本' : ''}{detailView.total > detailView.cap ? `，显示前 ${detailView.cap}` : ''}
        </p>
        <CaseTable cases={detailView.rows} notes={caseNotes} sort={detailSort} onSort={toggleDetailSort} />
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

  function toggleDetailSort(key: DetailSort['key']) {
    setDetailSort((current) =>
      current.key === key ? { key, dir: current.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' },
    );
  }

  function handleBarClick(date: string) {
    setDetailStatus((current) =>
      current === 'over1y' || current === 'over180' || current === 'Pending'
        ? 'all'
        : current,
    );
    if (chartGranularity === 'day') {
      updateFilters({ selectedDate: date });
      return;
    }
    if (chartGranularity === 'month') {
      const monthKey = date.slice(0, 7);
      setChartFocus({ start: `${monthKey}-01`, end: `${monthKey}-31`, label: monthKey });
      return;
    }
    setChartFocus({ start: date, end: addDaysISO(date, 6), label: `${date} 当周` });
  }

  function selectDetailStatus(value: DetailStatus) {
    if (value === 'over1y' || value === 'over180' || value === 'Pending') {
      setChartFocus(null);
      updateFilters({ selectedDate: null });
      setDetailSort({ key: 'wait', dir: 'desc' });
    }
    setDetailStatus(value);
  }

  function showCohort(status: DetailStatus) {
    selectDetailStatus(status);
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function navigate(path: string) {
    window.history.pushState({}, '', path);
    setRoute(path);
  }
}

function addDaysISO(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
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

function Metric({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{typeof value === 'number' ? numberFormatter.format(value) : value}</strong>
      {note ? <span className="metric-note">{note}</span> : null}
    </div>
  );
}

function ClearWaitScatterChart({
  scatter,
  over180Count,
  over1yCount,
  onShowCohort,
}: {
  scatter: ClearWaitScatter;
  over180Count: number;
  over1yCount: number;
  onShowCohort: (status: DetailStatus) => void;
}) {
  const { days, total } = scatter;
  if (total === 0 && over180Count === 0 && over1yCount === 0) {
    return null;
  }
  const W = 760;
  const PAD_TOP = 8;
  const DOT_H = 200;
  const PLOT_H = DOT_H;
  const AXIS = 26;
  const baseline = PAD_TOP + PLOT_H;
  const H = baseline + AXIS;
  const minDay = 0;
  const maxDay = CLEAR_SCATTER_MAX_DAYS;
  const dayToX = (day: number) => ((Math.min(day, maxDay) - minDay) / (maxDay - minDay)) * W;
  const jitterY = (index: number) => {
    const seed = Math.sin((index + 1) * 12.9898) * 43758.5453;
    return PAD_TOP + 2 + (seed - Math.floor(seed)) * (DOT_H - 4);
  };
  const tickDays = [0, 30, 60, 90, 120, 150, 180];
  const denseTicks = new Set([30, 90, 150]);
  // Uniform random sample so the dense core stays airy; a sample preserves the
  // distribution shape, and the tail (rare long waits) still shows ~1/step of its points.
  const sampleStep = Math.max(1, Math.ceil(days.length / 2400));
  const renderDays = sampleStep > 1 ? days.filter((_, index) => index % sampleStep === 0) : days;
  return (
    <section className="panel scatter-panel" aria-label="Clear 出签时长分布">
      <div className="compact-heading">
        <h2>Clear 出签时长分布</h2>
        {sampleStep > 1 && <span className="scatter-note">1 dot ≈ {sampleStep} case</span>}
      </div>
      <svg className="dotplot-svg" viewBox={`0 0 ${W} ${H}`} role="img" preserveAspectRatio="xMidYMax meet">
        {renderDays.map((day, index) => (
          <circle key={index} className="scatter-dot" cx={dayToX(day)} cy={jitterY(index)} r={2.4} />
        ))}
        <line className="dotplot-axis" x1={0} y1={baseline + 2} x2={W} y2={baseline + 2} />
        {tickDays.map((day) => (
          <line key={`tick-${day}`} className="dotplot-ruler" x1={dayToX(day)} y1={baseline + 2} x2={dayToX(day)} y2={baseline + 7} />
        ))}
        {tickDays.map((day) => (
          <text
            key={day}
            className={denseTicks.has(day) ? 'dotplot-tick dotplot-tick-dense' : 'dotplot-tick'}
            x={day === minDay ? 1 : day === maxDay ? W - 1 : dayToX(day)}
            y={H - 8}
            textAnchor={day === minDay ? 'start' : day === maxDay ? 'end' : 'middle'}
          >
            {day}
          </text>
        ))}
      </svg>
      {(over180Count > 0 || over1yCount > 0) && (
        <div className="outliers-links">
          {over180Count > 0 && (
            <button type="button" className="outliers-link" onClick={() => onShowCohort('over180')}>
              180 天 to 1 年获批的 {numberFormatter.format(over180Count)} 例
            </button>
          )}
          {over180Count > 0 && over1yCount > 0 && <span className="outliers-sep">/</span>}
          {over1yCount > 0 && (
            <button type="button" className="outliers-link" onClick={() => onShowCohort('over1y')}>
              超 1 年获批的 {numberFormatter.format(over1yCount)} 例
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function ClearWaveChart({
  averageSeries,
  granularity,
  onSelectDate,
  selectedDate,
  series,
}: {
  averageSeries: { date: string; value: number }[];
  granularity: Granularity;
  onSelectDate: (date: string) => void;
  selectedDate: string | null;
  series: DailyClearPoint[];
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [stickToRight, setStickToRight] = useState(true);
  const [visibleYear, setVisibleYear] = useState<string>(
    () => series[series.length - 1]?.date.slice(0, 4) ?? '',
  );
  const [chartWrapWidth, setChartWrapWidth] = useState(0);
  const [wrapTopOffset, setWrapTopOffset] = useState(0);

  const slotCount = Math.max(series.length, 1);
  const availableWidth = chartWrapWidth - CHART_PADDING.left - CHART_PADDING.right;
  // Fill the container when bars stay legible; below a per-bar floor, keep them
  // tappable and let the chart scroll horizontally (the floor is larger on phones).
  const minSlot = chartWrapWidth > 0 && chartWrapWidth < 560 ? 18 : 12;
  const slotWidth = chartWrapWidth > 0 ? Math.max(minSlot, availableWidth / slotCount) : 12;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) {
      return;
    }
    if (stickToRight) {
      wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth;
    }
    setVisibleYear(computeVisibleYear(wrap, slotWidth, series));
  }, [slotWidth, series, stickToRight]);

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
      setChartWrapWidth(entry.contentRect.width);
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
  const plotWidth = slotCount * slotWidth;
  const svgWidth = plotWidth + padding.left + padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxCount = Math.max(
    ...series.map((point) => point.count + point.rejectCount),
    ...averageSeries.map((point) => point.value),
    1,
  );
  const barWidth = Math.max(1.5, slotWidth - 1.2);
  const minLabelSpacingPx = Math.max(72, slotWidth * 7);
  const historyTickIndexes = getDateTickIndexes(series.map((point) => point.date), slotWidth, minLabelSpacingPx);

  const xForHistoryIndex = (index: number) => padding.left + (index + 0.5) * slotWidth;
  const yForValue = (value: number) => padding.top + plotHeight - (value / maxCount) * plotHeight;
  const averagePath = smoothPath(averageSeries.map((point, index) => ({
    x: xForHistoryIndex(index),
    y: yForValue(point.value),
  })));
  const axisLabelCandidates: AxisLabel[] = historyTickIndexes.map((index) => ({
    key: `history-${series[index].date}`,
    text: formatBucketAxis(series[index].date, granularity),
    x: xForHistoryIndex(index),
  }));
  const axisLabels = pickSpacedAxisLabels(axisLabelCandidates, minLabelSpacingPx);
  const yAxisRatios = [0, 0.25, 0.5, 0.75, 1];
  const yAxisLabels = yAxisRatios.map((ratio) => ({
    ratio,
    top: wrapTopOffset + (padding.top + plotHeight - ratio * plotHeight),
    value: Math.round(maxCount * ratio),
  }));

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
          const nextYear = computeVisibleYear(target, slotWidth, series);
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
          const baseline = padding.top + plotHeight;
          const clearTop = yForValue(point.count);
          const stackTop = yForValue(point.count + point.rejectCount);
          const rejectText = point.rejectCount > 0 ? `, Reject ${point.rejectCount}` : '';
          return (
            <g key={point.date}>
              <title>{`${formatBucketTooltip(point.date, granularity)}: Clear ${point.count}${rejectText}`}</title>
              <rect
                className="bar-hit"
                x={xForHistoryIndex(index) - slotWidth / 2}
                y={padding.top}
                width={slotWidth}
                height={plotHeight}
                onClick={() => onSelectDate(point.date)}
              />
              {point.count > 0 && (
                <rect
                  className={point.date === selectedDate ? 'bar selected' : 'bar'}
                  x={x}
                  y={clearTop}
                  width={barWidth}
                  height={baseline - clearTop}
                  onClick={() => onSelectDate(point.date)}
                />
              )}
              {point.rejectCount > 0 && (
                <rect
                  className="bar-reject"
                  x={x}
                  y={stackTop}
                  width={barWidth}
                  height={clearTop - stackTop}
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

function CaseTable({
  cases,
  notes,
  sort,
  onSort,
}: {
  cases: CaseRecord[];
  notes: Record<string, string> | null;
  sort: DetailSort;
  onSort: (key: DetailSort['key']) => void;
}) {
  if (cases.length === 0) {
    return <p className="muted">当前筛选条件下没有匹配的样本。</p>;
  }
  const arrow = (key: DetailSort['key']) => (sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '');
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Case</th>
            <th>签证</th>
            <th>领馆</th>
            <th>状态</th>
            <th><button type="button" className="sort-th" onClick={() => onSort('check')}>Check{arrow('check')}</button></th>
            <th><button type="button" className="sort-th" onClick={() => onSort('clear')}>Clear{arrow('clear')}</button></th>
            <th><button type="button" className="sort-th" onClick={() => onSort('wait')}>等待{arrow('wait')}</button></th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((record) => (
            <tr key={record.case_number}>
              <td data-label="Case"><a href={detailUrl(record.case_number)} target="_blank" rel="noreferrer">{record.case_number}</a></td>
              <td data-label="签证">{record.visa_type}</td>
              <td data-label="领馆">{record.consulate} / {getRegionGroup(record.consulate) === 'mainland' ? '大陆' : '海外'}</td>
              <td data-label="状态"><span className={`status-tag status-${record.status}`}>{record.status}</span></td>
              <td data-label="Check">{record.check_date}</td>
              <td data-label="Clear">{record.complete_date ?? '-'}</td>
              <td data-label="等待">{record.waiting_days ?? '-'} 天</td>
              <td className="note-cell" data-label="Note"><div className="note-clip">{notes ? (notes[record.case_number] || '无') : ''}</div></td>
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

function clearedWaitInRange(records: CaseRecord[], lo: number, hi: number): CaseRecord[] {
  return records.filter((record) => {
    if (record.status !== 'Clear') return false;
    const wait = record.waiting_days ?? 0;
    return wait >= lo && wait < hi;
  });
}

function buildMetrics(records: CaseRecord[]) {
  const waits = records
    .filter((record) => record.status === 'Clear')
    .map((record) => record.waiting_days)
    .filter((waitingDays): waitingDays is number => waitingDays !== null)
    .sort((left, right) => left - right);
  return {
    clear: records.filter((record) => record.status === 'Clear').length,
    pending: records.filter((record) => record.status === 'Pending').length,
    reject: records.filter((record) => record.status === 'Reject').length,
    medianWait: percentile(waits, 0.5),
    p90Wait: percentile(waits, 0.9),
    p99Wait: percentile(waits, 0.99),
  };
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * ratio))];
}

function formatBucketAxis(date: string, granularity: Granularity): string {
  if (granularity === 'month') {
    return date.slice(0, 7);
  }
  return date.slice(5);
}

function formatBucketTooltip(date: string, granularity: Granularity): string {
  if (granularity === 'month') {
    return date.slice(0, 7);
  }
  if (granularity === 'week') {
    return `${date} 起一周`;
  }
  return date;
}

function parseTimeRange(value: string): TimeRangeDays {
  return TIME_RANGE_MAP[value] ?? 'all';
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
  slotWidth: number,
  series: DailyClearPoint[],
): string {
  if (series.length === 0) {
    return '';
  }
  const centerX = wrap.scrollLeft + wrap.clientWidth / 2;
  const slot = Math.floor((centerX - CHART_PADDING.left) / slotWidth);
  const clampedSlot = Math.max(0, Math.min(series.length - 1, slot));
  return series[clampedSlot].date.slice(0, 4);
}

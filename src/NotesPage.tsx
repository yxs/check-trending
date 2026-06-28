import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  DEFAULT_NOTE_FILTERS,
  buildSearchBlob,
  detailUrl,
  highlightSegments,
  noteYear,
  parseTerms,
  searchNotes,
} from './notes';
import type { NoteCase, NoteFilters, NoteRegion, NoteStatus, NotesData } from './notes';
import { DONATE_PATH, GITHUB_URL, NOTES_PATH } from './site';
import type { VisaGroup } from './types';

const PAGE_SIZE = 50;
const numberFormatter = new Intl.NumberFormat('zh-CN');

const STATUS_LABEL: Record<string, string> = {
  Clear: '已 Clear',
  Pending: '处理中',
  Reject: '拒签',
};

const VISA_GROUPS = new Set(['all', 'b', 'work', 'student', 'other']);
const STATUSES = new Set(['all', 'Clear', 'Pending', 'Reject']);
const REGIONS = new Set(['all', 'mainland', 'overseas']);

export function NotesPage({
  onNavigateHome,
  onNavigateDonate,
  themeControl,
}: {
  onNavigateHome: () => void;
  onNavigateDonate: () => void;
  themeControl: ReactNode;
}) {
  const [data, setData] = useState<NotesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(() => readQueryFromUrl());
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [filters, setFilters] = useState<NoteFilters>(() => readFiltersFromUrl());
  const [page, setPage] = useState(() => readPageFromUrl());

  useEffect(() => {
    fetch('/data/notes.json')
      .then((response) => {
        if (!response.ok) {
          throw new Error(`加载 Note 数据失败：${response.status}`);
        }
        return response.json() as Promise<NotesData>;
      })
      .then(setData)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '加载 Note 数据失败');
      });
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query), 150);
    return () => window.clearTimeout(handle);
  }, [query]);

  const blobs = useMemo(() => (data ? data.cases.map(buildSearchBlob) : []), [data]);
  const years = useMemo(() => {
    if (!data) {
      return [];
    }
    return [...new Set(data.cases.map(noteYear))].sort((left, right) => right.localeCompare(left));
  }, [data]);

  const { total, matches } = useMemo(
    () =>
      data
        ? searchNotes(data.cases, blobs, debouncedQuery, filters)
        : { total: 0, matches: [] as NoteCase[] },
    [data, blobs, debouncedQuery, filters],
  );
  const terms = useMemo(() => parseTerms(debouncedQuery), [debouncedQuery]);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = matches.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQuery) {
      params.set('q', debouncedQuery);
    }
    if (filters.visaGroup !== 'all') {
      params.set('vg', filters.visaGroup);
    }
    if (filters.status !== 'all') {
      params.set('st', filters.status);
    }
    if (filters.year !== 'all') {
      params.set('yr', filters.year);
    }
    if (filters.region !== 'all') {
      params.set('rg', filters.region);
    }
    if (safePage > 0) {
      params.set('page', String(safePage + 1));
    }
    const qs = params.toString();
    const next = qs ? `${NOTES_PATH}?${qs}` : NOTES_PATH;
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState({}, '', next);
    }
  }, [debouncedQuery, filters, safePage]);

  function goToPage(next: number) {
    setPage(Math.max(0, Math.min(pageCount - 1, next)));
    window.scrollTo({ top: 0 });
  }

  function handleQuery(value: string) {
    setQuery(value);
    setPage(0);
  }

  function updateFilters(patch: Partial<NoteFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(0);
  }

  return (
    <main className="page notes-page">
      <header className="hero">
        <div className="hero-main">
          <p className="eyebrow">Case Note 搜索</p>
          <h1>Case Note 全文检索</h1>
          <p className="lede">
            搜索 2017 年至今所有带 Note 的 Checkee 样本。
          </p>
          <nav className="hero-links" aria-label="站点链接">
            <a
              href="/"
              onClick={(event) => {
                event.preventDefault();
                onNavigateHome();
              }}
            >
              ← 趋势
            </a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a
              href={DONATE_PATH}
              onClick={(event) => {
                event.preventDefault();
                onNavigateDonate();
              }}
            >
              Donate · 支持本站
            </a>
            {themeControl}
          </nav>
        </div>
        {data && (
          <div className="freshness">
            <span>Note 样本</span>
            <strong>{numberFormatter.format(data.count)} 条</strong>
            <span>
              {data.start_date} 至 {data.end_date}
            </span>
          </div>
        )}
      </header>

      {error ? (
        <p className="error">{error}</p>
      ) : !data ? (
        <p className="muted">正在加载 Note 数据…</p>
      ) : (
        <>
          <section className="note-search" aria-label="Note 搜索">
            <input
              type="search"
              className="note-search-input"
              aria-label="搜索 Case Note 关键词"
              placeholder="搜关键词，如 行政审查、10043、5535、social media"
              value={query}
              onChange={(event) => handleQuery(event.target.value)}
            />
            <div className="note-filters">
              <Field
                label="签证组"
                value={filters.visaGroup}
                onChange={(visaGroup) => updateFilters({ visaGroup })}
              >
                <option value="all">全部</option>
                <option value="work">工作签 H/L/O</option>
                <option value="student">学生/学者 F/J</option>
                <option value="b">B 签 B1/B2</option>
                <option value="other">其他</option>
              </Field>
              <Field
                label="状态"
                value={filters.status}
                onChange={(status) => updateFilters({ status })}
              >
                <option value="all">全部</option>
                <option value="Clear">已 Clear</option>
                <option value="Pending">处理中</option>
                <option value="Reject">拒签</option>
              </Field>
              <Field
                label="年份"
                value={filters.year}
                onChange={(year) => updateFilters({ year })}
              >
                <option value="all">全部</option>
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </Field>
              <Field
                label="地区"
                value={filters.region}
                onChange={(region) => updateFilters({ region })}
              >
                <option value="all">全部</option>
                <option value="mainland">大陆</option>
                <option value="overseas">海外</option>
              </Field>
            </div>
          </section>

          <p className="note-count muted" role="status" aria-live="polite">
            共 {numberFormatter.format(total)} 条结果
          </p>

          <section className="note-results" aria-label="搜索结果">
            {pageItems.length === 0 ? (
              <p className="muted">没有匹配的 Note，换个关键词或放宽筛选试试。</p>
            ) : (
              pageItems.map((record) => (
                <NoteResult key={record.cn} record={record} terms={terms} />
              ))
            )}
          </section>

          {pageCount > 1 && (
            <nav className="note-pager" aria-label="分页">
              <button type="button" disabled={safePage === 0} onClick={() => goToPage(safePage - 1)}>
                上一页
              </button>
              <span>
                第 {safePage + 1} / {numberFormatter.format(pageCount)} 页
              </span>
              <button type="button" disabled={safePage >= pageCount - 1} onClick={() => goToPage(safePage + 1)}>
                下一页
              </button>
            </nav>
          )}
        </>
      )}
    </main>
  );
}

function NoteResult({ record, terms }: { record: NoteCase; terms: string[] }) {
  return (
    <article className="note-card">
      <div className="note-card-head">
        <a className="note-case" href={detailUrl(record.cn)} target="_blank" rel="noreferrer">
          #{record.cn}
        </a>
        <span className={`note-status note-status-${record.st.toLowerCase()}`}>
          {STATUS_LABEL[record.st] ?? record.st}
        </span>
        <span className="note-meta">
          {record.vt}
          {record.ve ? ` · ${record.ve}` : ''}
        </span>
        <span className="note-meta">{record.co}</span>
        <span className="note-meta">
          {record.cd}
          {record.cp ? ` → ${record.cp}` : ''}
        </span>
        {record.wd != null && <span className="note-meta">{record.wd} 天</span>}
      </div>
      <p className="note-body">
        {highlightSegments(record.nt, terms).map((segment, index) =>
          segment.hit ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>,
        )}
      </p>
    </article>
  );
}

function Field<T extends string>({
  children,
  label,
  onChange,
  value,
}: {
  children: ReactNode;
  label: string;
  onChange: (value: T) => void;
  value: T;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {children}
      </select>
    </label>
  );
}

function readQueryFromUrl(): string {
  return new URLSearchParams(window.location.search).get('q') ?? '';
}

function readPageFromUrl(): number {
  const raw = parseInt(new URLSearchParams(window.location.search).get('page') ?? '', 10);
  return Number.isFinite(raw) && raw > 1 ? raw - 1 : 0;
}

function readFiltersFromUrl(): NoteFilters {
  const params = new URLSearchParams(window.location.search);
  const pick = (key: string, allowed: Set<string>) => {
    const value = params.get(key) ?? '';
    return allowed.has(value) ? value : 'all';
  };
  const year = params.get('yr') ?? '';
  return {
    visaGroup: pick('vg', VISA_GROUPS) as VisaGroup,
    status: pick('st', STATUSES) as NoteStatus,
    region: pick('rg', REGIONS) as NoteRegion,
    year: /^\d{4}$/.test(year) ? year : 'all',
  };
}

export default NotesPage;

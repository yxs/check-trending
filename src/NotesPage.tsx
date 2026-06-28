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
import type { NoteCase, NoteFilters, NotesData } from './notes';
import { GITHUB_URL, NOTES_PATH } from './site';

const RENDER_LIMIT = 150;
const numberFormatter = new Intl.NumberFormat('zh-CN');

const STATUS_LABEL: Record<string, string> = {
  Clear: '已 Clear',
  Pending: '处理中',
  Reject: '拒签',
};

export function NotesPage({
  onNavigateHome,
  themeControl,
}: {
  onNavigateHome: () => void;
  themeControl: ReactNode;
}) {
  const [data, setData] = useState<NotesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(() => readQueryFromUrl());
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [filters, setFilters] = useState<NoteFilters>(DEFAULT_NOTE_FILTERS);

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

  useEffect(() => {
    const next = debouncedQuery ? `${NOTES_PATH}?q=${encodeURIComponent(debouncedQuery)}` : NOTES_PATH;
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState({}, '', next);
    }
  }, [debouncedQuery]);

  const blobs = useMemo(() => (data ? data.cases.map(buildSearchBlob) : []), [data]);
  const years = useMemo(() => {
    if (!data) {
      return [];
    }
    return [...new Set(data.cases.map(noteYear))].sort((left, right) => right.localeCompare(left));
  }, [data]);

  const { total, results } = useMemo(
    () =>
      data
        ? searchNotes(data.cases, blobs, debouncedQuery, filters, RENDER_LIMIT)
        : { total: 0, results: [] as NoteCase[] },
    [data, blobs, debouncedQuery, filters],
  );
  const terms = useMemo(() => parseTerms(debouncedQuery), [debouncedQuery]);

  return (
    <main className="page notes-page">
      <header className="hero">
        <div className="hero-main">
          <p className="eyebrow">Note 搜索</p>
          <h1>案例 Note 全文检索</h1>
          <p className="lede">
            搜索 2017 年至今所有带 Note 的 Checkee 样本，匹配面经、补料、时间线等关键词。
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
              placeholder="搜索关键词，如 行政审查、补料、Stanford、social media…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
            <div className="note-filters">
              <Field
                label="签证组"
                value={filters.visaGroup}
                onChange={(visaGroup) => setFilters((current) => ({ ...current, visaGroup }))}
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
                onChange={(status) => setFilters((current) => ({ ...current, status }))}
              >
                <option value="all">全部</option>
                <option value="Clear">已 Clear</option>
                <option value="Pending">处理中</option>
                <option value="Reject">拒签</option>
              </Field>
              <Field
                label="年份"
                value={filters.year}
                onChange={(year) => setFilters((current) => ({ ...current, year }))}
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
                onChange={(region) => setFilters((current) => ({ ...current, region }))}
              >
                <option value="all">全部</option>
                <option value="mainland">大陆</option>
                <option value="overseas">海外</option>
              </Field>
            </div>
          </section>

          <p className="note-count muted">
            共 {numberFormatter.format(total)} 条结果
            {total > results.length && `，显示前 ${numberFormatter.format(results.length)} 条（继续缩小关键词）`}
          </p>

          <section className="note-results" aria-label="搜索结果">
            {results.length === 0 ? (
              <p className="muted">没有匹配的 Note，换个关键词或放宽筛选试试。</p>
            ) : (
              results.map((record) => (
                <NoteResult key={record.cn} record={record} terms={terms} />
              ))
            )}
          </section>
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

export default NotesPage;

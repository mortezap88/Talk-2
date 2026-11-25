import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import katex from 'katex';
import {
  AlertTriangle,
  Check,
  Copy,
  FlaskConical,
  Image as ImageIcon,
  Lightbulb,
  Sparkles,
} from 'lucide-react';
import { parseMessageSegments } from '../utils/qaParser';
import {
  extractTextbookImageCodes,
  type TextbookImageEntry,
} from '../utils/textbookImages';

export type MessageVariant = 'assistant' | 'user';

function detectBaseDirection(text: string): 'rtl' | 'ltr' {
  for (const ch of text) {
    if (/[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(ch)) {
      return 'rtl';
    }
    if (/[A-Za-z]/.test(ch)) {
      return 'ltr';
    }
  }
  return 'ltr';
}

function sanitizeLatex(raw: string): string {
  // AI occasionally emits `\-` for a chemical bond inside math mode; KaTeX expects `-`.
  return raw.replace(/\\-(?=[A-Za-z0-9\\({[])/g, '-').trim();
}

function MathSpan({
  expr,
  displayMode = false,
  variant = 'assistant',
}: {
  expr: string;
  displayMode?: boolean;
  variant?: MessageVariant;
}) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const cleaned = useMemo(() => sanitizeLatex(expr), [expr]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    try {
      katex.render(cleaned, el, {
        displayMode,
        throwOnError: false,
        strict: false,
        trust: false,
      });
    } catch {
      el.textContent = expr;
    }
  }, [cleaned, displayMode, expr]);

  if (displayMode) {
    return (
      <div
        dir="ltr"
        className="my-2 px-3.5 py-2.5 rounded-lg border overflow-x-auto text-center border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/60 text-slate-900 dark:text-slate-100"
      >
        <span ref={containerRef} className="inline-block" />
      </div>
    );
  }

  return (
    <span
      ref={containerRef}
      dir="ltr"
      className="inline-block align-baseline mx-0.5 px-0.5"
    />
  );
}

const INLINE_TOKEN_RE =
  /(\$\$(?:[^$\n]|\\\$)+\$\$|\$(?!\s)(?:[^$\n]|\\\$)+?(?<!\s)\$|\\\((?:[^)\n]|\\\))+?\\\)|\[\[\s*[Ii][Mm][Gg][-_\s]?\d+\s*\]\]|`[^`\n]+`|==[^=\n]+==|!![^!\n]+!!|\+\+[^+\n]+\+\+|@@[^@\n]+@@|~~[^~\n]+~~|__[^_\n]+__|\*\*[^\s*](?:[^\n]*?[^\s*])?\*\*|\*[^\s*](?:[^*\n]*?[^\s*])?\*)/;

const TEXTBOOK_CHIP_RE = /^\[\[\s*IMG[-_\s]?(\d+)\s*\]\]$/i;

export function RichInlineText({
  text,
  variant = 'assistant',
  depth = 0,
  textbookImages,
  onOpenTextbookImage,
}: {
  text: string;
  variant?: MessageVariant;
  depth?: number;
  textbookImages?: Map<string, TextbookImageEntry>;
  onOpenTextbookImage?: (entry: TextbookImageEntry) => void;
}) {
  if (!text) return null;
  if (depth > 4) return <>{text}</>;

  const nodes: ReactNode[] = [];
  let remaining = text;
  let keyCounter = 0;

  while (remaining.length > 0) {
    const match = INLINE_TOKEN_RE.exec(remaining);
    if (!match || match.index === undefined) {
      nodes.push(remaining);
      break;
    }

    if (match.index > 0) {
      nodes.push(remaining.slice(0, match.index));
    }

    const token = match[0];
    const k = `${depth}_${keyCounter++}`;

    if (token.startsWith('$$') && token.endsWith('$$') && token.length > 4) {
      nodes.push(<MathSpan key={k} expr={token.slice(2, -2)} variant={variant} />);
    } else if (token.startsWith('$') && token.endsWith('$') && token.length > 2) {
      nodes.push(<MathSpan key={k} expr={token.slice(1, -1)} variant={variant} />);
    } else if (token.startsWith('\\(') && token.endsWith('\\)') && token.length > 4) {
      nodes.push(<MathSpan key={k} expr={token.slice(2, -2)} variant={variant} />);
    } else if (TEXTBOOK_CHIP_RE.test(token)) {
      const numMatch = TEXTBOOK_CHIP_RE.exec(token);
      const code = numMatch ? `IMG-${Number(numMatch[1])}` : token;
      const entry = textbookImages?.get(code);
      if (entry && onOpenTextbookImage) {
        nodes.push(
          <button
            key={k}
            type="button"
            dir="ltr"
            onClick={() => onOpenTextbookImage(entry)}
            title={`View ${code}${entry.caption ? `: ${entry.caption}` : ''}`}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded font-mono text-[0.82em] font-semibold align-baseline transition-colors cursor-pointer bg-sky-50 hover:bg-sky-100 dark:bg-sky-950/70 dark:hover:bg-sky-900/70 text-sky-700 dark:text-sky-300 border border-sky-200/90 dark:border-sky-800/80"
          >
            <ImageIcon className="w-3 h-3 shrink-0" />
            <span>{code}</span>
          </button>
        );
      } else {
        nodes.push(
          <span
            key={k}
            dir="ltr"
            className="inline-block px-1 py-0.5 mx-0.5 rounded font-mono text-[0.82em] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
          >
            {code}
          </span>
        );
      }
    } else if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      const inner = token.slice(1, -1);
      if (/^(==[^=\n]+==|!![^!\n]+!!|\+\+[^+\n]+\+\+|@@[^@\n]+@@)$/.test(inner)) {
        nodes.push(
          <RichInlineText
            key={k}
            text={inner}
            variant={variant}
            depth={depth + 1}
            textbookImages={textbookImages}
            onOpenTextbookImage={onOpenTextbookImage}
          />
        );
      } else {
        nodes.push(
          <code
            key={k}
            dir="ltr"
            className="inline-block px-1.5 py-0.5 rounded font-mono text-[0.85em] bg-slate-100 dark:bg-slate-800/90 text-sky-700 dark:text-sky-300 border border-slate-200/80 dark:border-slate-700"
          >
            {inner}
          </code>
        );
      }
    } else if (token.startsWith('==') && token.endsWith('==') && token.length > 4) {
      nodes.push(
        <mark
          key={k}
          className="px-1.5 py-0.5 rounded font-medium bg-amber-200/75 dark:bg-amber-500/25 text-slate-900 dark:text-amber-100"
        >
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            textbookImages={textbookImages}
            onOpenTextbookImage={onOpenTextbookImage}
          />
        </mark>
      );
    } else if (token.startsWith('!!') && token.endsWith('!!') && token.length > 4) {
      nodes.push(
        <span
          key={k}
          className="px-1.5 py-0.5 rounded font-medium bg-rose-100/90 dark:bg-rose-950/70 text-rose-800 dark:text-rose-200 border border-rose-200/90 dark:border-rose-800/70"
        >
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            textbookImages={textbookImages}
            onOpenTextbookImage={onOpenTextbookImage}
          />
        </span>
      );
    } else if (token.startsWith('++') && token.endsWith('++') && token.length > 4) {
      nodes.push(
        <span
          key={k}
          className="px-1.5 py-0.5 rounded font-medium bg-emerald-100/90 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-200 border border-emerald-200/90 dark:border-emerald-800/70"
        >
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            textbookImages={textbookImages}
            onOpenTextbookImage={onOpenTextbookImage}
          />
        </span>
      );
    } else if (token.startsWith('@@') && token.endsWith('@@') && token.length > 4) {
      nodes.push(
        <span
          key={k}
          className="px-1.5 py-0.5 rounded font-medium bg-sky-100/90 dark:bg-sky-950/70 text-sky-800 dark:text-sky-200 border border-sky-200/90 dark:border-sky-800/70"
        >
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            textbookImages={textbookImages}
            onOpenTextbookImage={onOpenTextbookImage}
          />
        </span>
      );
    } else if (token.startsWith('~~') && token.endsWith('~~') && token.length > 4) {
      nodes.push(
        <del key={k} className="line-through opacity-70 decoration-rose-500/80">
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            textbookImages={textbookImages}
            onOpenTextbookImage={onOpenTextbookImage}
          />
        </del>
      );
    } else if (token.startsWith('__') && token.endsWith('__') && token.length > 4) {
      nodes.push(
        <span
          key={k}
          className="underline decoration-2 underline-offset-4 decoration-sky-500/75"
        >
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            textbookImages={textbookImages}
            onOpenTextbookImage={onOpenTextbookImage}
          />
        </span>
      );
    } else if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      nodes.push(
        <strong key={k} className="font-semibold">
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            textbookImages={textbookImages}
            onOpenTextbookImage={onOpenTextbookImage}
          />
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
      nodes.push(
        <em key={k} className="italic">
          <RichInlineText
            text={token.slice(1, -1)}
            variant={variant}
            depth={depth + 1}
            textbookImages={textbookImages}
            onOpenTextbookImage={onOpenTextbookImage}
          />
        </em>
      );
    } else {
      nodes.push(token);
    }

    remaining = remaining.slice(match.index + token.length);
  }

  return <>{nodes}</>;
}

type CalloutKind = 'key' | 'tip' | 'trap' | 'example';

const CALLOUT_CONFIG: Record<
  CalloutKind,
  {
    title: string;
    icon: typeof Lightbulb;
    wrapperClass: string;
    titleClass: string;
  }
> = {
  key: {
    title: 'Key Point',
    icon: Lightbulb,
    wrapperClass:
      'border-sky-300/80 dark:border-sky-800/80 bg-sky-50/75 dark:bg-sky-950/35 text-slate-900 dark:text-slate-100',
    titleClass: 'text-sky-700 dark:text-sky-300',
  },
  tip: {
    title: 'Study Tip',
    icon: Sparkles,
    wrapperClass:
      'border-emerald-300/80 dark:border-emerald-800/80 bg-emerald-50/75 dark:bg-emerald-950/35 text-slate-900 dark:text-slate-100',
    titleClass: 'text-emerald-700 dark:text-emerald-300',
  },
  trap: {
    title: 'Watch Out',
    icon: AlertTriangle,
    wrapperClass:
      'border-rose-300/80 dark:border-rose-800/80 bg-rose-50/75 dark:bg-rose-950/35 text-slate-900 dark:text-slate-100',
    titleClass: 'text-rose-700 dark:text-rose-300',
  },
  example: {
    title: 'Example',
    icon: FlaskConical,
    wrapperClass:
      'border-indigo-300/80 dark:border-indigo-800/80 bg-indigo-50/75 dark:bg-indigo-950/35 text-slate-900 dark:text-slate-100',
    titleClass: 'text-indigo-700 dark:text-indigo-300',
  },
};

function mapCalloutTag(rawTag: string): CalloutKind {
  const upper = rawTag.toUpperCase();
  if (upper === 'TIP') return 'tip';
  if (upper === 'TRAP' || upper === 'WARNING' || upper === 'CAUTION' || upper === 'IMPORTANT') {
    return 'trap';
  }
  if (upper === 'EXAMPLE') return 'example';
  return 'key';
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  return /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(trimmed) ||
    /^\|(\s*:?-{3,}:?\s*\|)+$/.test(trimmed);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function TextbookFigureCard({
  entry,
  onOpen,
}: {
  entry: TextbookImageEntry;
  onOpen?: (entry: TextbookImageEntry) => void;
}) {
  if (!entry.image.dataUrl) return null;

  return (
    <figure className="my-2.5 max-w-2xl rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50/80 dark:bg-slate-950/60 p-2.5 shadow-xs">
      <button
        type="button"
        onClick={() => onOpen?.(entry)}
        aria-label={`Zoom textbook figure ${entry.code}`}
        className="block w-full overflow-hidden rounded-lg bg-white dark:bg-slate-950 focus-visible:outline-2 focus-visible:outline-sky-500 cursor-zoom-in"
      >
        <img
          src={entry.image.dataUrl}
          alt={entry.caption || entry.code}
          referrerPolicy="no-referrer"
          className="mx-auto max-h-96 w-auto object-contain"
        />
      </button>
      <figcaption
        dir="auto"
        className="bidi-plaintext mt-2 flex flex-wrap items-center justify-center gap-1.5 text-xs text-slate-600 dark:text-slate-400"
      >
        <span
          dir="ltr"
          className="font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded bg-sky-100/80 dark:bg-sky-950/80 text-sky-700 dark:text-sky-300 border border-sky-200/80 dark:border-sky-800/80"
        >
          {entry.code}
        </span>
        {entry.pageNumber && entry.pageNumber > 0 ? (
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            Page {entry.pageNumber} ·
          </span>
        ) : null}
        <span>{entry.caption}</span>
      </figcaption>
    </figure>
  );
}

function RichTextBlock({
  content,
  variant = 'assistant',
  textbookImages,
  priorShown,
  onOpenTextbookImage,
}: {
  content: string;
  variant?: MessageVariant;
  textbookImages?: Map<string, TextbookImageEntry>;
  priorShown?: Set<string>;
  onOpenTextbookImage?: (entry: TextbookImageEntry) => void;
}) {
  const localShown = new Set(priorShown);
  const takeFirstTimeEntries = (text: string): TextbookImageEntry[] => {
    if (variant !== 'assistant' || !textbookImages || textbookImages.size === 0) {
      return [];
    }
    const entries: TextbookImageEntry[] = [];
    for (const code of extractTextbookImageCodes(text)) {
      const entry = textbookImages.get(code);
      if (entry && !localShown.has(code)) {
        localShown.add(code);
        entries.push(entry);
      }
    }
    return entries;
  };

  const lines = content.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line
    if (!trimmed) {
      i++;
      continue;
    }

    // Display math block $$...$$ or \[...\]
    if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
      const isBracket = trimmed.startsWith('\\[');
      const closeDelim = isBracket ? '\\]' : '$$';
      const openLen = 2;

      if (trimmed.length > 4 && trimmed.endsWith(closeDelim)) {
        blocks.push(
          <MathSpan
            key={`dm_${i}`}
            expr={trimmed.slice(openLen, -2)}
            displayMode
            variant={variant}
          />
        );
        i++;
        continue;
      }

      const mathLines: string[] = [trimmed.slice(openLen)];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const nextLine = lines[j];
        const closeIdx = nextLine.indexOf(closeDelim);
        if (closeIdx !== -1) {
          mathLines.push(nextLine.slice(0, closeIdx));
          closed = true;
          j++;
          break;
        }
        mathLines.push(nextLine);
        j++;
      }

      if (closed) {
        blocks.push(
          <MathSpan
            key={`dm_${i}`}
            expr={mathLines.join('\n')}
            displayMode
            variant={variant}
          />
        );
        i = j;
        continue;
      }
    }

    // Horizontal rule
    if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
      blocks.push(
        <hr
          key={`hr_${i}`}
          className="my-2 border-slate-200 dark:border-slate-800"
        />
      );
      i++;
      continue;
    }

    // Headings (#, ##, ###, ####)
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const sizeClass =
        level === 1
          ? 'text-lg font-bold pt-1'
          : level === 2
          ? 'text-base font-bold pt-1 pb-1 border-b border-slate-200/80 dark:border-slate-800'
          : level === 3
          ? 'text-[15px] font-semibold pt-0.5'
          : 'text-sm font-semibold';
      blocks.push(
        <div
          key={`h_${i}`}
          dir="auto"
          className={`bidi-plaintext font-display ${sizeClass} text-slate-900 dark:text-slate-50`}
        >
          <RichInlineText text={text} variant={variant} />
        </div>
      );
      i++;
      continue;
    }

    // Markdown table
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      const tableDir = detectBaseDirection(headers.join(' '));
      blocks.push(
        <div
          key={`tbl_${i}`}
          dir={tableDir}
          className="my-1.5 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/40"
        >
          <table className="w-full border-collapse text-xs sm:text-[13px]">
            <thead>
              <tr className="bg-slate-100/90 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700">
                {headers.map((h, hIdx) => (
                  <th
                    key={hIdx}
                    dir="auto"
                    className="bidi-plaintext px-3 py-2 font-semibold text-start"
                  >
                    <RichInlineText text={h} variant={variant} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/80 dark:divide-slate-800">
              {rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {headers.map((_, cIdx) => (
                    <td
                      key={cIdx}
                      dir="auto"
                      className="bidi-plaintext px-3 py-2 align-top text-start"
                    >
                      <RichInlineText text={row[cIdx] ?? ''} variant={variant} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      i = j;
      continue;
    }

    // Blockquote or Study Callout (> [!KEY] ...)
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith('>')) {
        quoteLines.push(lines[j].trim().replace(/^>\s?/, ''));
        j++;
      }

      const first = quoteLines[0] || '';
      const calloutMatch = first.match(
        /^\[!(KEY|NOTE|TIP|TRAP|WARNING|CAUTION|IMPORTANT|EXAMPLE)\]\s*(.*)$/i
      );

      if (calloutMatch && variant === 'assistant') {
        const kind = mapCalloutTag(calloutMatch[1]);
        const cfg = CALLOUT_CONFIG[kind];
        const Icon = cfg.icon;
        const bodyLines = [calloutMatch[2], ...quoteLines.slice(1)].filter(
          (l, idx) => idx > 0 || l.trim().length > 0
        );
        const calloutDir = detectBaseDirection(bodyLines.join(' '));
        const calloutEntries = takeFirstTimeEntries(bodyLines.join('\n'));
        blocks.push(
          <div
            key={`call_${i}`}
            dir={calloutDir}
            className={`my-1.5 rounded-lg border px-3.5 py-2.5 space-y-1.5 ${cfg.wrapperClass}`}
          >
            <div className={`flex items-center gap-1.5 text-xs font-semibold ${cfg.titleClass}`}>
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span>{cfg.title}</span>
            </div>
            <div className="space-y-1 text-sm leading-relaxed">
              {bodyLines.map((bLine, bIdx) => (
                <p key={bIdx} dir="auto" className="bidi-plaintext">
                  <RichInlineText
                    text={bLine}
                    variant={variant}
                    textbookImages={textbookImages}
                    onOpenTextbookImage={onOpenTextbookImage}
                  />
                </p>
              ))}
            </div>
            {calloutEntries.map((entry) => (
              <TextbookFigureCard
                key={`call_fig_${i}_${entry.code}`}
                entry={entry}
                onOpen={onOpenTextbookImage}
              />
            ))}
          </div>
        );
      } else {
        const quoteDir = detectBaseDirection(quoteLines.join(' '));
        const quoteEntries = takeFirstTimeEntries(quoteLines.join('\n'));
        blocks.push(
          <blockquote
            key={`q_${i}`}
            dir={quoteDir}
            className="my-1 border-s-3 ps-3.5 py-0.5 space-y-1 border-sky-400/80 dark:border-sky-600 text-slate-600 dark:text-slate-300"
          >
            {quoteLines.map((qLine, qIdx) => (
              <p key={qIdx} dir="auto" className="bidi-plaintext">
                <RichInlineText
                  text={qLine}
                  variant={variant}
                  textbookImages={textbookImages}
                  onOpenTextbookImage={onOpenTextbookImage}
                />
              </p>
            ))}
            {quoteEntries.map((entry) => (
              <TextbookFigureCard
                key={`q_fig_${i}_${entry.code}`}
                entry={entry}
                onOpen={onOpenTextbookImage}
              />
            ))}
          </blockquote>
        );
      }
      i = j;
      continue;
    }

    // Unordered list (- item or * item or • item)
    const ulMatch = line.match(/^\s*[-*•]\s+(.+)$/);
    if (ulMatch) {
      const items: string[] = [];
      let j = i;
      while (j < lines.length) {
        const m = lines[j].match(/^\s*[-*•]\s+(.+)$/);
        if (!m) break;
        items.push(m[1]);
        j++;
      }
      const listDir = detectBaseDirection(items[0] || '');
      blocks.push(
        <ul
          key={`ul_${i}`}
          dir={listDir}
          className="list-disc ps-5 space-y-1"
        >
          {items.map((item, idx) => {
            const itemEntries = takeFirstTimeEntries(item);
            return (
              <li key={idx} dir="auto" className="bidi-plaintext">
                <RichInlineText
                  text={item}
                  variant={variant}
                  textbookImages={textbookImages}
                  onOpenTextbookImage={onOpenTextbookImage}
                />
                {itemEntries.map((entry) => (
                  <TextbookFigureCard
                    key={`ul_fig_${i}_${idx}_${entry.code}`}
                    entry={entry}
                    onOpen={onOpenTextbookImage}
                  />
                ))}
              </li>
            );
          })}
        </ul>
      );
      i = j;
      continue;
    }

    // Ordered list (1. item or ۱) item)
    const olMatch = line.match(/^\s*([0-9۰-۹٠-٩]+)[.)]\s+(.+)$/);
    if (olMatch) {
      const items: Array<{ marker: string; text: string }> = [];
      let j = i;
      while (j < lines.length) {
        const m = lines[j].match(/^\s*([0-9۰-۹٠-٩]+)[.)]\s+(.+)$/);
        if (!m) break;
        items.push({ marker: m[1], text: m[2] });
        j++;
      }
      const listDir = detectBaseDirection(items[0]?.text || '');
      blocks.push(
        <ol key={`ol_${i}`} dir={listDir} className="space-y-1.5">
          {items.map((item, idx) => {
            const itemEntries = takeFirstTimeEntries(item.text);
            return (
              <li key={idx} className="flex items-start gap-2">
                <span className="shrink-0 font-semibold tabular-nums text-sky-600 dark:text-sky-400">
                  {item.marker}.
                </span>
                <div dir="auto" className="bidi-plaintext flex-1 min-w-0">
                  <RichInlineText
                    text={item.text}
                    variant={variant}
                    textbookImages={textbookImages}
                    onOpenTextbookImage={onOpenTextbookImage}
                  />
                  {itemEntries.map((entry) => (
                    <TextbookFigureCard
                      key={`ol_fig_${i}_${idx}_${entry.code}`}
                      entry={entry}
                      onOpen={onOpenTextbookImage}
                    />
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      );
      i = j;
      continue;
    }

    // Standalone textbook image marker line(s), e.g. "[[IMG-1]]"
    const standaloneCodes = extractTextbookImageCodes(trimmed);
    const hasOnlyImageTags =
      standaloneCodes.length > 0 &&
      trimmed.replace(/\[\[\s*IMG[-_\s]?\d+\s*\]\]/gi, '').trim() === '';
    if (hasOnlyImageTags) {
      const shownInlineEntries = takeFirstTimeEntries(trimmed);
      for (const entry of shownInlineEntries) {
        blocks.push(
          <TextbookFigureCard
            key={`fig_${i}_${entry.code}`}
            entry={entry}
            onOpen={onOpenTextbookImage}
          />
        );
      }

      const shownNowCodes = new Set(shownInlineEntries.map((e) => e.code));
      const repeatOrUnknownCodes = standaloneCodes.filter((c) => !shownNowCodes.has(c));
      if (repeatOrUnknownCodes.length > 0) {
        blocks.push(
          <div key={`fig_ref_${i}`} className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            {repeatOrUnknownCodes.map((code) => {
              const entry = textbookImages?.get(code);
              if (entry && onOpenTextbookImage) {
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => onOpenTextbookImage(entry)}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-sky-700 dark:text-sky-300 font-mono text-xs font-medium hover:bg-sky-50 dark:hover:bg-sky-950/60 cursor-pointer"
                  >
                    <ImageIcon className="w-3.5 h-3.5" />
                    <span>{code}</span>
                    {variant === 'assistant' ? (
                      <span className="font-sans text-[11px] text-slate-500 dark:text-slate-400">
                        (shown above)
                      </span>
                    ) : null}
                  </button>
                );
              }
              return (
                <span key={code} className="font-mono text-xs text-slate-500">
                  {code}
                </span>
              );
            })}
          </div>
        );
      }

      i++;
      continue;
    }

    // Regular paragraph line (may also reference [[IMG-N]] inline)
    const inlineEntries = takeFirstTimeEntries(line);
    blocks.push(
      <p key={`p_${i}`} dir="auto" className="bidi-plaintext whitespace-pre-wrap">
        <RichInlineText
          text={line}
          variant={variant}
          textbookImages={textbookImages}
          onOpenTextbookImage={onOpenTextbookImage}
        />
      </p>
    );
    for (const entry of inlineEntries) {
      blocks.push(
        <TextbookFigureCard
          key={`p_fig_${i}_${entry.code}`}
          entry={entry}
          onOpen={onOpenTextbookImage}
        />
      );
    }
    i++;
  }

  return <div className="space-y-2">{blocks}</div>;
}

export function RichMessage({
  content,
  variant = 'assistant',
  textbookImages,
  alreadyShownImageCodes,
  onOpenTextbookImage,
}: {
  content: string;
  variant?: MessageVariant;
  textbookImages?: Map<string, TextbookImageEntry>;
  alreadyShownImageCodes?: Set<string>;
  onOpenTextbookImage?: (entry: TextbookImageEntry) => void;
}) {
  const segments = useMemo(() => parseMessageSegments(content), [content]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const segmentPriorShown = useMemo(() => {
    const running = new Set(alreadyShownImageCodes ?? []);
    return segments.map((seg) => {
      const snapshot = new Set(running);
      if (variant === 'assistant' && seg.type === 'text' && textbookImages) {
        for (const code of extractTextbookImageCodes(seg.content)) {
          if (textbookImages.has(code)) {
            running.add(code);
          }
        }
      }
      return snapshot;
    });
  }, [segments, alreadyShownImageCodes, variant, textbookImages]);

  return (
    <div className="space-y-3 text-[15px] leading-relaxed break-words">
      {segments.map((seg, idx) => {
        if (seg.type === 'code') {
          return (
            <div
              key={idx}
              dir="ltr"
              className="text-left rounded-lg border border-slate-200 dark:border-slate-700/80 bg-slate-900 dark:bg-slate-950 text-slate-100 overflow-hidden"
            >
              <div className="px-3 py-1.5 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
                <span className="font-mono">{seg.language || 'code'}</span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(seg.content);
                    setCopiedIdx(idx);
                    setTimeout(() => setCopiedIdx(null), 1400);
                  }}
                  aria-label="Copy code block"
                  className="inline-flex items-center gap-1 hover:text-slate-200 transition-colors"
                >
                  {copiedIdx === idx ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  <span>{copiedIdx === idx ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="p-3 overflow-x-auto text-xs leading-relaxed font-mono">
                <code>{seg.content}</code>
              </pre>
            </div>
          );
        }

        return (
          <RichTextBlock
            key={idx}
            content={seg.content}
            variant={variant}
            textbookImages={textbookImages}
            priorShown={segmentPriorShown[idx]}
            onOpenTextbookImage={onOpenTextbookImage}
          />
        );
      })}
    </div>
  );
}

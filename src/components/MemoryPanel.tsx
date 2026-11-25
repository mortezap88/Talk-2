import { useState } from 'react';
import { AlertCircle, ArrowLeft, Database, Loader2, RefreshCw } from 'lucide-react';
import type { ChatMemory, ChatMessage, MemoryPack, RightPanelMode } from '../types/talk';
import {
  ACTIVE_WINDOW_MAX_MESSAGES,
  analyzeActiveWindow,
  COMPACTION_TRIGGER_TOKENS,
  getRollingPacks,
  PACK_SLOTS,
} from '../utils/memoryEngine';
import { formatRelativeTime } from '../utils/formatters';
import { RichInlineText } from './RichMessage';

interface MemoryPanelProps {
  memory: ChatMemory;
  messages: ChatMessage[];
  mode?: RightPanelMode;
  isCompacting: boolean;
  onCompactNow: () => void;
  onDeletePack: (packId: string) => void;
}

function getSlotColorClass(slotIdx: number): string {
  if (slotIdx <= 2) {
    return 'bg-sky-600 text-white border-sky-700 dark:bg-sky-500 dark:border-sky-400';
  }
  if (slotIdx <= 6) {
    return 'bg-sky-500/80 text-white border-sky-600 dark:bg-sky-600/80 dark:border-sky-500';
  }
  if (slotIdx <= 10) {
    return 'bg-sky-200 text-sky-950 border-sky-300 dark:bg-sky-900/80 dark:text-sky-100 dark:border-sky-700';
  }
  return 'bg-slate-200 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700';
}

export function MemoryPanel({
  memory,
  messages,
  mode = 'edit',
  isCompacting,
  onCompactNow,
  onDeletePack,
}: MemoryPanelProps) {
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const isReadMode = mode === 'read';

  const analysis = analyzeActiveWindow(messages, memory.compactedCount);
  const rollingPacks = getRollingPacks(memory.packs);
  const selectedSlotIndex = selectedPackId
    ? rollingPacks.findIndex((p) => p.id === selectedPackId)
    : -1;
  const selectedPack: MemoryPack | null =
    selectedSlotIndex >= 0 ? rollingPacks[selectedSlotIndex] : null;

  const progressTokens = Math.min(COMPACTION_TRIGGER_TOKENS, analysis.uncompactedOutsideTokens);
  const progressPct = Math.round((progressTokens / COMPACTION_TRIGGER_TOKENS) * 100);

  return (
    <div
      className={`flex-1 min-h-0 overflow-y-auto ${
        isReadMode
          ? 'bg-white dark:bg-slate-900 px-5 sm:px-7 pt-14 pb-8'
          : 'bg-slate-50 dark:bg-slate-950 px-4 sm:px-5 pt-14 pb-5'
      }`}
    >
      <div className={isReadMode ? 'w-full space-y-5' : 'max-w-4xl mx-auto space-y-5'}>
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-sky-600 dark:text-sky-400" />
            <div>
              <h1 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                Memory Inspector
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                {memory.compactedCount} packed msgs · {memory.compactedTokens.toLocaleString()} tok
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={isCompacting || analysis.uncompactedTotalCount === 0}
            onClick={onCompactNow}
            className="px-3.5 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            {isCompacting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Packing…</span>
              </>
            ) : memory.lastError ? (
              <>
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry pack</span>
              </>
            ) : (
              <span>Pack now</span>
            )}
          </button>
        </div>

        {/* Active Window */}
        <section
          aria-label="Active window"
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Active Window
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {analysis.activeWindow.length} / {ACTIVE_WINDOW_MAX_MESSAGES} msgs ·{' '}
              {analysis.activeTokens.toLocaleString()} tok
            </span>
          </div>

          <div className="space-y-2">
            {analysis.activeWindow.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
                No messages in active window yet.
              </p>
            ) : (
              analysis.activeWindow.map((msg) => (
                <div
                  key={msg.id}
                  className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 text-xs"
                >
                  <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-1">
                    <span className="font-semibold text-slate-700 dark:text-slate-200">
                      {msg.role === 'user' ? 'Student' : 'Tutor'}
                    </span>
                    <span className="tabular-nums">{formatRelativeTime(msg.createdAt)}</span>
                  </div>
                  <p
                    dir="auto"
                    className="bidi-plaintext text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words leading-relaxed"
                  >
                    {msg.content}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Next Pack Progress */}
        <section
          aria-label="Next pack progress"
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2"
        >
          <div className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-200 tabular-nums font-medium">
            <span>
              Next Pack · {analysis.uncompactedOutsideTokens.toLocaleString()} /{' '}
              {COMPACTION_TRIGGER_TOKENS.toLocaleString()} tok
            </span>
            <span>{progressPct}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-sky-600 dark:bg-sky-500 transition-all duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {analysis.uncompactedOutsideWindow.length > 0
              ? `${analysis.uncompactedOutsideWindow.length} older msg${analysis.uncompactedOutsideWindow.length === 1 ? '' : 's'} queued beyond the last 10.`
              : 'Last 10 messages stay verbatim; older messages count toward 1,000 tok.'}
          </p>

          {memory.lastError ? (
            <div className="flex items-start gap-2 text-xs text-red-700 dark:text-red-400 pt-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{memory.lastError}</span>
            </div>
          ) : null}
        </section>

        {/* Rolling Memory Packs (P1 -> P15) + Inline Inspector */}
        <section
          aria-label="Memory packs"
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
        >
          <div className="grid grid-cols-5 gap-2">
            {Array.from({ length: PACK_SLOTS }, (_, slotIdx) => {
              const pack = rollingPacks[slotIdx];
              const slotLabel = `P${slotIdx + 1}`;
              if (!pack) {
                return (
                  <div
                    key={slotLabel}
                    className="h-12 rounded-md border border-dashed border-slate-300 dark:border-slate-700 flex items-center justify-center text-xs text-slate-400 dark:text-slate-600 font-mono"
                  >
                    {slotLabel}
                  </div>
                );
              }
              const isSelected = selectedPackId === pack.id;
              const colorClass = getSlotColorClass(slotIdx);
              return (
                <button
                  key={pack.id}
                  type="button"
                  onClick={() => setSelectedPackId(isSelected ? null : pack.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (selectedPackId === pack.id) setSelectedPackId(null);
                    onDeletePack(pack.id);
                  }}
                  title={`${slotLabel} (${pack.tokenCount} tok) — click to inspect, right-click to delete`}
                  className={`h-12 rounded-md border flex flex-col items-center justify-center text-xs font-mono transition-transform hover:scale-[1.02] ${colorClass} ${
                    isSelected ? 'ring-2 ring-offset-1 ring-sky-500 dark:ring-offset-slate-900' : ''
                  }`}
                >
                  <span className="font-semibold">{slotLabel}</span>
                  <span className="text-[10px] opacity-85 tabular-nums">{pack.tokenCount}t</span>
                </button>
              );
            })}
          </div>

          {selectedPack ? (
            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedPackId(null)}
                    className="h-7 px-2 rounded-md border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Close pack</span>
                  </button>
                  <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Pack P{selectedSlotIndex + 1}
                    {selectedSlotIndex === 0 ? ' (Newest)' : ''}
                  </h3>
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {selectedPack.tokenCount} tok
                </span>
              </div>

              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Packed Notes &amp; Quotes (~80% retention)
                </div>
                <p
                  dir="auto"
                  className="bidi-plaintext whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-200 leading-relaxed"
                >
                  <RichInlineText text={selectedPack.summary} />
                </p>
              </div>

              {selectedPack.bullets.length > 0 ? (
                <div>
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
                    Highlights
                  </div>
                  <ul className="space-y-2">
                    {selectedPack.bullets.map((b, i) => (
                      <li
                        key={i}
                        dir="auto"
                        className="bidi-plaintext p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 leading-relaxed"
                      >
                        <RichInlineText text={b} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

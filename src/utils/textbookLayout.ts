import type { TextbookConvertedBlock, TextbookFigureAlign } from '../types/talk';

export const DEFAULT_FLOAT_WIDTH_PCT = 42;
export const DEFAULT_CENTER_WIDTH_PCT = 64;
export const MIN_FIGURE_WIDTH_PCT = 24;
export const MAX_FLOAT_WIDTH_PCT = 72;

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeFigureAlign(raw?: string | null): TextbookFigureAlign {
  if (raw === 'left' || raw === 'center' || raw === 'right' || raw === 'full') {
    return raw;
  }
  return 'center';
}

export function normalizeFigureWidthPct(
  align: TextbookFigureAlign,
  rawWidthPct?: number
): number {
  if (align === 'full') return 100;
  if (align === 'left' || align === 'right') {
    if (typeof rawWidthPct !== 'number' || !Number.isFinite(rawWidthPct) || rawWidthPct > MAX_FLOAT_WIDTH_PCT) {
      return DEFAULT_FLOAT_WIDTH_PCT;
    }
    return clampNumber(rawWidthPct, MIN_FIGURE_WIDTH_PCT, MAX_FLOAT_WIDTH_PCT);
  }
  if (typeof rawWidthPct !== 'number' || !Number.isFinite(rawWidthPct)) {
    return DEFAULT_CENTER_WIDTH_PCT;
  }
  return clampNumber(rawWidthPct, MIN_FIGURE_WIDTH_PCT, 100);
}

/**
 * Resolves the default paper-design placement (left / center / right / full and width%)
 * for an auto-analyzed textbook figure, preferring explicit AI spatial metadata and
 * falling back to the cropped box's horizontal position on the page.
 */
export function inferFigureBoxLayout(
  box_2d?: [number, number, number, number],
  aiAlign?: string | null,
  aiWidthPct?: number
): { align: TextbookFigureAlign; widthPct: number } {
  const validAiAlign =
    aiAlign === 'left' || aiAlign === 'center' || aiAlign === 'right' || aiAlign === 'full'
      ? aiAlign
      : null;

  if (validAiAlign) {
    return {
      align: validAiAlign,
      widthPct: normalizeFigureWidthPct(validAiAlign, aiWidthPct),
    };
  }

  if (box_2d && box_2d.length === 4) {
    const rawXMin = Math.min(box_2d[1], box_2d[3]);
    const rawXMax = Math.max(box_2d[1], box_2d[3]);
    const span = Math.max(100, rawXMax - rawXMin);
    const spanPct = Math.round(span / 10);

    if (span >= 880) {
      return { align: 'full', widthPct: 100 };
    }
    if (span >= 680) {
      return {
        align: 'center',
        widthPct: clampNumber(spanPct, 45, 92),
      };
    }
    if (rawXMin <= 180 && rawXMax <= 620) {
      return {
        align: 'left',
        widthPct: clampNumber(spanPct, 28, 56),
      };
    }
    if (rawXMin >= 380 && rawXMax >= 820) {
      return {
        align: 'right',
        widthPct: clampNumber(spanPct, 28, 56),
      };
    }
    return {
      align: 'center',
      widthPct: clampNumber(spanPct, 36, 75),
    };
  }

  return {
    align: 'center',
    widthPct: normalizeFigureWidthPct('center', aiWidthPct),
  };
}

export function getBlockFigureAlign(block: TextbookConvertedBlock): TextbookFigureAlign {
  return normalizeFigureAlign(block.align);
}

export function getBlockFigureWidthPct(block: TextbookConvertedBlock): number {
  return normalizeFigureWidthPct(getBlockFigureAlign(block), block.widthPct);
}

export function updateFigureBlockLayout(
  blocks: TextbookConvertedBlock[],
  blockId: string,
  patch: { align?: TextbookFigureAlign; widthPct?: number }
): TextbookConvertedBlock[] {
  return blocks.map((block) => {
    if (block.id !== blockId || block.type !== 'figure') return block;

    const currentAlign = getBlockFigureAlign(block);
    const nextAlign = patch.align ?? currentAlign;

    let nextWidthPct: number;
    if (typeof patch.widthPct === 'number') {
      nextWidthPct = normalizeFigureWidthPct(nextAlign, patch.widthPct);
    } else if (patch.align && patch.align !== currentAlign) {
      if (nextAlign === 'full') {
        nextWidthPct = 100;
      } else if (nextAlign === 'left' || nextAlign === 'right') {
        const prevW = typeof block.widthPct === 'number' ? block.widthPct : DEFAULT_FLOAT_WIDTH_PCT;
        nextWidthPct = prevW > MAX_FLOAT_WIDTH_PCT ? DEFAULT_FLOAT_WIDTH_PCT : normalizeFigureWidthPct(nextAlign, prevW);
      } else {
        // Switching to 'center'
        const prevW = typeof block.widthPct === 'number' ? block.widthPct : DEFAULT_CENTER_WIDTH_PCT;
        nextWidthPct = prevW >= 95 ? DEFAULT_CENTER_WIDTH_PCT : normalizeFigureWidthPct('center', prevW);
      }
    } else {
      nextWidthPct = normalizeFigureWidthPct(nextAlign, block.widthPct);
    }

    return {
      ...block,
      align: nextAlign,
      widthPct: nextWidthPct,
    };
  });
}

export function moveTextbookBlock(
  blocks: TextbookConvertedBlock[],
  blockId: string,
  direction: 'up' | 'down'
): TextbookConvertedBlock[] {
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx === -1) return blocks;
  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= blocks.length) return blocks;
  const copy = [...blocks];
  const [item] = copy.splice(idx, 1);
  copy.splice(targetIdx, 0, item);
  return copy;
}

export function reorderTextbookBlock(
  blocks: TextbookConvertedBlock[],
  sourceId: string,
  targetId: string
): TextbookConvertedBlock[] {
  if (sourceId === targetId) return blocks;
  const fromIdx = blocks.findIndex((b) => b.id === sourceId);
  const toIdx = blocks.findIndex((b) => b.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return blocks;
  const copy = [...blocks];
  const [moved] = copy.splice(fromIdx, 1);
  copy.splice(toIdx, 0, moved);
  return copy;
}

export function splitTextBlockAtOffset(
  blocks: TextbookConvertedBlock[],
  blockId: string,
  cursorOffset: number | undefined,
  newBlockId: string
): TextbookConvertedBlock[] {
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx === -1) return blocks;
  const target = blocks[idx];
  if (target.type !== 'text') return blocks;

  const raw = target.content ?? '';
  let splitPos =
    typeof cursorOffset === 'number' && cursorOffset > 0 && cursorOffset < raw.length
      ? cursorOffset
      : -1;

  // If cursor is at start/end or not provided, split at the nearest paragraph break (\n\n)
  if (splitPos === -1) {
    const mid = Math.floor(raw.length / 2);
    const forward = raw.indexOf('\n\n', Math.max(0, mid - Math.floor(raw.length / 3)));
    const backward = raw.lastIndexOf('\n\n', mid);
    if (forward !== -1) splitPos = forward;
    else if (backward !== -1) splitPos = backward;
  }

  if (splitPos <= 0 || splitPos >= raw.length) return blocks;

  const firstPart = raw.slice(0, splitPos).trimEnd();
  const secondPart = raw.slice(splitPos).trimStart();
  if (!firstPart || !secondPart) return blocks;

  const next = [...blocks];
  next.splice(
    idx,
    1,
    { ...target, content: firstPart },
    {
      id: newBlockId,
      type: 'text',
      pageNumber: target.pageNumber,
      content: secondPart,
    }
  );
  return next;
}

export function mergeTextBlockWithNext(
  blocks: TextbookConvertedBlock[],
  blockId: string
): TextbookConvertedBlock[] {
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx === -1 || idx >= blocks.length - 1) return blocks;
  const curr = blocks[idx];
  const nextBlock = blocks[idx + 1];
  if (curr.type !== 'text' || nextBlock.type !== 'text') return blocks;

  const combined = [curr.content?.trimEnd(), nextBlock.content?.trimStart()]
    .filter((s) => Boolean(s && s.length > 0))
    .join('\n\n');

  const copy = [...blocks];
  copy.splice(idx, 2, {
    ...curr,
    content: combined,
  });
  return copy;
}

export function insertTextBlockAdjacent(
  blocks: TextbookConvertedBlock[],
  anchorBlockId: string,
  position: 'before' | 'after',
  newBlockId: string,
  initialContent = ''
): TextbookConvertedBlock[] {
  const idx = blocks.findIndex((b) => b.id === anchorBlockId);
  const newBlock: TextbookConvertedBlock = {
    id: newBlockId,
    type: 'text',
    pageNumber: 0,
    content: initialContent,
  };
  if (idx === -1) {
    return [...blocks, newBlock];
  }
  const copy = [...blocks];
  const insertIdx = position === 'before' ? idx : idx + 1;
  copy.splice(insertIdx, 0, newBlock);
  return copy;
}

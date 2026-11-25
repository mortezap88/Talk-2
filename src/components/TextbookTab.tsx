import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Check,
  Eye,
  GripVertical,
  ImagePlus,
  Loader2,
  Maximize2,
  Merge,
  Pencil,
  Plus,
  Scissors,
  Trash2,
  X,
} from 'lucide-react';
import type {
  ChatAttachment,
  RightPanelMode,
  TextbookConvertedBlock,
  TextbookData,
  TextbookFigure,
  TextbookFigureAlign,
} from '../types/talk';
import { talkApi } from '../api/talkClient';
import {
  cropNormalizedRegion,
  mergeContinuousTextbookBlocks,
  preparePageImageDataUrl,
  sortImageFilesNaturally,
} from '../utils/imageCrop';
import {
  getNextTextbookImageCode,
  normalizeTextbookFigureCodes,
} from '../utils/textbookImages';
import {
  getBlockFigureAlign,
  getBlockFigureWidthPct,
  inferFigureBoxLayout,
  insertTextBlockAdjacent,
  MAX_FLOAT_WIDTH_PCT,
  mergeTextBlockWithNext,
  MIN_FIGURE_WIDTH_PCT,
  moveTextbookBlock,
  reorderTextbookBlock,
  splitTextBlockAtOffset,
  updateFigureBlockLayout,
} from '../utils/textbookLayout';
import { createId } from '../utils/formatters';
import { RichMessage } from './RichMessage';

const BLOCK_DRAG_MIME = 'application/x-talk-block-id';

interface TextbookTabProps {
  chatId: string;
  textbook: TextbookData;
  mode?: RightPanelMode;
  onSaveTextbook: (chatId: string, next: TextbookData) => Promise<void>;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result) {
        resolve(reader.result);
      } else {
        reject(new Error(`Could not read ${file.name || 'image'}`));
      }
    };
    reader.onerror = () => reject(new Error(`Failed reading ${file.name || 'image'}`));
    reader.readAsDataURL(file);
  });
}

function buildTextbookImages(
  figures: TextbookFigure[],
  blocks: TextbookConvertedBlock[]
): ChatAttachment[] {
  const normalizedFigures = normalizeTextbookFigureCodes(figures);
  const activeFigureIds = new Set(
    blocks.filter((b) => b.type === 'figure' && b.figureId).map((b) => b.figureId!)
  );
  return normalizedFigures
    .filter((f) => activeFigureIds.has(f.id))
    .map((f) => f.image);
}

/**
 * Normalizes any existing TextbookData (including legacy separate `body` + `images` fields)
 * into a single ordered sequence of blocks + figures, separating any trailing user-authored
 * text block so the bottom composer stays seamlessly editable.
 */
function hydrateUnifiedTextbook(textbook: TextbookData): {
  committedBlocks: TextbookConvertedBlock[];
  tailText: string;
  tailBlockId: string;
  figures: TextbookFigure[];
  sourcePageCount: number;
} {
  let blocks: TextbookConvertedBlock[] = [...(textbook.convertedBlocks ?? [])];
  let figures: TextbookFigure[] = normalizeTextbookFigureCodes(textbook.convertedFigures ?? []);

  // Migrate legacy Box 1 text if present
  if (textbook.body && textbook.body.trim()) {
    const bodyTrimmed = textbook.body.trim();
    const alreadyPresent = blocks.some(
      (b) => b.type === 'text' && (b.content || '').trim() === bodyTrimmed
    );
    if (!alreadyPresent) {
      blocks = [
        {
          id: createId('tbb'),
          type: 'text',
          pageNumber: 0,
          content: textbook.body,
        },
        ...blocks,
      ];
    }
  }

  // Migrate legacy unconverted images if no converted blocks/figures were stored yet
  if (blocks.length === 0 && figures.length === 0 && textbook.images?.length > 0) {
    const migratedFigures: TextbookFigure[] = [];
    const migratedBlocks: TextbookConvertedBlock[] = [];
    textbook.images
      .filter((img) => img.kind === 'image' && Boolean(img.dataUrl))
      .forEach((img) => {
        const figId = img.id || createId('tbfig');
        const code = img.textbookCode || getNextTextbookImageCode(migratedFigures);
        const caption = (img.caption || img.name || `Picture ${code}`).trim();
        migratedFigures.push({
          id: figId,
          code,
          pageNumber: img.pageNumber ?? 0,
          caption,
          image: {
            ...img,
            id: figId,
            textbookCode: code,
            caption,
          },
        });
        migratedBlocks.push({
          id: createId('tbb'),
          type: 'figure',
          pageNumber: img.pageNumber ?? 0,
          figureId: figId,
          figureCode: code,
          caption,
          align: 'center',
          widthPct: 60,
        });
      });
    figures = normalizeTextbookFigureCodes(migratedFigures);
    blocks = migratedBlocks;
  }

  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text' && last.pageNumber === 0) {
    return {
      committedBlocks: blocks.slice(0, -1),
      tailText: last.content ?? '',
      tailBlockId: last.id,
      figures,
      sourcePageCount: textbook.sourcePageCount ?? 0,
    };
  }

  return {
    committedBlocks: blocks,
    tailText: '',
    tailBlockId: createId('tbb'),
    figures,
    sourcePageCount: textbook.sourcePageCount ?? 0,
  };
}

function cleanImageLabel(fileName: string | undefined, fallbackCode: string): string {
  if (!fileName) return `Picture ${fallbackCode}`;
  const withoutExt = fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  if (!withoutExt || /^image$/i.test(withoutExt)) {
    return `Picture ${fallbackCode}`;
  }
  return withoutExt;
}

export function TextbookTab({
  chatId,
  textbook,
  mode = 'edit',
  onSaveTextbook,
}: TextbookTabProps) {
  const initial = useMemo(() => hydrateUnifiedTextbook(textbook), []);

  const [committedBlocks, setCommittedBlocks] = useState<TextbookConvertedBlock[]>(
    initial.committedBlocks
  );
  const [tailText, setTailText] = useState<string>(initial.tailText);
  const [tailBlockId, setTailBlockId] = useState<string>(initial.tailBlockId);
  const [figures, setFigures] = useState<TextbookFigure[]>(initial.figures);
  const [sourcePageCount, setSourcePageCount] = useState<number>(initial.sourcePageCount);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [draggingBlockId, setDraggingBlockId] = useState<string | null>(null);
  const [dragOverBlockId, setDragOverBlockId] = useState<string | null>(null);
  const [isEditingAllText, setIsEditingAllText] = useState(false);
  const [editingBlockIds, setEditingBlockIds] = useState<Set<string>>(() => new Set());
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);
  const [analyzeProgress, setAnalyzeProgress] = useState<{
    current: number;
    total: number;
    fileName: string;
  } | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [lightboxFigure, setLightboxFigure] = useState<{
    src: string;
    caption: string;
    code?: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textAreaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef(false);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const onSaveTextbookRef = useRef(onSaveTextbook);
  onSaveTextbookRef.current = onSaveTextbook;
  const lastSavedUpdatedAtRef = useRef<number>(textbook.updatedAt);

  const latestRef = useRef({
    committedBlocks: initial.committedBlocks,
    tailText: initial.tailText,
    tailBlockId: initial.tailBlockId,
    figures: initial.figures,
    sourcePageCount: initial.sourcePageCount,
  });

  useEffect(() => {
    if (textbook.updatedAt === lastSavedUpdatedAtRef.current) {
      return;
    }
    const hydrated = hydrateUnifiedTextbook(textbook);
    setCommittedBlocks(hydrated.committedBlocks);
    setTailText(hydrated.tailText);
    setTailBlockId(hydrated.tailBlockId);
    setFigures(hydrated.figures);
    setSourcePageCount(hydrated.sourcePageCount);
    latestRef.current = hydrated;
    lastSavedUpdatedAtRef.current = textbook.updatedAt;
  }, [textbook]);

  useEffect(() => {
    if (!focusBlockId) return;
    const el = textAreaRefs.current[focusBlockId];
    if (el) {
      el.focus();
      setFocusBlockId(null);
    }
  }, [focusBlockId, committedBlocks, editingBlockIds]);

  useEffect(() => {
    if (!lightboxFigure) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxFigure(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxFigure]);

  const buildTextbookPayload = (snapshot: typeof latestRef.current): TextbookData => {
    const normalizedFigures = normalizeTextbookFigureCodes(snapshot.figures);
    const fullBlocks: TextbookConvertedBlock[] = snapshot.tailText.trim()
      ? [
          ...snapshot.committedBlocks,
          {
            id: snapshot.tailBlockId,
            type: 'text',
            pageNumber: 0,
            content: snapshot.tailText,
          },
        ]
      : snapshot.committedBlocks;

    const images = buildTextbookImages(normalizedFigures, fullBlocks);
    const updatedAt = Date.now();
    lastSavedUpdatedAtRef.current = updatedAt;

    return {
      title: '',
      body: '',
      images,
      convertedBlocks: fullBlocks,
      convertedFigures: normalizedFigures,
      sourcePageCount: snapshot.sourcePageCount,
      updatedAt,
    };
  };

  useEffect(() => {
    const mountedChatId = chatId;
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        const payload = buildTextbookPayload(latestRef.current);
        void onSaveTextbookRef.current(mountedChatId, payload).catch(() => {});
      }
    };
  }, [chatId]);

  const persistSnapshot = async (snapshot: typeof latestRef.current, targetChatId = chatIdRef.current) => {
    pendingSaveRef.current = false;
    const payload = buildTextbookPayload(snapshot);
    await onSaveTextbookRef.current(targetChatId, payload);
    setSaveError(null);
  };

  const scheduleSave = (snapshot: typeof latestRef.current, immediate = false) => {
    latestRef.current = snapshot;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (immediate) {
      pendingSaveRef.current = false;
      void persistSnapshot(snapshot, chatIdRef.current).catch((err) => {
        setSaveError((err as Error).message || 'Could not save textbook.');
      });
      return;
    }

    pendingSaveRef.current = true;
    const targetChatId = chatIdRef.current;
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      try {
        await persistSnapshot(latestRef.current, targetChatId);
      } catch (err) {
        setSaveError((err as Error).message || 'Could not save textbook.');
      }
    }, 500);
  };

  /**
   * Flushes any typed trailing text into committedBlocks cleanly so new pictures
   * or processed book pages always append after what the user already wrote.
   */
  const flushTailTextToCommitted = (snapshot: typeof latestRef.current) => {
    if (!snapshot.tailText.trim()) {
      return {
        blocks: [...snapshot.committedBlocks],
        tailText: '',
        tailBlockId: snapshot.tailBlockId,
      };
    }
    return {
      blocks: [
        ...snapshot.committedBlocks,
        {
          id: snapshot.tailBlockId,
          type: 'text' as const,
          pageNumber: 0,
          content: snapshot.tailText.trim(),
        },
      ],
      tailText: '',
      tailBlockId: createId('tbb'),
    };
  };

  /**
   * Unified smart ingestion for any dropped, pasted, or uploaded image(s):
   * - Text-only pages -> verbatim text blocks
   * - Standalone images/diagrams (visual_only) -> analyzed & named with IMG-N codes, pageNumber=0
   * - Mixed pages -> interleaved verbatim text and cropped figures with IMG-N codes + spatial align/width
   */
  const processTextbookImages = async (fileList: FileList | File[]) => {
    const rawFiles = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    if (rawFiles.length === 0 || analyzeProgress) return;

    const sortedFiles = sortImageFilesNaturally(rawFiles);
    setAnalyzeError(null);
    setIsEditingAllText(false);
    setEditingBlockIds(new Set());

    const flushed = flushTailTextToCommitted(latestRef.current);
    let runningBlocks = [...flushed.blocks];
    let runningFigures = [...latestRef.current.figures];
    let runningPageCount = latestRef.current.sourcePageCount;

    setCommittedBlocks(runningBlocks);
    setTailText(flushed.tailText);
    setTailBlockId(flushed.tailBlockId);
    latestRef.current = {
      committedBlocks: runningBlocks,
      tailText: flushed.tailText,
      tailBlockId: flushed.tailBlockId,
      figures: runningFigures,
      sourcePageCount: runningPageCount,
    };

    try {
      for (let i = 0; i < sortedFiles.length; i++) {
        const file = sortedFiles[i];
        const nextPageNumber = runningPageCount + 1;
        setAnalyzeProgress({
          current: i + 1,
          total: sortedFiles.length,
          fileName: file.name || `Image ${i + 1}`,
        });

        const rawDataUrl = await readFileAsDataUrl(file);
        const prepared = await preparePageImageDataUrl(
          rawDataUrl,
          file.type || 'image/jpeg'
        );
        const dataUrl = prepared.dataUrl;

        let analysis: Awaited<ReturnType<typeof talkApi.analyzeTextbookPage>> | null = null;
        let pageErr: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            analysis = await talkApi.analyzeTextbookPage({
              imageDataUrl: dataUrl,
              mimeType: prepared.mimeType,
              pageNumber: nextPageNumber,
            });
            break;
          } catch (err) {
            pageErr = err;
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, attempt === 0 ? 1200 : 2600));
            }
          }
        }
        if (!analysis) {
          throw new Error(
            `${file.name || `Image ${i + 1}`}: ${(pageErr as Error)?.message || 'Analysis failed'}`
          );
        }

        const isStandaloneVisual = analysis.pageKind === 'visual_only';
        const effectivePageNum = isStandaloneVisual ? 0 : nextPageNumber;
        const analyzedBlocks = Array.isArray(analysis.blocks) ? analysis.blocks : [];
        const pageBlocks: TextbookConvertedBlock[] = [];
        const newFigures: TextbookFigure[] = [];
        let figureCounter = 0;

        for (const rawBlock of analyzedBlocks) {
          if (rawBlock.type === 'text' && rawBlock.content?.trim() && !isStandaloneVisual) {
            pageBlocks.push({
              id: createId('tbb'),
              type: 'text',
              pageNumber: effectivePageNum,
              content: rawBlock.content.trim(),
            });
          } else if (rawBlock.type === 'figure') {
            figureCounter++;
            const box = rawBlock.box_2d ?? ([0, 0, 1000, 1000] as [number, number, number, number]);
            const isFullFrame =
              box[0] <= 20 && box[1] <= 20 && box[2] >= 980 && box[3] >= 980;
            const outputMime =
              isStandaloneVisual && isFullFrame
                ? prepared.mimeType
                : file.type === 'image/png'
                  ? 'image/png'
                  : 'image/jpeg';
            const figureDataUrl =
              isStandaloneVisual && isFullFrame
                ? dataUrl
                : await cropNormalizedRegion(dataUrl, box, outputMime);
            const figureId = createId('tbfig');
            const figureCode = getNextTextbookImageCode([...runningFigures, ...newFigures]);
            const caption =
              rawBlock.caption?.trim() ||
              (isStandaloneVisual
                ? cleanImageLabel(file.name, figureCode)
                : `Figure ${figureCounter} (Page ${effectivePageNum})`);
            const figureName = isStandaloneVisual
              ? file.name || `${figureCode}.jpg`
              : `page-${effectivePageNum}-fig-${figureCounter}.jpg`;

            const resolvedLayout = inferFigureBoxLayout(
              isStandaloneVisual ? undefined : box,
              isStandaloneVisual && rawBlock.align === 'full' ? 'center' : rawBlock.align,
              rawBlock.widthPct
            );

            newFigures.push({
              id: figureId,
              code: figureCode,
              pageNumber: effectivePageNum,
              caption,
              image: {
                id: figureId,
                kind: 'image',
                name: figureName,
                mimeType: outputMime,
                dataUrl: figureDataUrl,
                textbookCode: figureCode,
                caption,
                pageNumber: effectivePageNum,
              },
            });
            pageBlocks.push({
              id: createId('tbb'),
              type: 'figure',
              pageNumber: effectivePageNum,
              figureId,
              figureCode,
              caption,
              align: resolvedLayout.align,
              widthPct: resolvedLayout.widthPct,
            });
          }
        }

        if (isStandaloneVisual && pageBlocks.length === 0) {
          const figureId = createId('tbfig');
          const figureCode = getNextTextbookImageCode([...runningFigures, ...newFigures]);
          const caption = cleanImageLabel(file.name, figureCode);
          newFigures.push({
            id: figureId,
            code: figureCode,
            pageNumber: 0,
            caption,
            image: {
              id: figureId,
              kind: 'image',
              name: file.name || `${figureCode}.jpg`,
              mimeType: prepared.mimeType,
              dataUrl,
              textbookCode: figureCode,
              caption,
              pageNumber: 0,
            },
          });
          pageBlocks.push({
            id: createId('tbb'),
            type: 'figure',
            pageNumber: 0,
            figureId,
            figureCode,
            caption,
            align: 'center',
            widthPct: 58,
          });
        }

        runningBlocks = mergeContinuousTextbookBlocks([...runningBlocks, ...pageBlocks]);
        runningFigures = [...runningFigures, ...newFigures];
        if (!isStandaloneVisual && effectivePageNum > 0) {
          runningPageCount = effectivePageNum;
        }

        const nextSnapshot = {
          committedBlocks: runningBlocks,
          tailText: flushed.tailText,
          tailBlockId: flushed.tailBlockId,
          figures: runningFigures,
          sourcePageCount: runningPageCount,
        };

        setCommittedBlocks(runningBlocks);
        setFigures(runningFigures);
        setSourcePageCount(runningPageCount);
        latestRef.current = nextSnapshot;
        await persistSnapshot(nextSnapshot);
      }
    } catch (err) {
      setAnalyzeError((err as Error).message || 'Failed to process textbook image.');
    } finally {
      setAnalyzeProgress(null);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pastedImages: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) pastedImages.push(file);
      }
    }
    if (pastedImages.length > 0) {
      e.preventDefault();
      void processTextbookImages(pastedImages);
    }
  };

  const handleTailTextChange = (nextVal: string) => {
    setTailText(nextVal);
    scheduleSave({
      ...latestRef.current,
      tailText: nextVal,
    });
  };

  const handleUpdateCommittedText = (blockId: string, nextContent: string) => {
    const nextBlocks = committedBlocks.map((b) =>
      b.id === blockId ? { ...b, content: nextContent } : b
    );
    setCommittedBlocks(nextBlocks);
    scheduleSave({ ...latestRef.current, committedBlocks: nextBlocks });
  };

  const handleRemoveCommittedTextBlock = (blockId: string) => {
    const nextBlocks = committedBlocks.filter((b) => b.id !== blockId);
    setCommittedBlocks(nextBlocks);
    setEditingBlockIds((prev) => {
      const next = new Set(prev);
      next.delete(blockId);
      return next;
    });
    scheduleSave({ ...latestRef.current, committedBlocks: nextBlocks }, true);
  };

  const handleUpdateFigureLayout = (
    blockId: string,
    patch: { align?: TextbookFigureAlign; widthPct?: number },
    immediate = true
  ) => {
    const nextBlocks = updateFigureBlockLayout(committedBlocks, blockId, patch);
    setCommittedBlocks(nextBlocks);
    scheduleSave({ ...latestRef.current, committedBlocks: nextBlocks }, immediate);
  };

  const handleMoveBlock = (blockId: string, direction: 'up' | 'down') => {
    const nextBlocks = moveTextbookBlock(committedBlocks, blockId, direction);
    if (nextBlocks === committedBlocks) return;
    setCommittedBlocks(nextBlocks);
    scheduleSave({ ...latestRef.current, committedBlocks: nextBlocks }, true);
  };

  const handleReorderBlocks = (sourceId: string, targetId: string) => {
    const nextBlocks = reorderTextbookBlock(committedBlocks, sourceId, targetId);
    if (nextBlocks === committedBlocks) return;
    setCommittedBlocks(nextBlocks);
    scheduleSave({ ...latestRef.current, committedBlocks: nextBlocks }, true);
  };

  const handleSplitTextBlock = (blockId: string) => {
    const textarea = textAreaRefs.current[blockId];
    const cursorOffset = textarea ? textarea.selectionStart : undefined;
    const newId = createId('tbb');
    const nextBlocks = splitTextBlockAtOffset(committedBlocks, blockId, cursorOffset, newId);
    if (nextBlocks === committedBlocks) return;
    setCommittedBlocks(nextBlocks);
    setEditingBlockIds((prev) => {
      const next = new Set(prev);
      next.add(blockId);
      next.add(newId);
      return next;
    });
    setFocusBlockId(newId);
    scheduleSave({ ...latestRef.current, committedBlocks: nextBlocks }, true);
  };

  const handleMergeWithNext = (blockId: string) => {
    const nextBlocks = mergeTextBlockWithNext(committedBlocks, blockId);
    if (nextBlocks === committedBlocks) return;
    setCommittedBlocks(nextBlocks);
    scheduleSave({ ...latestRef.current, committedBlocks: nextBlocks }, true);
  };

  const handleInsertTextAfter = (anchorBlockId: string) => {
    const newId = createId('tbb');
    const nextBlocks = insertTextBlockAdjacent(committedBlocks, anchorBlockId, 'after', newId, '');
    setCommittedBlocks(nextBlocks);
    setEditingBlockIds((prev) => {
      const next = new Set(prev);
      next.add(newId);
      return next;
    });
    setFocusBlockId(newId);
    scheduleSave({ ...latestRef.current, committedBlocks: nextBlocks }, false);
  };

  const handleCommitOrAddText = () => {
    if (tailText.trim()) {
      const flushed = flushTailTextToCommitted(latestRef.current);
      setCommittedBlocks(flushed.blocks);
      setTailText(flushed.tailText);
      setTailBlockId(flushed.tailBlockId);
      scheduleSave(
        {
          ...latestRef.current,
          committedBlocks: flushed.blocks,
          tailText: flushed.tailText,
          tailBlockId: flushed.tailBlockId,
        },
        true
      );
      return;
    }
    const newId = createId('tbb');
    const lastId = committedBlocks[committedBlocks.length - 1]?.id ?? '';
    const nextBlocks = insertTextBlockAdjacent(committedBlocks, lastId, 'after', newId, '');
    setCommittedBlocks(nextBlocks);
    setEditingBlockIds((prev) => {
      const next = new Set(prev);
      next.add(newId);
      return next;
    });
    setFocusBlockId(newId);
  };

  const handleUpdateFigureCaption = (figureId: string, nextCaption: string) => {
    const nextBlocks = committedBlocks.map((b) =>
      b.type === 'figure' && b.figureId === figureId ? { ...b, caption: nextCaption } : b
    );
    const nextFigures = figures.map((f) =>
      f.id === figureId
        ? { ...f, caption: nextCaption, image: { ...f.image, caption: nextCaption } }
        : f
    );
    setCommittedBlocks(nextBlocks);
    setFigures(nextFigures);
    scheduleSave({
      ...latestRef.current,
      committedBlocks: nextBlocks,
      figures: nextFigures,
    });
  };

  const handleRemoveFigure = (figureId: string) => {
    const nextBlocks = mergeContinuousTextbookBlocks(
      committedBlocks.filter((b) => !(b.type === 'figure' && b.figureId === figureId))
    );
    const nextFigures = figures.filter((f) => f.id !== figureId);
    setCommittedBlocks(nextBlocks);
    setFigures(nextFigures);
    scheduleSave(
      {
        ...latestRef.current,
        committedBlocks: nextBlocks,
        figures: nextFigures,
      },
      true
    );
  };

  const handleClearTextbook = () => {
    const freshTailId = createId('tbb');
    const cleared = {
      committedBlocks: [],
      tailText: '',
      tailBlockId: freshTailId,
      figures: [],
      sourcePageCount: 0,
    };
    setCommittedBlocks([]);
    setTailText('');
    setTailBlockId(freshTailId);
    setFigures([]);
    setSourcePageCount(0);
    setIsEditingAllText(false);
    setEditingBlockIds(new Set());
    setAnalyzeError(null);
    scheduleSave(cleared, true);
  };

  const toggleBlockEdit = (blockId: string) => {
    setEditingBlockIds((prev) => {
      const next = new Set(prev);
      if (next.has(blockId)) {
        next.delete(blockId);
      } else {
        next.add(blockId);
        setFocusBlockId(blockId);
      }
      return next;
    });
  };

  const isReadMode = mode === 'read';
  const figureMap = new Map(figures.map((f) => [f.id, f]));
  const isAnalyzing = analyzeProgress !== null;
  const hasCommittedText = committedBlocks.some((b) => b.type === 'text');
  const hasAnyContent =
    committedBlocks.length > 0 || tailText.trim().length > 0 || figures.length > 0;

  const lastCommitted = committedBlocks[committedBlocks.length - 1];
  const tailWrapsBesideLastFigure =
    lastCommitted?.type === 'figure' &&
    (getBlockFigureAlign(lastCommitted) === 'left' ||
      getBlockFigureAlign(lastCommitted) === 'right');

  return (
    <div
      className={`flex-1 min-h-0 overflow-y-auto ${
        isReadMode
          ? 'bg-white dark:bg-slate-900'
          : 'bg-slate-50 dark:bg-slate-950 px-4 sm:px-5 pt-14 pb-5'
      }`}
    >
      <div className={isReadMode ? 'w-full min-h-full' : 'max-w-4xl mx-auto'}>
        <section
          aria-label="Textbook"
          onPaste={isReadMode ? undefined : handlePaste}
          onDragOver={(e) => {
            if (isReadMode) return;
            if (e.dataTransfer?.types?.includes(BLOCK_DRAG_MIME)) return;
            e.preventDefault();
            if (!isAnalyzing) setIsDraggingFiles(true);
          }}
          onDragLeave={(e) => {
            if (isReadMode) return;
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setIsDraggingFiles(false);
            }
          }}
          onDrop={(e) => {
            if (isReadMode) return;
            const draggedBlock = e.dataTransfer?.getData(BLOCK_DRAG_MIME);
            if (draggedBlock) {
              setDraggingBlockId(null);
              setDragOverBlockId(null);
              return;
            }
            e.preventDefault();
            setIsDraggingFiles(false);
            if (!isAnalyzing && e.dataTransfer?.files?.length) {
              void processTextbookImages(e.dataTransfer.files);
            }
          }}
          className={
            isReadMode
              ? '@container relative w-full min-h-full bg-white dark:bg-slate-900 px-5 sm:px-7 pt-14 pb-8 space-y-4'
              : `@container relative rounded-xl border bg-white dark:bg-slate-900 p-5 space-y-4 transition-colors ${
                  isDraggingFiles
                    ? 'border-sky-500 ring-2 ring-sky-500/20'
                    : 'border-slate-200 dark:border-slate-800'
                }`
          }
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) {
                void processTextbookImages(e.target.files);
              }
              e.target.value = '';
            }}
          />

          {!isReadMode && !isAnalyzing ? (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <ImagePlus className="w-3.5 h-3.5" />
                <span>Add image</span>
              </button>

              {committedBlocks.length > 0 || tailText.trim().length > 0 ? (
                <button
                  type="button"
                  onClick={handleCommitOrAddText}
                  className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{tailText.trim() ? 'Add to layout' : 'Add text block'}</span>
                </button>
              ) : null}

              {hasCommittedText ? (
                <button
                  type="button"
                  onClick={() => {
                    setIsEditingAllText((v) => !v);
                    setEditingBlockIds(new Set());
                  }}
                  className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  {isEditingAllText ? (
                    <>
                      <Eye className="w-3.5 h-3.5" />
                      <span>Done editing</span>
                    </>
                  ) : (
                    <>
                      <Pencil className="w-3.5 h-3.5" />
                      <span>Edit text</span>
                    </>
                  )}
                </button>
              ) : null}

              {hasAnyContent ? (
                <button
                  type="button"
                  onClick={handleClearTextbook}
                  className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear</span>
                </button>
              ) : null}
            </div>
          ) : null}

          {saveError ? (
            <div
              role="alert"
              className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 flex items-center justify-between gap-2 text-xs text-red-700 dark:text-red-300"
            >
              <span>{saveError}</span>
              <button
                type="button"
                onClick={() => setSaveError(null)}
                aria-label="Dismiss save error"
                className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/60"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : null}

          {analyzeError ? (
            <div
              role="alert"
              className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 flex items-center justify-between gap-2 text-xs text-amber-800 dark:text-amber-300"
            >
              <span>{analyzeError}</span>
              <button
                type="button"
                onClick={() => setAnalyzeError(null)}
                aria-label="Dismiss message"
                className="p-0.5 rounded hover:bg-amber-100 dark:hover:bg-amber-900/60"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : null}

          {/* Whole-box Processing Mode when analyzing uploaded images or book pages */}
          {isAnalyzing && analyzeProgress ? (
            <div className="min-h-[420px] rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-8 flex flex-col items-center justify-center text-center gap-4">
              <Loader2 className="w-8 h-8 animate-spin text-sky-600 dark:text-sky-400" />
              <div className="space-y-1 max-w-md">
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Analyzing image {analyzeProgress.current} of {analyzeProgress.total}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  {analyzeProgress.fileName}
                </p>
              </div>
              <div className="w-full max-w-md h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-sky-600 dark:bg-sky-500 transition-all duration-300"
                  style={{
                    width: `${Math.round((analyzeProgress.current / analyzeProgress.total) * 100)}%`,
                  }}
                />
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Extracting text, isolating diagrams, and matching page layout…
              </p>
            </div>
          ) : (
            <div className="flow-root">
              {/* Committed Sequential Blocks with Editorial Float Wrapping */}
              {committedBlocks.map((block, idx) => {
                const isFirst = idx === 0;
                const isLast = idx === committedBlocks.length - 1;
                const isDropTarget = dragOverBlockId === block.id && draggingBlockId !== block.id;

                if (block.type === 'text') {
                  const isEditingThis =
                    !isReadMode && (isEditingAllText || editingBlockIds.has(block.id));
                  const nextIsText = committedBlocks[idx + 1]?.type === 'text';
                  const contentText = block.content || '';
                  const canSplit =
                    contentText.includes('\n\n') || contentText.trim().length > 16;

                  if (isEditingThis) {
                    return (
                      <div
                        key={block.id}
                        className={`min-w-[220px] overflow-hidden mb-4 rounded-lg border bg-slate-50/70 dark:bg-slate-950/60 p-2 space-y-1.5 ${
                          isDropTarget
                            ? 'border-sky-500 ring-2 ring-sky-500/25'
                            : 'border-sky-300/80 dark:border-sky-800/70'
                        }`}
                        onDragOver={(e) => {
                          if (!draggingBlockId) return;
                          e.preventDefault();
                          setDragOverBlockId(block.id);
                        }}
                        onDrop={(e) => {
                          const srcId = e.dataTransfer?.getData(BLOCK_DRAG_MIME);
                          if (!srcId) return;
                          e.preventDefault();
                          e.stopPropagation();
                          setDraggingBlockId(null);
                          setDragOverBlockId(null);
                          handleReorderBlocks(srcId, block.id);
                        }}
                      >
                        <textarea
                          ref={(el) => {
                            textAreaRefs.current[block.id] = el;
                          }}
                          dir="auto"
                          aria-label={`Edit text block ${idx + 1}`}
                          rows={Math.max(3, Math.min(18, contentText.split('\n').length + 1))}
                          value={contentText}
                          onChange={(e) => handleUpdateCommittedText(block.id, e.target.value)}
                          placeholder="Write text for this section…"
                          className="bidi-plaintext w-full px-3 py-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100 leading-relaxed focus:outline-none focus:border-sky-500 resize-y"
                        />
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <div className="flex flex-wrap items-center gap-1">
                            <button
                              type="button"
                              disabled={isFirst}
                              onClick={() => handleMoveBlock(block.id, 'up')}
                              aria-label="Move text block up"
                              title="Move up"
                              className="h-6 w-6 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-35 inline-flex items-center justify-center"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              disabled={isLast}
                              onClick={() => handleMoveBlock(block.id, 'down')}
                              aria-label="Move text block down"
                              title="Move down"
                              className="h-6 w-6 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-35 inline-flex items-center justify-center"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                            {canSplit ? (
                              <button
                                type="button"
                                onClick={() => handleSplitTextBlock(block.id)}
                                title="Split into two blocks at cursor or paragraph break"
                                className="h-6 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                              >
                                <Scissors className="w-3 h-3" />
                                <span>Split</span>
                              </button>
                            ) : null}
                            {nextIsText ? (
                              <button
                                type="button"
                                onClick={() => handleMergeWithNext(block.id)}
                                title="Merge with next text block"
                                className="h-6 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                              >
                                <Merge className="w-3 h-3" />
                                <span>Merge next</span>
                              </button>
                            ) : null}
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleRemoveCommittedTextBlock(block.id)}
                              className="h-6 px-2 rounded text-[11px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 inline-flex items-center gap-1"
                            >
                              <Trash2 className="w-3 h-3" />
                              <span>Delete block</span>
                            </button>
                            {!isEditingAllText ? (
                              <button
                                type="button"
                                onClick={() => toggleBlockEdit(block.id)}
                                className="h-6 px-2.5 rounded bg-sky-600 text-white text-[11px] font-medium hover:bg-sky-700 inline-flex items-center gap-1"
                              >
                                <Check className="w-3 h-3" />
                                <span>Done</span>
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={block.id}
                      onDoubleClick={isReadMode ? undefined : () => toggleBlockEdit(block.id)}
                      onDragOver={(e) => {
                        if (isReadMode || !draggingBlockId) return;
                        e.preventDefault();
                        setDragOverBlockId(block.id);
                      }}
                      onDrop={(e) => {
                        if (isReadMode) return;
                        const srcId = e.dataTransfer?.getData(BLOCK_DRAG_MIME);
                        if (!srcId) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setDraggingBlockId(null);
                        setDragOverBlockId(null);
                        handleReorderBlocks(srcId, block.id);
                      }}
                      className={
                        isReadMode
                          ? 'mb-4 text-slate-900 dark:text-slate-100'
                          : `group relative mb-4 rounded-lg px-2 py-1 -mx-2 hover:bg-slate-50/80 dark:hover:bg-slate-800/35 transition-colors text-slate-900 dark:text-slate-100 ${
                              isDropTarget ? 'ring-2 ring-sky-500/40 bg-sky-50/40 dark:bg-sky-950/20' : ''
                            }`
                      }
                    >
                      <RichMessage content={contentText} variant="assistant" />
                      {!isReadMode ? (
                        <div className="absolute top-1 right-1 z-20 flex items-center gap-0.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 px-1 py-0.5 shadow-xs opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                          <span
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData(BLOCK_DRAG_MIME, block.id);
                              e.dataTransfer.effectAllowed = 'move';
                              setDraggingBlockId(block.id);
                            }}
                            onDragEnd={() => {
                              setDraggingBlockId(null);
                              setDragOverBlockId(null);
                            }}
                            title="Drag to reorder"
                            className="h-5 w-5 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-grab active:cursor-grabbing"
                          >
                            <GripVertical className="w-3 h-3" />
                          </span>
                          <button
                            type="button"
                            disabled={isFirst}
                            onClick={() => handleMoveBlock(block.id, 'up')}
                            aria-label="Move text block up"
                            title="Move up"
                            className="h-5 w-5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 inline-flex items-center justify-center"
                          >
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            disabled={isLast}
                            onClick={() => handleMoveBlock(block.id, 'down')}
                            aria-label="Move text block down"
                            title="Move down"
                            className="h-5 w-5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 inline-flex items-center justify-center"
                          >
                            <ArrowDown className="w-3 h-3" />
                          </button>
                          {nextIsText ? (
                            <button
                              type="button"
                              onClick={() => handleMergeWithNext(block.id)}
                              aria-label="Merge with next text block"
                              title="Merge with next text block"
                              className="h-5 w-5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white inline-flex items-center justify-center"
                            >
                              <Merge className="w-3 h-3" />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => toggleBlockEdit(block.id)}
                            aria-label="Edit text block"
                            className="h-5 px-1.5 rounded text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white inline-flex items-center gap-1"
                          >
                            <Pencil className="w-3 h-3" />
                            <span>Edit</span>
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                }

                const fig = block.figureId ? figureMap.get(block.figureId) : undefined;
                if (!fig || !fig.image.dataUrl) return null;
                const figCode = fig.code || block.figureCode;
                const captionValue = block.caption ?? fig.caption ?? '';
                const align = getBlockFigureAlign(block);
                const widthPct = getBlockFigureWidthPct(block);
                const maxSliderWidth =
                  align === 'left' || align === 'right' ? MAX_FLOAT_WIDTH_PCT : 100;

                const placementClass =
                  align === 'left'
                    ? 'w-full @md:w-[var(--fig-w)] @md:float-left @md:mr-5 mb-3.5'
                    : align === 'right'
                    ? 'w-full @md:w-[var(--fig-w)] @md:float-right @md:ml-5 mb-3.5'
                    : align === 'full'
                    ? 'clear-both w-full mb-4'
                    : 'clear-both mx-auto w-full @md:w-[var(--fig-w)] mb-4';

                return (
                  <figure
                    key={block.id}
                    data-figure-align={align}
                    data-figure-width={widthPct}
                    style={{ '--fig-w': `${widthPct}%` } as CSSProperties}
                    onDragOver={(e) => {
                      if (isReadMode || !draggingBlockId) return;
                      e.preventDefault();
                      setDragOverBlockId(block.id);
                    }}
                    onDrop={(e) => {
                      if (isReadMode) return;
                      const srcId = e.dataTransfer?.getData(BLOCK_DRAG_MIME);
                      if (!srcId) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setDraggingBlockId(null);
                      setDragOverBlockId(null);
                      handleReorderBlocks(srcId, block.id);
                    }}
                    className={`group relative z-10 ${placementClass} ${
                      isReadMode
                        ? 'rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/40 p-2'
                        : `rounded-xl border bg-slate-50/70 dark:bg-slate-950/60 overflow-hidden transition-shadow ${
                            isDropTarget
                              ? 'border-sky-500 ring-2 ring-sky-500/30'
                              : 'border-slate-200 dark:border-slate-800'
                          }`
                    }`}
                  >
                    {!isReadMode ? (
                      <div className="flex flex-wrap items-center justify-between gap-1 px-2 py-1.5 border-b border-slate-200/80 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95">
                        <div className="flex items-center gap-0.5">
                          <span
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData(BLOCK_DRAG_MIME, block.id);
                              e.dataTransfer.effectAllowed = 'move';
                              setDraggingBlockId(block.id);
                            }}
                            onDragEnd={() => {
                              setDraggingBlockId(null);
                              setDragOverBlockId(null);
                            }}
                            title="Drag to reorder figure"
                            className="h-6 w-5 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-grab active:cursor-grabbing"
                          >
                            <GripVertical className="w-3.5 h-3.5" />
                          </span>

                          <div
                            role="group"
                            aria-label={`Alignment for ${captionValue || figCode || 'figure'}`}
                            className="inline-flex items-center gap-0.5 rounded-md bg-slate-100 dark:bg-slate-800 p-0.5"
                          >
                            {(
                              [
                                {
                                  key: 'left' as const,
                                  label: 'Align figure left (wrap text right)',
                                  title: 'Left · wrap text on right',
                                  Icon: AlignLeft,
                                },
                                {
                                  key: 'center' as const,
                                  label: 'Align figure center',
                                  title: 'Center',
                                  Icon: AlignCenter,
                                },
                                {
                                  key: 'right' as const,
                                  label: 'Align figure right (wrap text left)',
                                  title: 'Right · wrap text on left',
                                  Icon: AlignRight,
                                },
                                {
                                  key: 'full' as const,
                                  label: 'Full width figure',
                                  title: 'Full width',
                                  Icon: Maximize2,
                                },
                              ] as const
                            ).map(({ key, label, title, Icon }) => {
                              const active = align === key;
                              return (
                                <button
                                  key={key}
                                  type="button"
                                  aria-label={label}
                                  aria-pressed={active}
                                  title={title}
                                  onClick={() => handleUpdateFigureLayout(block.id, { align: key })}
                                  className={`h-5 w-5 rounded inline-flex items-center justify-center transition-colors ${
                                    active
                                      ? 'bg-white dark:bg-slate-900 text-sky-600 dark:text-sky-400 shadow-xs'
                                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                                  }`}
                                >
                                  <Icon className="w-3 h-3" />
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div className="flex items-center gap-1">
                          {align !== 'full' ? (
                            <label className="inline-flex items-center gap-1 px-1">
                              <input
                                type="range"
                                min={MIN_FIGURE_WIDTH_PCT}
                                max={maxSliderWidth}
                                step={2}
                                value={widthPct}
                                aria-label={`Width percentage for ${captionValue || figCode || 'figure'}`}
                                onChange={(e) =>
                                  handleUpdateFigureLayout(
                                    block.id,
                                    { widthPct: Number(e.target.value) },
                                    false
                                  )
                                }
                                onPointerUp={(e) =>
                                  handleUpdateFigureLayout(
                                    block.id,
                                    { widthPct: Number((e.target as HTMLInputElement).value) },
                                    true
                                  )
                                }
                                className="w-14 h-1.5 accent-sky-600 cursor-pointer"
                              />
                              <span className="text-[10px] font-mono tabular-nums text-slate-500 dark:text-slate-400 w-7 text-right">
                                {widthPct}%
                              </span>
                            </label>
                          ) : null}

                          <button
                            type="button"
                            disabled={isFirst}
                            onClick={() => handleMoveBlock(block.id, 'up')}
                            aria-label={`Move ${captionValue || figCode || 'figure'} up`}
                            title="Move figure up"
                            className="h-6 w-6 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 inline-flex items-center justify-center"
                          >
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            disabled={isLast}
                            onClick={() => handleMoveBlock(block.id, 'down')}
                            aria-label={`Move ${captionValue || figCode || 'figure'} down`}
                            title="Move figure down"
                            className="h-6 w-6 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 inline-flex items-center justify-center"
                          >
                            <ArrowDown className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleInsertTextAfter(block.id)}
                            aria-label={`Add text after ${captionValue || figCode || 'figure'}`}
                            title="Add text next to / after this figure"
                            className="h-6 px-1.5 rounded text-[11px] font-medium text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-950/50 inline-flex items-center gap-0.5"
                          >
                            <Plus className="w-3 h-3" />
                            <span>Text</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveFigure(fig.id)}
                            aria-label={`Remove ${captionValue || figCode || 'picture'}`}
                            title="Remove figure"
                            className="h-6 w-6 rounded text-slate-400 hover:bg-red-50 dark:hover:bg-red-950/50 hover:text-red-600 dark:hover:text-red-400 inline-flex items-center justify-center"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <div className={isReadMode ? '' : 'p-2.5'}>
                      <button
                        type="button"
                        onClick={() =>
                          setLightboxFigure({
                            src: fig.image.dataUrl!,
                            caption: captionValue,
                            code: figCode,
                          })
                        }
                        className="block w-full overflow-hidden rounded-lg bg-white dark:bg-slate-950 focus-visible:outline-2 focus-visible:outline-sky-500 cursor-zoom-in"
                      >
                        <img
                          src={fig.image.dataUrl}
                          alt={captionValue || figCode || 'Textbook picture'}
                          referrerPolicy="no-referrer"
                          className="w-full max-h-[26rem] object-contain"
                        />
                      </button>

                      <figcaption className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                        {figCode ? (
                          <span
                            dir="ltr"
                            className="font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border border-sky-200/80 dark:border-sky-800/80 shrink-0"
                          >
                            {figCode}
                          </span>
                        ) : null}
                        {fig.pageNumber > 0 ? (
                          <span className="text-[11px] text-slate-400 dark:text-slate-500 shrink-0">
                            Page {fig.pageNumber} ·
                          </span>
                        ) : null}
                        {isReadMode ? (
                          captionValue ? (
                            <span
                              dir="auto"
                              className="bidi-plaintext text-xs text-slate-600 dark:text-slate-300"
                            >
                              {captionValue}
                            </span>
                          ) : null
                        ) : (
                          <input
                            type="text"
                            dir="auto"
                            aria-label={`Caption for ${figCode || 'picture'}`}
                            value={captionValue}
                            onChange={(e) => handleUpdateFigureCaption(fig.id, e.target.value)}
                            placeholder="Optional picture label…"
                            className="bidi-plaintext min-w-[200px] w-full flex-1 max-w-md bg-transparent text-center text-xs text-slate-600 dark:text-slate-300 placeholder:text-slate-400 dark:placeholder:text-slate-600 rounded px-1.5 py-0.5 border border-transparent hover:border-slate-200 dark:hover:border-slate-700 focus:border-sky-500 focus:bg-white dark:focus:bg-slate-900 focus:outline-none"
                          />
                        )}
                      </figcaption>
                    </div>
                  </figure>
                );
              })}

              {/* Seamless Bottom Text Input in Edit mode, or formatted RichMessage in Read mode */}
              {isReadMode ? (
                tailText.trim() ? (
                  <div className="text-slate-900 dark:text-slate-100">
                    <RichMessage content={tailText} variant="assistant" />
                  </div>
                ) : committedBlocks.length === 0 ? (
                  <p className="clear-both py-12 text-center text-sm text-slate-400 dark:text-slate-500">
                    No textbook content yet. Switch to Edit mode to write, paste, or drop textbook pages.
                  </p>
                ) : null
              ) : (
                <div
                  className={
                    tailWrapsBesideLastFigure
                      ? 'min-w-[220px] overflow-hidden'
                      : 'clear-both'
                  }
                >
                  <textarea
                    id="textbook-tail-input"
                    aria-label="Textbook text"
                    dir="auto"
                    rows={committedBlocks.length > 0 ? 5 : 16}
                    value={tailText}
                    onChange={(e) => handleTailTextChange(e.target.value)}
                    placeholder={
                      committedBlocks.length > 0
                        ? tailWrapsBesideLastFigure
                          ? 'Write text beside the figure, paste an image (Ctrl+V), or drop book pages…'
                          : 'Continue writing text here, paste an image (Ctrl+V), or drop images / book pages…'
                        : 'Write or paste textbook text here, paste an image (Ctrl+V), or drop images / book pages…'
                    }
                    className={`bidi-plaintext w-full px-3.5 py-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 text-sm text-slate-900 dark:text-slate-100 leading-relaxed focus:outline-none focus:border-sky-500 resize-y ${
                      committedBlocks.length > 0 ? 'min-h-[128px]' : 'min-h-[420px]'
                    }`}
                  />
                </div>
              )}
            </div>
          )}

          {/* Unified Smart Drag & Drop Overlay */}
          {isDraggingFiles && !isAnalyzing ? (
            <div className="absolute inset-3 z-20 rounded-xl bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs p-3 flex">
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e: DragEvent<HTMLDivElement>) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsDraggingFiles(false);
                  if (e.dataTransfer?.files?.length) {
                    void processTextbookImages(e.dataTransfer.files);
                  }
                }}
                className="flex-1 rounded-xl border-2 border-dashed border-sky-400 dark:border-sky-600 bg-sky-50/70 dark:bg-sky-950/40 flex flex-col items-center justify-center text-center p-6 gap-2.5 transition-colors"
              >
                <div className="w-11 h-11 rounded-xl bg-white dark:bg-slate-900 border border-sky-200 dark:border-sky-800 flex items-center justify-center text-sky-600 dark:text-sky-400">
                  <ImagePlus className="w-5 h-5" />
                </div>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Drop images or textbook pages
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-400 max-w-sm">
                  Extracts verbatim text, isolates diagrams with default layout alignment, and names standalone images with IMG-N codes.
                </p>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      {/* Lightbox for figures */}
      {lightboxFigure ? (
        <div
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-6"
          onClick={() => setLightboxFigure(null)}
        >
          <div
            className="relative max-w-6xl max-h-full flex flex-col items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setLightboxFigure(null)}
              aria-label="Close figure preview"
              className="self-end h-8 w-8 rounded-full bg-white/15 hover:bg-white/25 text-white inline-flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
            <img
              src={lightboxFigure.src}
              alt={lightboxFigure.caption}
              referrerPolicy="no-referrer"
              className="max-h-[78vh] max-w-full rounded-lg bg-white shadow-2xl object-contain"
            />
            {lightboxFigure.caption || lightboxFigure.code ? (
              <p
                dir="auto"
                className="bidi-plaintext text-xs text-slate-200 text-center max-w-2xl flex items-center justify-center gap-2"
              >
                {lightboxFigure.code ? (
                  <span dir="ltr" className="font-mono font-semibold text-sky-300">
                    {lightboxFigure.code}
                  </span>
                ) : null}
                <span>{lightboxFigure.caption}</span>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

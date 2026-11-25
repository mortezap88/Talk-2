import type {
  ChatAttachment,
  ChatMemory,
  ChatMessage,
  ConceptState,
  ConceptStatus,
  MemoryPack,
  NoteData,
  StoredQuestion,
  TextbookData,
} from '../types/talk';
import { serializeConvertedBlocksForPrompt } from './imageCrop';
import {
  buildTextbookImageCatalog,
  collectShownTextbookImageCodes,
} from './textbookImages';

export const ACTIVE_WINDOW_MAX_MESSAGES = 10;
export const ACTIVE_WINDOW_MAX_TOKENS = 12000;
export const COMPACTION_TRIGGER_TOKENS = 1000;
export const PACK_SLOTS = 15;
export const PACK_KEEP_RATIO = 0.8;
export const PACK_QUOTE_SHARE = 0.5;
export const MEMORY_PROMPT_BUDGET_TOKENS = 25000;
export const GEMINI_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const IMAGE_TOKEN_ESTIMATE = 258;
export const TEXTBOOK_MAX_CHARS = 6000;
export const CONVERTED_TEXTBOOK_MAX_CHARS = 24000;
export const TEXTBOOK_MAX_IMAGES = Infinity;
export const MAX_LEARNER_CONCEPTS = 24;
export const MIN_RECENT_TURNS = 10;

const STATUS_PRIORITY: Record<ConceptStatus, number> = {
  misunderstood: 0,
  unresolved: 1,
  shaky: 2,
  understood: 3,
};

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) asciiCount++;
    else nonAsciiCount++;
  }
  return Math.max(1, Math.ceil(asciiCount / 4 + nonAsciiCount / 2));
}

export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = estimateTokens(message.content);
  if (message.attachments) {
    for (const att of message.attachments) {
      if (att.kind === 'image') {
        tokens += IMAGE_TOKEN_ESTIMATE;
      } else if (att.textContent) {
        tokens += estimateTokens(att.textContent);
      }
    }
  }
  return tokens;
}

export function createEmptyMemory(now = Date.now()): ChatMemory {
  return {
    version: 2,
    compactedCount: 0,
    compactedTokens: 0,
    epoch: 0,
    learnerState: [],
    packs: [],
    updatedAt: now,
  };
}

export function sortLearnerState(concepts: ConceptState[]): ConceptState[] {
  return [...concepts]
    .sort((a, b) => {
      const pDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
      if (pDiff !== 0) return pDiff;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, MAX_LEARNER_CONCEPTS);
}

export interface ActiveWindowAnalysis {
  activeWindow: ChatMessage[];
  activeTokens: number;
  uncompactedOutsideWindow: ChatMessage[];
  uncompactedOutsideTokens: number;
  uncompactedTotalCount: number;
}

export function analyzeActiveWindow(
  messages: ChatMessage[],
  compactedCount: number,
  maxMessages = ACTIVE_WINDOW_MAX_MESSAGES
): ActiveWindowAnalysis {
  const safeCompacted = Math.max(0, Math.min(compactedCount, messages.length));
  const uncompactedTail = messages.slice(safeCompacted);

  // Keep the most recent 10 messages verbatim as the immediate conversation window.
  // Everything older than those 10 messages is counted toward the 1,000-token pack threshold.
  const activeWindow = uncompactedTail.slice(-maxMessages);
  const activeTokens = activeWindow.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  const outsideCount = Math.max(0, uncompactedTail.length - activeWindow.length);
  const uncompactedOutsideWindow = uncompactedTail.slice(0, outsideCount);
  const uncompactedOutsideTokens = uncompactedOutsideWindow.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0
  );

  return {
    activeWindow,
    activeTokens,
    uncompactedOutsideWindow,
    uncompactedOutsideTokens,
    uncompactedTotalCount: uncompactedTail.length,
  };
}

export function needsCompaction(
  messages: ChatMessage[],
  memory: ChatMemory
): boolean {
  const analysis = analyzeActiveWindow(messages, memory.compactedCount);
  if (analysis.uncompactedOutsideWindow.length === 0) return false;
  return analysis.uncompactedOutsideTokens >= COMPACTION_TRIGGER_TOKENS;
}

/**
 * Selects whole messages oldest-first until reaching at least `targetMinTokens` (1,000)
 * without ever splitting a message mid-way.
 */
export function selectCompactionChunk(
  outsideMessages: ChatMessage[],
  targetMinTokens = COMPACTION_TRIGGER_TOKENS
): { messages: ChatMessage[]; tokens: number } {
  const selected: ChatMessage[] = [];
  let tokens = 0;
  for (const msg of outsideMessages) {
    selected.push(msg);
    tokens += estimateMessageTokens(msg);
    if (tokens >= targetMinTokens) {
      break;
    }
  }
  return { messages: selected, tokens };
}

export function getTargetSummaryTokens(inputTokens: number): number {
  return Math.max(120, Math.round(inputTokens * PACK_KEEP_RATIO));
}

export function getQuoteAllowance(): number {
  return PACK_QUOTE_SHARE;
}

/**
 * Single-stage rolling 15-room pack ordering: newest first (P1 = newest .. P15 = oldest).
 */
export function getRollingPacks(packs: MemoryPack[]): MemoryPack[] {
  return [...packs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, PACK_SLOTS);
}

/**
 * Inserts a newly compacted pack at P1 (newest), shifting existing packs P1 -> P2 -> ... -> P15.
 */
export function insertRollingPack(
  existingPacks: MemoryPack[],
  newPack: MemoryPack,
  maxSlots = PACK_SLOTS
): MemoryPack[] {
  const orderedExisting = [...existingPacks].sort((a, b) => b.createdAt - a.createdAt);
  const newestTimestamp =
    orderedExisting.length > 0
      ? Math.max(newPack.createdAt, orderedExisting[0].createdAt + 1)
      : newPack.createdAt;
  return [{ ...newPack, createdAt: newestTimestamp }, ...orderedExisting].slice(0, maxSlots);
}

export interface AssembledPromptContext {
  systemPrompt: string;
  selectedMessages: ChatMessage[];
  textbookImagesForLatestUser: ChatAttachment[];
  includedPackIds: string[];
}

export function assembleContextPrompt(params: {
  memory: ChatMemory;
  note?: NoteData | null;
  textbook?: TextbookData | null;
  questions?: StoredQuestion[] | null;
  messages: ChatMessage[];
  extraSystemNotices?: string[];
}): AssembledPromptContext {
  const { memory, note, textbook, questions, messages, extraSystemNotices = [] } = params;
  const sections: string[] = [
    `You are Talk, a rigorous, encouraging study tutor. Help the student understand deeply, catch misconceptions, and build exam-ready mastery.

## Rich Study Formatting Rules (Supported by the App UI)
The Talk UI renders rich study formatting directly in your prose. Write these markers directly in your text WITHOUT wrapping them in backticks (never write \`==term==\` with backticks; write ==term== directly):
- Bold: **text** | Italic: *text* | Underline: __text__ | Strikethrough: ~~wrong~~
- Semantic inline highlights (works in both English and Persian/RTL — write directly without backticks, and never overuse):
  - ==term== → Amber highlighter for core terms, definitions, or key words to memorize.
  - @@concept@@ → Sky concept badge for named laws, mechanisms, structures, or pathways (e.g. @@CIP rule@@, @@T-state@@).
  - ++rule++ → Emerald highlight for verified conclusions, correct rules, or key takeaways.
  - !!pitfall!! → Rose alert highlight for common exam traps or misconceptions.
- Formulas & Math (LaTeX): Wrap chemical formulas, equations, and math expressions in $...$ (inline) or $$...$$ (display block), e.g. $-\\text{CH}=\\text{CH}_2$. Do NOT put ** or \\- inside $...$.
- Structured blocks: Use ## / ### headings, bullet or numbered lists, Markdown comparison tables (| A | B |), fenced code blocks (only for actual code), and study callout boxes:
  - > [!KEY] ... (Key Point)
  - > [!TIP] ... (Study Tip / Mnemonic)
  - > [!TRAP] ... (Exam Trap / Common Mistake)
  - > [!EXAMPLE] ... (Worked Example)
- Keep numbered review Q&A suggestions formatted as 1. ... followed by Answer: ... (or پاسخ: ...) when proposing flashcard-ready questions.`,
  ];

  // 1. Living Learner State (always first & authoritative)
  const sortedConcepts = sortLearnerState(memory.learnerState);
  if (sortedConcepts.length > 0) {
    const lines = sortedConcepts.map(
      (c) => `- [${c.status.toUpperCase()}] ${c.concept}: ${c.note}`
    );
    sections.push(
      `## Living Learner State (AUTHORITATIVE — overrides older episodic memory packs)\n${lines.join('\n')}`
    );
  }

  // 2. Rolling 15-Slot Episodic Memory Packs: select newest-first under budget, present chronologically
  let packBudgetLeft = MEMORY_PROMPT_BUDGET_TOKENS;
  const newestFirst = getRollingPacks(memory.packs);
  const chosenPacks: Array<{ pack: MemoryPack; slotNumber: number }> = [];
  newestFirst.forEach((pack, idx) => {
    const tok = pack.tokenCount || estimateTokens(pack.summary);
    if (chosenPacks.length > 0 && packBudgetLeft - tok < 0) return;
    chosenPacks.push({ pack, slotNumber: idx + 1 });
    packBudgetLeft -= tok;
  });

  const chronologicalPacks = [...chosenPacks].sort(
    (a, b) => a.pack.createdAt - b.pack.createdAt
  );
  if (chronologicalPacks.length > 0) {
    const packLines = chronologicalPacks.map(
      ({ pack, slotNumber }) => `[Memory Pack P${slotNumber}]\n${pack.summary}`
    );
    sections.push(`## Episodic Memory (Chronological)\n${packLines.join('\n\n')}`);
  }

  // 3. Per-chat Notes
  if (note && (note.title.trim() || note.body.trim() || note.tags.length > 0)) {
    const noteHeaderLines: string[] = [];
    if (note.title.trim()) noteHeaderLines.push(`Title: ${note.title.trim()}`);
    if (note.tags.length > 0) noteHeaderLines.push(`Tags: ${note.tags.join(', ')}`);
    const noteBodyText = [noteHeaderLines.join('\n'), note.body].filter(Boolean).join('\n');
    sections.push(`## Notes for this conversation\n${noteBodyText}`);
  }

  // 4. Global Textbook (Box 1 plain text + Box 2 verbatim converted book + coded figure images)
  const textbookCatalog = buildTextbookImageCatalog(textbook, TEXTBOOK_MAX_IMAGES);
  const textbookImages: ChatAttachment[] = textbookCatalog.map((entry) => entry.image);
  const convertedBookText =
    textbook?.convertedBlocks && textbook.convertedBlocks.length > 0
      ? serializeConvertedBlocksForPrompt(
          textbook.convertedBlocks,
          textbook.convertedFigures
        )
      : '';
  const hasTextbookContent = Boolean(
    textbook &&
      (textbook.title.trim() ||
        textbook.body.trim() ||
        convertedBookText.trim() ||
        textbookImages.length > 0)
  );
  if (textbook && hasTextbookContent) {
    const parts: string[] = [];
    if (textbook.title.trim()) {
      parts.push(`Title: ${textbook.title.trim()}`);
    }
    if (textbook.body.trim()) {
      const clippedBody = textbook.body.slice(0, TEXTBOOK_MAX_CHARS);
      const wasClipped = textbook.body.length > TEXTBOOK_MAX_CHARS;
      parts.push(
        `${clippedBody}${wasClipped ? '\n[...truncated at 6,000 characters]' : ''}`
      );
    }
    if (convertedBookText.trim()) {
      const clippedConverted = convertedBookText.slice(0, CONVERTED_TEXTBOOK_MAX_CHARS);
      const wasConvertedClipped = convertedBookText.length > CONVERTED_TEXTBOOK_MAX_CHARS;
      parts.push(
        `${clippedConverted}${
          wasConvertedClipped ? '\n[...truncated at 24,000 characters]' : ''
        }`
      );
    }
    if (parts.length === 0 && textbookImages.length > 0) {
      parts.push('(See attached textbook images below.)');
    }

    if (textbookCatalog.length > 0) {
      const shownCodes = collectShownTextbookImageCodes(messages, memory);
      const shownSet = new Set(shownCodes);
      const indexLines = textbookCatalog.map((entry) => {
        const pageTag = entry.pageNumber && entry.pageNumber > 0 ? ` (Page ${entry.pageNumber})` : '';
        const shownTag = shownSet.has(entry.code)
          ? ' [ALREADY SHOWN IN THIS CHAT — DO NOT DISPLAY AGAIN]'
          : '';
        return `- ${entry.code}${pageTag}: ${entry.caption}${shownTag}`;
      });

      parts.push(
        `### Textbook Image Codes & Inline Chat Display Rules
Each textbook figure/image has a unique code (and its image is attached with this matching label):
${indexLines.join('\n')}

How to connect textbook images inside your chat reply:
- Only when the student's question or your explanation is directly connected to one of these textbook images and showing it will clarify the concept, output its exact marker on its own line (without backticks): [[IMG-1]] (using the matching code).
- SHOW AT MOST ONCE PER CHAT: Never emit [[IMG-N]] again for any code marked [ALREADY SHOWN IN THIS CHAT]. If you refer back to an already-shown figure later in the conversation, mention it naturally in words (e.g., "as shown in IMG-1 earlier") without re-displaying the image.${
          shownCodes.length > 0
            ? `\nAlready shown earlier in this conversation (do NOT emit [[...]] again): ${shownCodes.join(', ')}`
            : ''
        }`
      );
    }

    sections.push(`## Global Textbook (AUTHORITATIVE REFERENCE)\n${parts.join('\n\n')}`);
  }

  // 5. Saved Study Questions for this chat
  if (questions && questions.length > 0) {
    const qLines = questions.map((q, idx) => {
      const ans = q.answer?.trim() ? `\n   Answer: ${q.answer.trim()}` : '';
      return `${idx + 1}. ${q.question.trim()}${ans}`;
    });
    sections.push(`## Saved Study Questions for this conversation\n${qLines.join('\n')}`);
  }

  // 6. Extra system notices (e.g., Tavily search results)
  for (const notice of extraSystemNotices) {
    if (notice.trim()) {
      sections.push(notice.trim());
    }
  }

  // 7. Immediate conversation messages: always keep the last 10 messages verbatim, plus any uncompacted messages within budget
  const safeCompacted = Math.max(0, Math.min(memory.compactedCount, messages.length));
  const tail = messages.slice(safeCompacted);
  const selectedMessages: ChatMessage[] = [];
  let tokenBudget = ACTIVE_WINDOW_MAX_TOKENS;

  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    const tok = estimateMessageTokens(m);
    const insideImmediateWindow = selectedMessages.length < MIN_RECENT_TURNS;
    if (!insideImmediateWindow && tokenBudget - tok < 0) {
      break;
    }
    selectedMessages.unshift(m);
    tokenBudget -= tok;
  }

  return {
    systemPrompt: sections.join('\n\n'),
    selectedMessages,
    textbookImagesForLatestUser: textbookImages,
    includedPackIds: chronologicalPacks.map((item) => item.pack.id),
  };
}

export interface NextRequestTokenBreakdown {
  systemAndLearnerTokens: number;
  memoryPacksTokens: number;
  packCount: number;
  notesTokens: number;
  textbookTextTokens: number;
  textbookImagesTokens: number;
  textbookImageCount: number;
  questionsTokens: number;
  questionCount: number;
  historyMessagesTokens: number;
  historyMessageCount: number;
  historyImageCount: number;
  draftTextTokens: number;
  draftAttachmentsTokens: number;
  draftImageCount: number;
  estimatedBaseTokens: number;
  estimatedDraftTokens: number;
  estimatedTotalTokens: number;
  assembledBase: AssembledPromptContext;
  draftMessage: ChatMessage | null;
}

/**
 * Computes a complete token breakdown covering everything sent on the next request:
 * base instructions, all active episodic memory packs, per-chat notes,
 * global textbook text + all textbook images, saved study questions, active chat history + images,
 * and the current unsent composer draft + pending attachments.
 */
export function computeNextRequestTokenBreakdown(params: {
  memory: ChatMemory;
  note?: NoteData | null;
  textbook?: TextbookData | null;
  questions?: StoredQuestion[] | null;
  messages: ChatMessage[];
  draftText?: string;
  draftAttachments?: ChatAttachment[];
}): NextRequestTokenBreakdown {
  const {
    memory,
    note,
    textbook,
    questions = [],
    messages,
    draftText = '',
    draftAttachments = [],
  } = params;

  const assembledBase = assembleContextPrompt({
    memory,
    note,
    textbook,
    questions,
    messages,
  });

  // Breakdown of sections inside systemPrompt
  const sectionParts = assembledBase.systemPrompt.split('\n\n## ');
  let systemAndLearnerTokens = 0;
  let memoryPacksTokens = 0;
  let notesTokens = 0;
  let textbookTextTokens = 0;
  let questionsTokens = 0;

  sectionParts.forEach((rawPart, idx) => {
    const part = idx === 0 ? rawPart : `## ${rawPart}`;
    const tok = estimateTokens(part);
    if (part.startsWith('## Episodic Memory')) {
      memoryPacksTokens += tok;
    } else if (part.startsWith('## Notes for this conversation')) {
      notesTokens += tok;
    } else if (part.startsWith('## Global Textbook')) {
      textbookTextTokens += tok;
    } else if (part.startsWith('## Saved Study Questions')) {
      questionsTokens += tok;
    } else {
      systemAndLearnerTokens += tok;
    }
  });

  const textbookImageCount = assembledBase.textbookImagesForLatestUser.length;
  const textbookImagesTokens = textbookImageCount * IMAGE_TOKEN_ESTIMATE;

  let historyMessagesTokens = 0;
  let historyImageCount = 0;
  for (const m of assembledBase.selectedMessages) {
    historyMessagesTokens += estimateMessageTokens(m);
    if (m.attachments) {
      historyImageCount += m.attachments.filter((a) => a.kind === 'image' && a.dataUrl).length;
    }
  }

  const hasDraft = Boolean(draftText.length > 0 || draftAttachments.length > 0);
  const draftMessage: ChatMessage | null = hasDraft
    ? {
        id: '__draft__',
        role: 'user',
        content: draftText,
        createdAt: 0,
        attachments: draftAttachments.length > 0 ? draftAttachments : undefined,
      }
    : null;

  const draftTextTokens = estimateTokens(draftText);
  let draftAttachmentsTokens = 0;
  let draftImageCount = 0;
  for (const att of draftAttachments) {
    if (att.kind === 'image') {
      draftImageCount++;
      draftAttachmentsTokens += IMAGE_TOKEN_ESTIMATE;
    } else if (att.textContent) {
      draftAttachmentsTokens += estimateTokens(att.textContent);
    }
  }

  const estimatedBaseTokens =
    systemAndLearnerTokens +
    memoryPacksTokens +
    notesTokens +
    textbookTextTokens +
    textbookImagesTokens +
    questionsTokens +
    historyMessagesTokens;

  const estimatedDraftTokens = draftTextTokens + draftAttachmentsTokens;

  return {
    systemAndLearnerTokens,
    memoryPacksTokens,
    packCount: assembledBase.includedPackIds.length,
    notesTokens,
    textbookTextTokens,
    textbookImagesTokens,
    textbookImageCount,
    questionsTokens,
    questionCount: questions?.length ?? 0,
    historyMessagesTokens,
    historyMessageCount: assembledBase.selectedMessages.length,
    historyImageCount,
    draftTextTokens,
    draftAttachmentsTokens,
    draftImageCount,
    estimatedBaseTokens,
    estimatedDraftTokens,
    estimatedTotalTokens: estimatedBaseTokens + estimatedDraftTokens,
    assembledBase,
    draftMessage,
  };
}

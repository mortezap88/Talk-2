import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQaSuggestions,
  parseChatIntent,
  parseMessageSegments,
} from './qaParser';
import {
  analyzeActiveWindow,
  assembleContextPrompt,
  COMPACTION_TRIGGER_TOKENS,
  computeNextRequestTokenBreakdown,
  createEmptyMemory,
  GEMINI_CONTEXT_WINDOW_TOKENS,
  getQuoteAllowance,
  getTargetSummaryTokens,
  insertRollingPack,
  mergeLearnerState,
  needsCompaction,
  PACK_SLOTS,
  sanitizeMemoryPackOutput,
  selectCompactionChunk,
  sortLearnerState,
  stripHighlightMarkup,
  TEXTBOOK_MAX_CHARS,
  TEXTBOOK_MAX_IMAGES,
} from './memoryEngine';
import type { ChatMessage, ConceptState, MemoryPack } from '../types/talk';
import {
  computeComposerLayout,
  dedupeById,
  normalizeThinkingLevelForModel,
  supportsXhighThinking,
} from './formatters';
import {
  mergeContinuousTextbookBlocks,
  normalizeBoxToPixels,
  serializeConvertedBlocksForPrompt,
} from './imageCrop';
import {
  encodeMonoWav,
  SilenceAudioChunker,
  TARGET_SAMPLE_RATE,
} from './voiceChunker';
import {
  buildTextbookImageCatalog,
  collectShownTextbookImageCodes,
  extractTextbookImageCodes,
  getNextTextbookImageCode,
  normalizeTextbookFigureCodes,
} from './textbookImages';
import {
  inferFigureBoxLayout,
  insertTextBlockAdjacent,
  mergeTextBlockWithNext,
  moveTextbookBlock,
  reorderTextbookBlock,
  splitTextBlockAtOffset,
  updateFigureBlockLayout,
} from './textbookLayout';
import { toGeminiThinkingLevel } from '../../server/gemini';
import { ThinkingLevel as GenAiThinkingLevel } from '@google/genai';

test('parseQaSuggestions extracts English numbered Q&A pairs', () => {
  const reply = `Here are two practice questions:

1. Why does the Bohr curve shift right during exercise?
Answer: Increased CO2 and lower pH stabilize the T-state of hemoglobin, decreasing oxygen affinity so tissues receive more O2.

2. What is the Haldane effect?
Answer: Deoxygenated hemoglobin binds H+ and CO2 more readily in peripheral capillaries.`;

  const parsed = parseQaSuggestions(reply);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].question, 'Why does the Bohr curve shift right during exercise?');
  assert.match(parsed[0].answer, /T-state of hemoglobin/);
  assert.equal(parsed[1].question, 'What is the Haldane effect?');
});

test('parseQaSuggestions extracts Persian numbered Q&A pairs', () => {
  const reply = `چند سوال تمرینی:

۱. اثر بور چیست؟
پاسخ: کاهش pH و افزایش دی‌اکسید کربن تمایل هموگلوبین به اکسیژن را کاهش می‌دهد.

۲. چرا پیوند پپتیدی مسطح است؟
جواب: به دلیل رزونانس بین جفت الکترون نیتروژن و گروه کربونیل.`;

  const parsed = parseQaSuggestions(reply);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].question, 'اثر بور چیست؟');
  assert.match(parsed[0].answer, /هموگلوبین/);
  assert.equal(parsed[1].question, 'چرا پیوند پپتیدی مسطح است؟');
});

test('parseChatIntent recognizes add, delete, and change intents', () => {
  assert.deepEqual(parseChatIntent('add this question'), { type: 'add_last_question' });
  assert.deepEqual(parseChatIntent('Save this question!'), { type: 'add_last_question' });
  assert.deepEqual(parseChatIntent('delete question 2'), { type: 'delete_question', index: 2 });
  assert.deepEqual(parseChatIntent('delete question ۳'), { type: 'delete_question', index: 3 });
  assert.deepEqual(
    parseChatIntent('change question 1 to Explain Gibbs free energy'),
    { type: 'change_question', index: 1, newQuestion: 'Explain Gibbs free energy' }
  );
  assert.equal(parseChatIntent('Tell me more about thermodynamics'), null);
});

test('parseMessageSegments splits fenced code blocks safely', () => {
  const segments = parseMessageSegments('Intro\n```ts\nconst x = 1;\n```\nOutro');
  assert.equal(segments.length, 3);
  assert.equal(segments[0].type, 'text');
  assert.equal(segments[1].type, 'code');
  assert.equal(segments[1].language, 'ts');
  assert.equal(segments[1].content, 'const x = 1;');
  assert.equal(segments[2].type, 'text');
});

test('sortLearnerState enforces misunderstood -> unresolved -> shaky -> understood priority and max 24', () => {
  const now = 1000;
  const list: ConceptState[] = [
    { id: '1', concept: 'U1', status: 'understood', note: 'good', updatedAt: now },
    { id: '2', concept: 'S1', status: 'shaky', note: 'review', updatedAt: now },
    { id: '3', concept: 'M1', status: 'misunderstood', note: 'wrong sign', updatedAt: now },
    { id: '4', concept: 'R1', status: 'unresolved', note: 'open', updatedAt: now },
  ];
  const sorted = sortLearnerState(list);
  assert.deepEqual(
    sorted.map((c) => c.status),
    ['misunderstood', 'unresolved', 'shaky', 'understood']
  );
});

test('active window keeps last 10 messages verbatim and triggers pack at 1000 outside tokens', () => {
  const msgs: ChatMessage[] = Array.from({ length: 22 }, (_, idx) => ({
    id: `m_${idx}`,
    role: idx % 2 === 0 ? 'user' : 'assistant',
    content: 'a'.repeat(400), // 100 tokens each
    createdAt: idx * 1000,
  }));
  const mem = createEmptyMemory(0);
  const analysis = analyzeActiveWindow(msgs, mem.compactedCount);
  assert.equal(analysis.activeWindow.length, 10);
  assert.equal(analysis.activeWindow[0].id, 'm_12');
  assert.equal(analysis.uncompactedOutsideWindow.length, 12);
  assert.equal(analysis.uncompactedOutsideTokens, 1200);
  assert.equal(needsCompaction(msgs, mem), true);

  // Chunk selection takes whole messages oldest-first until >= 1,000 tokens without splitting
  const bigMsgs: ChatMessage[] = [
    { id: 'b1', role: 'user', content: 'x'.repeat(1600), createdAt: 1000 }, // 400 tok
    { id: 'b2', role: 'assistant', content: 'x'.repeat(1600), createdAt: 2000 }, // 400 tok (800 total)
    { id: 'b3', role: 'user', content: 'x'.repeat(1800), createdAt: 3000 }, // 450 tok (1250 total -> stops here)
    { id: 'b4', role: 'assistant', content: 'x'.repeat(800), createdAt: 4000 }, // 200 tok (remains for next chunk)
  ];
  const chunk = selectCompactionChunk(bigMsgs, COMPACTION_TRIGGER_TOKENS);
  assert.deepEqual(chunk.messages.map((m) => m.id), ['b1', 'b2', 'b3']);
  assert.equal(chunk.tokens, 1250);
});

test('single-stage rolling packs target ~80% retention, 50% quotes, and shift P1 -> P15 across 15 slots', () => {
  assert.equal(PACK_SLOTS, 15);
  assert.equal(getTargetSummaryTokens(1000), 800);
  assert.equal(getQuoteAllowance(), 0.5);

  let packs: MemoryPack[] = [];
  for (let i = 1; i <= 16; i++) {
    packs = insertRollingPack(packs, {
      id: `p_${i}`,
      stage: 1,
      summary: `Pack ${i}`,
      bullets: [],
      tokenCount: 800,
      createdAt: i * 1000,
    });
  }
  assert.equal(packs.length, 15);
  // Newest pack (#16) sits in P1 (index 0), shifting older packs down and dropping #1
  assert.equal(packs[0].id, 'p_16');
  assert.equal(packs[1].id, 'p_15');
  assert.equal(packs[14].id, 'p_2');
});

test('assembleContextPrompt clips textbook at 6000 chars, puts learner state first, and orders packs chronologically', () => {
  const mem = createEmptyMemory(100);
  mem.learnerState = [
    { id: 'c1', concept: 'Keq', status: 'misunderstood', note: 'confused with Q', updatedAt: 500 },
  ];
  mem.packs = [
    { id: 'p_new', stage: 1, summary: 'NEWER PACK', bullets: [], tokenCount: 120, createdAt: 2000 },
    { id: 'p_old', stage: 2, summary: 'OLDER PACK', bullets: [], tokenCount: 120, createdAt: 1000 },
  ];
  const longTextbook = 'X'.repeat(TEXTBOOK_MAX_CHARS + 500);
  const assembled = assembleContextPrompt({
    memory: mem,
    note: { title: 'Bio', body: 'Check chapter 4', tags: ['exam'], updatedAt: 100 },
    textbook: {
      title: 'Campbell',
      body: longTextbook,
      images: [{ id: 'img1', kind: 'image', name: 'fig1.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }],
      updatedAt: 100,
    },
    messages: [{ id: 'm1', role: 'user', content: 'Hi', createdAt: 100 }],
  });

  const learnerIdx = assembled.systemPrompt.indexOf('Living Learner State');
  const episodicIdx = assembled.systemPrompt.indexOf('Episodic Memory');
  const olderIdx = assembled.systemPrompt.indexOf('OLDER PACK');
  const newerIdx = assembled.systemPrompt.indexOf('NEWER PACK');
  assert.ok(learnerIdx !== -1 && episodicIdx > learnerIdx);
  assert.ok(olderIdx !== -1 && newerIdx > olderIdx);
  assert.ok(assembled.systemPrompt.includes('[...truncated at 6,000 characters]'));
  assert.equal(assembled.textbookImagesForLatestUser.length, 1);
});

test('toGeminiThinkingLevel maps all 4 gemini-4-hydrogen options without MINIMAL', () => {
  assert.equal(toGeminiThinkingLevel('low'), GenAiThinkingLevel.LOW);
  assert.equal(toGeminiThinkingLevel('medium'), GenAiThinkingLevel.MEDIUM);
  assert.equal(toGeminiThinkingLevel('high'), GenAiThinkingLevel.HIGH);
  assert.equal(toGeminiThinkingLevel('xhigh'), GenAiThinkingLevel.XHIGH);
});

test('computeComposerLayout grows vertically without scrollbars until maxHeight', () => {
  assert.deepEqual(computeComposerLayout(34, 2, 36, 180), {
    heightPx: 36,
    overflowY: 'hidden',
  });
  assert.deepEqual(computeComposerLayout(78, 2, 36, 180), {
    heightPx: 80,
    overflowY: 'hidden',
  });
  assert.deepEqual(computeComposerLayout(220, 2, 36, 180), {
    heightPx: 180,
    overflowY: 'auto',
  });
});

test('supportsXhighThinking and normalizeThinkingLevelForModel restrict xhigh to gemini-4-hydrogen', () => {
  assert.equal(supportsXhighThinking('gemini-4-hydrogen'), true);
  assert.equal(supportsXhighThinking('gemini-3.8-flash'), false);
  assert.equal(supportsXhighThinking('gemini-3.5-flash-lite'), false);

  assert.equal(normalizeThinkingLevelForModel('xhigh', 'gemini-4-hydrogen'), 'xhigh');
  assert.equal(normalizeThinkingLevelForModel('xhigh', 'gemini-3.8-flash'), 'high');
  assert.equal(normalizeThinkingLevelForModel('xhigh', 'gemini-3.5-flash-lite'), 'high');
  assert.equal(normalizeThinkingLevelForModel('medium', 'gemini-3.8-flash'), 'medium');
});

test('assembleContextPrompt supports more than 20 textbook images without capping and omits empty titles', () => {
  assert.equal(TEXTBOOK_MAX_IMAGES, Infinity);
  const images = Array.from({ length: 24 }, (_, idx) => ({
    id: `img_${idx}`,
    kind: 'image' as const,
    name: `page-${idx + 1}.png`,
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,AA==',
  }));
  const assembled = assembleContextPrompt({
    memory: createEmptyMemory(100),
    note: { title: '', body: 'Remember Km decreases with uncompetitive inhibitors.', tags: [], updatedAt: 100 },
    textbook: { title: '', body: 'Enzyme kinetics notes.', images, updatedAt: 100 },
    messages: [{ id: 'm1', role: 'user', content: 'Quiz me', createdAt: 100 }],
  });

  assert.equal(assembled.textbookImagesForLatestUser.length, 24);
  assert.equal(assembled.systemPrompt.includes('Title: Untitled'), false);
  assert.equal(assembled.systemPrompt.includes('Title: Reference Document'), false);
  assert.ok(assembled.systemPrompt.includes('Remember Km decreases'));
});

test('mergeContinuousTextbookBlocks joins broken cross-page sentences verbatim and preserves user sections & pictures', () => {
  const merged = mergeContinuousTextbookBlocks([
    { id: 'u0', type: 'text', pageNumber: 0, content: 'My notes before the chapter' },
    { id: 'pic0', type: 'figure', pageNumber: 0, figureId: 'pic_heart', caption: 'Heart anatomy' },
    { id: 'b1', type: 'text', pageNumber: 1, content: 'Hemoglobin binds oxygen in the' },
    { id: 'b2', type: 'text', pageNumber: 2, content: 'alveolar capillaries.' },
    { id: 'b3', type: 'figure', pageNumber: 2, figureId: 'fig1', caption: 'Figure 42.1' },
    { id: 'b4', type: 'text', pageNumber: 2, content: '## Bohr Shift\nLower pH releases more oxygen.' },
  ]);

  assert.equal(merged.length, 5);
  assert.equal(merged[0].content, 'My notes before the chapter');
  assert.equal(merged[1].type, 'figure');
  assert.equal(merged[2].content, 'Hemoglobin binds oxygen in the alveolar capillaries.');
  assert.equal(merged[3].type, 'figure');
  assert.equal(merged[4].type, 'text');

  const serialized = serializeConvertedBlocksForPrompt(merged);
  assert.ok(serialized.includes('[Image Code: IMG-1] [Picture: Heart anatomy]'));
  assert.ok(serialized.includes('Hemoglobin binds oxygen in the alveolar capillaries.'));
  assert.ok(serialized.includes('[Image Code: IMG-2] [Figure from Page 2: Figure 42.1]'));

  const crop = normalizeBoxToPixels([100, 200, 500, 800], 1000, 2000, 10);
  assert.deepEqual(crop, { sx: 190, sy: 180, sw: 620, sh: 840 });
  assert.equal(normalizeBoxToPixels([100, 100, 105, 105], 1000, 1000), null);
});

test('textbook image catalog assigns stable IMG-N codes and tracks already-shown images once per chat', () => {
  const existingFigs = [
    {
      id: 'f1',
      code: 'IMG-1',
      pageNumber: 2,
      caption: 'Bohr Shift Curve',
      image: { id: 'f1', kind: 'image' as const, name: 'fig1.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AA==' },
    },
    {
      id: 'f3',
      code: 'IMG-3',
      pageNumber: 5,
      caption: 'Enzyme Kinetics',
      image: { id: 'f3', kind: 'image' as const, name: 'fig3.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,BB==' },
    },
  ];
  assert.equal(getNextTextbookImageCode(existingFigs), 'IMG-4');

  const normalized = normalizeTextbookFigureCodes([
    { ...existingFigs[0], code: undefined },
    existingFigs[1],
  ]);
  assert.equal(normalized[0].code, 'IMG-1');
  assert.equal(normalized[1].code, 'IMG-3');

  const textbook = {
    title: '',
    body: 'See the diagrams.',
    images: [],
    convertedBlocks: [
      { id: 'b1', type: 'figure' as const, pageNumber: 2, figureId: 'f1', caption: 'Bohr Shift Curve' },
      { id: 'b2', type: 'figure' as const, pageNumber: 5, figureId: 'f3', caption: 'Enzyme Kinetics' },
    ],
    convertedFigures: normalized,
    updatedAt: 100,
  };

  const catalog = buildTextbookImageCatalog(textbook);
  assert.deepEqual(catalog.map((c) => c.code), ['IMG-1', 'IMG-3']);

  assert.deepEqual(extractTextbookImageCodes('Check [[IMG-1]], [[img 3]], and [[IMG-1]]'), ['IMG-1', 'IMG-3']);

  const mem = createEmptyMemory(100);
  mem.packs = [
    { id: 'p1', stage: 1, summary: 'Earlier we covered [[IMG-1]] in detail.', bullets: [], tokenCount: 40, createdAt: 100 },
  ];
  const msgs: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'Show [[IMG-3]]?', createdAt: 200 },
    { id: 'a1', role: 'assistant', content: 'Here is the kinetics plot:\n[[IMG-3]]', createdAt: 300 },
  ];
  assert.deepEqual(collectShownTextbookImageCodes(msgs, mem), ['IMG-1', 'IMG-3']);

  const assembled = assembleContextPrompt({
    memory: mem,
    textbook,
    messages: [{ id: 'u2', role: 'user', content: 'Remind me about the Bohr shift', createdAt: 400 }],
  });

  assert.equal(assembled.textbookImagesForLatestUser[0].textbookCode, 'IMG-1');
  assert.equal(assembled.textbookImagesForLatestUser[1].textbookCode, 'IMG-3');
  assert.ok(assembled.systemPrompt.includes('IMG-1 (Page 2): Bohr Shift Curve [ALREADY SHOWN IN THIS CHAT — DO NOT DISPLAY AGAIN]'));
  assert.ok(assembled.systemPrompt.includes('Already shown earlier in this conversation (do NOT emit [[...]] again): IMG-1'));
});

test('computeNextRequestTokenBreakdown accounts for notes, textbook + images, questions, memory packs, chat, and draft', () => {
  assert.equal(GEMINI_CONTEXT_WINDOW_TOKENS, 1_048_576);

  const mem = createEmptyMemory(100);
  mem.learnerState = [
    { id: 'c_bohr', concept: 'Bohr Effect', status: 'shaky', note: 'Needs review', updatedAt: 100 },
  ];
  mem.packs = [
    { id: 'p1', stage: 1, summary: 'Covered hemoglobin cooperative binding.', bullets: [], tokenCount: 55, createdAt: 100 },
    { id: 'p2', stage: 1, summary: 'Practiced 2,3-BPG shift effects.', bullets: [], tokenCount: 60, createdAt: 200 },
  ];

  const note = {
    title: '',
    body: 'Remember: lower pH shifts curve right (Bohr effect).',
    tags: [],
    updatedAt: 200,
  };

  const textbook = {
    title: '',
    body: 'Hemoglobin binds four O2 molecules cooperatively.',
    images: [
      { id: 'tb_img1', kind: 'image' as const, name: 'curve.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
    ],
    convertedBlocks: [],
    convertedFigures: [],
    updatedAt: 300,
  };

  const questions = [
    {
      id: 'q1',
      question: 'Why does high CO2 promote O2 unloading?',
      answer: 'CO2 lowers pH and stabilizes the T-state.',
      createdAt: 350,
      updatedAt: 350,
    },
  ];

  const messages: ChatMessage[] = [
    {
      id: 'm1',
      role: 'user',
      content: 'Explain this diagram please.',
      createdAt: 400,
      attachments: [
        { id: 'msg_img1', kind: 'image', name: 'slide.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,BB==' },
      ],
    },
  ];

  const breakdown = computeNextRequestTokenBreakdown({
    memory: mem,
    note,
    textbook,
    questions,
    messages,
    draftText: 'سلام، آیا افزایش دما هم نمودار را جابجا می‌کند؟',
    draftAttachments: [
      { id: 'draft_img1', kind: 'image', name: 'note.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,CC==' },
    ],
  });

  assert.ok(breakdown.assembledBase.systemPrompt.includes('## Saved Study Questions for this conversation'));
  assert.ok(breakdown.assembledBase.systemPrompt.includes('Why does high CO2 promote O2 unloading?'));

  assert.ok(breakdown.systemAndLearnerTokens > 0);
  assert.equal(breakdown.packCount, 2);
  assert.ok(breakdown.memoryPacksTokens > 0);
  assert.ok(breakdown.notesTokens > 0);
  assert.ok(breakdown.textbookTextTokens > 0);
  assert.equal(breakdown.textbookImageCount, 1);
  assert.equal(breakdown.textbookImagesTokens, 258);
  assert.equal(breakdown.questionCount, 1);
  assert.ok(breakdown.questionsTokens > 0);
  assert.equal(breakdown.historyMessageCount, 1);
  assert.equal(breakdown.historyImageCount, 1);
  assert.ok(breakdown.historyMessagesTokens >= 258);
  assert.ok(breakdown.draftTextTokens > 10);
  assert.equal(breakdown.draftImageCount, 1);
  assert.equal(breakdown.draftAttachmentsTokens, 258);
  assert.equal(
    breakdown.estimatedTotalTokens,
    breakdown.estimatedBaseTokens + breakdown.estimatedDraftTokens
  );
  assert.ok(breakdown.draftMessage !== null);
});

test('SilenceAudioChunker waits at least 20s, refreshes silence timer while speaking, and cuts on 0.3s silence', async () => {
  const emitted: Array<{ blob: Blob; durationMs: number }> = [];
  const chunker = new SilenceAudioChunker({
    sampleRate: TARGET_SAMPLE_RATE,
    silenceCutMs: 300,
    minPatchMs: 20000,
    maxPatchMs: 45000,
    onChunk: (blob, durationMs) => {
      emitted.push({ blob, durationMs });
    },
  });

  const makeFrame = (durationMs: number, amplitude: number) => {
    const len = Math.round((durationMs / 1000) * TARGET_SAMPLE_RATE);
    const buf = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      buf[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / TARGET_SAMPLE_RATE);
    }
    return buf;
  };

  // Pure silence should not emit anything
  for (let i = 0; i < 6; i++) {
    chunker.push(makeFrame(100, 0.001));
  }
  assert.equal(emitted.length, 0);

  // Even a 0.6s pause at 5s must NOT cut before 20s minimum is reached
  for (let i = 0; i < 50; i++) {
    chunker.push(makeFrame(100, 0.12));
  }
  for (let i = 0; i < 6; i++) {
    chunker.push(makeFrame(100, 0.001));
  }
  assert.equal(emitted.length, 0);

  // Continue speaking up to ~20.2s -> still active, no silence cut yet
  for (let i = 0; i < 146; i++) {
    chunker.push(makeFrame(100, 0.12));
  }
  assert.equal(emitted.length, 0);

  // At ~20.2s, pause 0.2s (< 0.3s) then speak again for 1.5s -> refreshes silence timer!
  chunker.push(makeFrame(100, 0.001));
  chunker.push(makeFrame(100, 0.001));
  assert.equal(emitted.length, 0);
  for (let i = 0; i < 15; i++) {
    chunker.push(makeFrame(100, 0.12));
  }
  assert.equal(emitted.length, 0);

  // Now pause 0.3s (~22.2s total) -> cuts patch #1 cleanly!
  chunker.push(makeFrame(100, 0.001));
  chunker.push(makeFrame(100, 0.001));
  chunker.push(makeFrame(100, 0.001));
  assert.equal(emitted.length, 1);
  assert.ok(emitted[0].durationMs >= 22000);
  assert.equal(emitted[0].blob.type, 'audio/wav');
  const headerBytes = new Uint8Array(await emitted[0].blob.slice(0, 12).arrayBuffer());
  const riff = String.fromCharCode(...headerBytes.slice(0, 4));
  const wave = String.fromCharCode(...headerBytes.slice(8, 12));
  assert.equal(riff, 'RIFF');
  assert.equal(wave, 'WAVE');

  // Next shorter speech patch followed by manual flush() -> emits patch #2
  for (let i = 0; i < 6; i++) {
    chunker.push(makeFrame(100, 0.15));
  }
  chunker.flush();
  assert.equal(emitted.length, 2);

  // Flushing empty/silent tail emits nothing extra
  chunker.flush();
  assert.equal(emitted.length, 2);

  // Soft-spoken mic levels (e.g., amplitude 0.015 -> RMS ~0.01) still flush cleanly on stop
  for (let i = 0; i < 6; i++) {
    chunker.push(makeFrame(100, 0.015));
  }
  chunker.flush();
  assert.equal(emitted.length, 3);

  const wav = encodeMonoWav(makeFrame(50, 0.1), TARGET_SAMPLE_RATE);
  assert.equal(wav.size, 44 + 800 * 2);
});

test('inferFigureBoxLayout resolves left/right/center/full defaults from AI metadata or crop coordinates', () => {
  assert.deepEqual(inferFigureBoxLayout([100, 50, 450, 450], 'left', 38), {
    align: 'left',
    widthPct: 38,
  });
  // Left-margin crop without explicit AI align -> auto left wrap
  assert.deepEqual(inferFigureBoxLayout([100, 40, 450, 460]), {
    align: 'left',
    widthPct: 42,
  });
  // Right-margin crop without explicit AI align -> auto right wrap
  assert.deepEqual(inferFigureBoxLayout([100, 550, 450, 960]), {
    align: 'right',
    widthPct: 41,
  });
  // Full-width banner crop
  assert.deepEqual(inferFigureBoxLayout([100, 20, 450, 980]), {
    align: 'full',
    widthPct: 100,
  });
});

test('paper restructuring helpers adjust alignment, width, order, split, merge, and insert cleanly', () => {
  const blocks = [
    { id: 't1', type: 'text' as const, pageNumber: 1, content: 'Paragraph one.\n\nParagraph two.' },
    {
      id: 'f1',
      type: 'figure' as const,
      pageNumber: 1,
      figureId: 'fig_1',
      figureCode: 'IMG-1',
      caption: 'Curve',
      align: 'center' as const,
      widthPct: 80,
    },
  ];

  // Switching centered 80% figure to left/right snaps to wrap-friendly 42% width
  const leftAligned = updateFigureBlockLayout(blocks, 'f1', { align: 'left' });
  assert.equal(leftAligned[1].align, 'left');
  assert.equal(leftAligned[1].widthPct, 42);

  // Move figure above paragraph so prose wraps beside it
  const movedUp = moveTextbookBlock(leftAligned, 'f1', 'up');
  assert.deepEqual(movedUp.map((b) => b.id), ['f1', 't1']);

  // Drag reorder swaps back
  const reordered = reorderTextbookBlock(movedUp, 'f1', 't1');
  assert.deepEqual(reordered.map((b) => b.id), ['t1', 'f1']);

  // Split multi-paragraph text block & merge back
  const split = splitTextBlockAtOffset(reordered, 't1', undefined, 't2');
  assert.equal(split.length, 3);
  assert.equal(split[0].content, 'Paragraph one.');
  assert.equal(split[1].content, 'Paragraph two.');

  const merged = mergeTextBlockWithNext(split, 't1');
  assert.equal(merged.length, 2);
  assert.equal(merged[0].content, 'Paragraph one.\n\nParagraph two.');

  // Insert empty text block immediately after a figure
  const withInserted = insertTextBlockAdjacent(merged, 'f1', 'after', 't3', 'Side note');
  assert.deepEqual(withInserted.map((b) => b.id), ['t1', 'f1', 't3']);
  assert.equal(withInserted[2].content, 'Side note');
});

test('dedupeById removes duplicate IDs from concurrent optimistic and snapshot updates', () => {
  const result = dedupeById([
    { id: 'chat_a4d9c3d2-9e4', title: 'New session' },
    { id: 'chat_bio_bohr', title: 'Biology' },
    { id: 'chat_a4d9c3d2-9e4', title: 'New session' },
  ]);
  assert.deepEqual(result.map((c) => c.id), ['chat_a4d9c3d2-9e4', 'chat_bio_bohr']);
});

test('stripHighlightMarkup and sanitizeMemoryPackOutput clean leaked highlight tags while preserving math and C++', () => {
  const dirty =
    'Covered ==session memory==, @@CIP rule@@, ++right shift++, and `!!pitfall!!` plus C++ and g++ with $E = mc^2$.';
  assert.equal(
    stripHighlightMarkup(dirty),
    'Covered session memory, CIP rule, right shift, and pitfall plus C++ and g++ with $E = mc^2$.'
  );

  const sanitized = sanitizeMemoryPackOutput({
    summary: '**Subtopics Covered:** ==Bohr Effect== and !!exam traps pitfall!!.',
    bullets: [
      '- Covered ==Bohr Effect==',
      'Covered Bohr Effect',
      'Resolved `!!sign confusion!!`',
    ],
  });
  assert.equal(sanitized.summary, '**Subtopics Covered:** Bohr Effect and exam traps pitfall.');
  assert.deepEqual(sanitized.bullets, ['Covered Bohr Effect', 'Resolved sign confusion']);
});

test('mergeLearnerState preserves existing concepts, promotes improvements, and caps at 24', () => {
  const existing: ConceptState[] = [
    {
      id: 'c_keq',
      concept: 'Keq vs Q',
      status: 'misunderstood',
      note: 'Mixed up equilibrium constant with reaction quotient',
      updatedAt: 1000,
    },
    {
      id: 'c_hill',
      concept: 'Hill Coefficient',
      status: 'shaky',
      note: 'Needs practice interpreting nH slope',
      updatedAt: 900,
    },
  ];
  const incoming: ConceptState[] = [
    {
      id: 'cs_new_1',
      concept: '==Keq vs Q==',
      status: 'understood',
      note: 'Improved: correctly used Q < Keq to predict forward shift',
      updatedAt: 2000,
    },
    {
      id: 'cs_new_2',
      concept: 'Entropy Sign',
      status: 'unresolved',
      note: 'Open question on surroundings entropy sign',
      updatedAt: 2000,
    },
  ];

  const merged = mergeLearnerState(existing, incoming, 2000);
  assert.deepEqual(
    merged.map((c) => [c.id, c.concept, c.status]),
    [
      ['cs_new_2', 'Entropy Sign', 'unresolved'],
      ['c_hill', 'Hill Coefficient', 'shaky'],
      ['c_keq', 'Keq vs Q', 'understood'],
    ]
  );

  const assembled = assembleContextPrompt({
    memory: { ...createEmptyMemory(2000), learnerState: merged },
    messages: [{ id: 'm1', role: 'user', content: 'Continue', createdAt: 2000 }],
  });
  assert.ok(assembled.systemPrompt.includes('### Blindspots & Open Gaps'));
  assert.ok(assembled.systemPrompt.includes('### Understanding Improvements & Mastered'));
  assert.ok(assembled.systemPrompt.includes('Improved: correctly used Q < Keq'));
});



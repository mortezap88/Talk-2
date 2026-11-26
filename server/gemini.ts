import { GoogleGenAI, ThinkingLevel, Type, type Content, type Part } from '@google/genai';
import type {
  ChatAttachment,
  ChatMessage,
  ConceptState,
  GeminiModel,
  MemoryPack,
  ThinkingLevel as TalkThinkingLevel,
  TokenUsageSnapshot,
} from '../src/types/talk.ts';
import {
  getTargetSummaryTokens,
  sanitizeMemoryPackOutput,
  stripHighlightMarkup,
} from '../src/utils/memoryEngine.ts';

export const GEMINI_CHAT_MODEL: GeminiModel = 'gemini-4-hydrogen';
export const GEMINI_STT_MODEL = 'gemini-3.5-transcribe';

const SUPPORTED_RASTER_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export function getGeminiKey(): string {
  return (process.env.GEMINI_API_KEY || '').trim();
}

function createGeminiClient(): GoogleGenAI {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Check Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function toGeminiThinkingLevel(
  level: TalkThinkingLevel,
  model: GeminiModel = GEMINI_CHAT_MODEL
): ThinkingLevel {
  if (level === 'low') return ThinkingLevel.LOW;
  if (level === 'high') return ThinkingLevel.HIGH;
  if (level === 'xhigh') {
    return model === 'gemini-4-hydrogen' ? ThinkingLevel.XHIGH : ThinkingLevel.HIGH;
  }
  return ThinkingLevel.MEDIUM;
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), base64: match[2] };
}

function attachmentToParts(att: ChatAttachment): Part[] {
  if (att.kind === 'text' && att.textContent) {
    return [{ text: `[Attached file: ${att.name}]\n${att.textContent}` }];
  }
  if (att.kind === 'image' && att.dataUrl) {
    const parsed = parseDataUrl(att.dataUrl);
    if (!parsed) return [];
    if (SUPPORTED_RASTER_MIMES.has(parsed.mimeType)) {
      const mime = parsed.mimeType === 'image/jpg' ? 'image/jpeg' : parsed.mimeType;
      return [{ inlineData: { mimeType: mime, data: parsed.base64 } }];
    }
    if (parsed.mimeType === 'image/svg+xml') {
      try {
        const svgText = Buffer.from(parsed.base64, 'base64').toString('utf8');
        return [{ text: `[Attached SVG diagram: ${att.name}]\n${svgText.slice(0, 4000)}` }];
      } catch {
        return [{ text: `[Attached diagram: ${att.name}]` }];
      }
    }
  }
  return [];
}

function buildGeminiContents(
  messages: ChatMessage[],
  textbookImages: ChatAttachment[]
): Content[] {
  let latestUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      latestUserIdx = i;
      break;
    }
  }

  const contents: Content[] = [];
  messages.forEach((msg, idx) => {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: Part[] = [];
    let textBody = msg.content || '';

    const extraTextbook =
      idx === latestUserIdx && Array.isArray(textbookImages)
        ? textbookImages.filter((a) => a.dataUrl)
        : [];

    if (role === 'user' && extraTextbook.length > 0) {
      textBody = `${textBody}\n\n[Authoritative Textbook Pages attached below — treat these images as authoritative textbook reference material.]`.trim();
    }

    if (textBody) {
      parts.push({ text: textBody });
    }

    if (Array.isArray(msg.attachments)) {
      for (const att of msg.attachments) {
        parts.push(...attachmentToParts(att));
      }
    }

    if (role === 'user') {
      extraTextbook.forEach((tbImg, tbIdx) => {
        const imgParts = attachmentToParts(tbImg);
        if (imgParts.length === 0) return;
        const code = tbImg.textbookCode || `IMG-${tbIdx + 1}`;
        const pageNote = tbImg.pageNumber ? ` (Page ${tbImg.pageNumber})` : '';
        const capNote = tbImg.caption ? `: ${tbImg.caption}` : '';
        parts.push({ text: `[Textbook Image ${code}${pageNote}${capNote}]` });
        parts.push(...imgParts);
      });
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  });

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  return contents;
}

export function formatGeminiError(err: unknown): string {
  let msg = (err as Error)?.message || String(err);
  // Unwrap nested JSON error envelopes returned by @google/genai
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(msg);
      if (parsed?.error?.message) {
        msg = String(parsed.error.message);
        continue;
      }
      if (parsed?.message) {
        msg = String(parsed.message);
        continue;
      }
    } catch {
      break;
    }
  }
  if (/API_KEY_INVALID|PERMISSION_DENIED|403|401/i.test(msg)) {
    return 'Gemini API key error. Please verify GEMINI_API_KEY in Settings > Secrets.';
  }
  if (/RESOURCE_EXHAUSTED|429/i.test(msg)) {
    return 'Gemini rate limit reached (429). Please wait a moment and try again.';
  }
  if (/UNAVAILABLE|503|high demand/i.test(msg)) {
    return 'Gemini is temporarily experiencing high demand (503). Please try again in a few seconds.';
  }
  return msg || 'Gemini API request failed.';
}

function isTransientError(err: unknown): boolean {
  const msg = (err as Error)?.message || String(err);
  return /503|UNAVAILABLE|high demand|ECONNRESET|ETIMEDOUT/i.test(msg);
}

async function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function streamGeminiChat(params: {
  model?: GeminiModel;
  messages: ChatMessage[];
  systemPrompt: string;
  thinkingLevel: TalkThinkingLevel;
  textbookImages: ChatAttachment[];
  signal: AbortSignal;
  onChunk: (delta: string) => void;
}): Promise<{ fullText: string; usage?: TokenUsageSnapshot }> {
  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;
  const contents = buildGeminiContents(params.messages, params.textbookImages);

  const delays = [600, 1400];
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    let fullText = '';
    let latestUsage: TokenUsageSnapshot | undefined;
    try {
      const streamResponse = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: params.systemPrompt || undefined,
          thinkingConfig: {
            thinkingLevel: toGeminiThinkingLevel(params.thinkingLevel, model),
          },
          abortSignal: params.signal,
        },
      });

      for await (const chunk of streamResponse) {
        if (params.signal.aborted) break;
        const meta = chunk.usageMetadata;
        if (meta) {
          latestUsage = {
            promptTokens: meta.promptTokenCount ?? 0,
            outputTokens: meta.candidatesTokenCount ?? 0,
            thinkingTokens: meta.thoughtsTokenCount ?? 0,
            totalTokens: meta.totalTokenCount ?? 0,
          };
        }
        const text = chunk.text;
        if (typeof text === 'string' && text.length > 0) {
          fullText += text;
          params.onChunk(text);
        }
      }
      return { fullText, usage: latestUsage };
    } catch (err) {
      lastError = err;
      if (params.signal.aborted || (err as Error).name === 'AbortError') {
        throw err;
      }
      if (fullText.length === 0 && attempt < delays.length && isTransientError(err)) {
        await waitWithAbort(delays[attempt], params.signal);
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

export async function countGeminiTokens(params: {
  model?: GeminiModel;
  messages: ChatMessage[];
  systemPrompt: string;
  textbookImages: ChatAttachment[];
}): Promise<number> {
  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;

  let msgContents: Content[] = [];
  if (params.messages.length > 0) {
    msgContents = buildGeminiContents(params.messages, params.textbookImages);
  } else if (params.textbookImages.length > 0) {
    msgContents = buildGeminiContents(
      [{ id: '__next_user__', role: 'user', content: '', createdAt: 0 }],
      params.textbookImages
    );
  }

  // Gemini Developer API countTokens rejects config.systemInstruction,
  // so prepend systemPrompt as a Content item for exact full-context token counting.
  const contents: Content[] = params.systemPrompt.trim()
    ? [{ role: 'user', parts: [{ text: params.systemPrompt }] }, ...msgContents]
    : msgContents;

  if (contents.length === 0) {
    return 0;
  }

  const response = await ai.models.countTokens({
    model,
    contents,
  });

  return response.totalTokens ?? 0;
}

export async function summarizeWithGemini(params: {
  model?: GeminiModel;
  stage?: 1 | 2 | 3;
  inputTokens: number;
  messages?: ChatMessage[];
  packs?: MemoryPack[];
}): Promise<{ summary: string; bullets: string[] }> {
  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;
  const maxTargetTokens = getTargetSummaryTokens(params.inputTokens);

  const sourceText =
    Array.isArray(params.packs) && params.packs.length > 0
      ? params.packs
          .map(
            (p, idx) =>
              `Pack ${idx + 1}:\n${p.summary}\nBullets:\n${p.bullets.join('\n')}`
          )
          .join('\n\n')
      : (params.messages || [])
          .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
          .join('\n\n');

  const response = await ai.models.generateContent({
    model,
    contents: sourceText,
    config: {
      systemInstruction: `You are a high-signal study-memory compactor for Talk. Compress this conversation segment into a crisp, durable study memory pack that helps the tutor remember what was learned, decided, still shaky, and improved.

Rules:
1. Substance-proportional length: Use at most ~${maxTargetTokens} tokens as an upper ceiling for dense technical content—never pad to hit a length target. Strip greetings, connection tests ("can you hear me?"), and app/UI troubleshooting chatter. If the segment contains mostly small talk or UI talk, compress it into 1–3 brief sentences.
2. Required structure inside "summary" (use concise **Section:** headings, omitting any section that genuinely has nothing substantive):
   - **Discussed & Subtopics Covered:** Specific topics, problems, mechanisms, or questions covered (preserve exact formulas/LaTeX like $...$ and key nuances concisely).
   - **Conclusions:** Verified answers, rules, derivations, or study decisions reached.
   - **Blindspots:** Student misconceptions, shaky assumptions, confusing steps, or open unresolved questions.
   - **Understanding Improvements:** Concepts the student clarified, errors they corrected, or breakthroughs demonstrated.
   - If any [[IMG-N]] textbook figure markers were shown, add a brief line: Shown: [[IMG-1]], etc.
3. Formatting & cleanliness:
   - Write clean plain prose and standard Markdown bold/LaTeX ($...$) only.
   - NEVER use Talk inline highlight delimiters (==...==, @@...@@, !!...!!, ++...++, whether raw or in backticks) anywhere in "summary" or "bullets".
4. "bullets": Provide 2–5 short, distinct scannable takeaways (max 1 line each) covering key subtopics, conclusions, blindspots, or improvements. Do not duplicate lines verbatim from "summary". (Use 1 short bullet if the segment had minimal study content.)`,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          bullets: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['summary', 'bullets'],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim());
  return sanitizeMemoryPackOutput({
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    bullets: Array.isArray(parsed.bullets)
      ? parsed.bullets.map((b: unknown) => String(b))
      : [],
  });
}

export async function updateLearnerStateWithGemini(params: {
  model?: GeminiModel;
  currentState: ConceptState[];
  messages: ChatMessage[];
}): Promise<ConceptState[]> {
  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;
  const dialogue = params.messages
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');

  const response = await ai.models.generateContent({
    model,
    contents: `Current state:\n${JSON.stringify(params.currentState)}\n\nNew dialogue:\n${dialogue}`,
    config: {
      systemInstruction: `Maintain the student's Living Learner State (max 24 concepts). Statuses allowed: "misunderstood", "unresolved", "shaky", "understood".

Rules:
1. Track Blindspots ("misunderstood", "unresolved", "shaky") with a 1-line diagnosis of what is confused, incomplete, or still open.
2. Track Understanding Improvements ("understood"): add mastered concepts and promote prior blindspots when the new dialogue shows the student corrected a mistake or reasoned accurately—prefixing the note with "Improved:" when an earlier gap was resolved (e.g., "Improved: correctly distinguished Keq from reaction quotient Q").
3. Carry forward existing unaffected concepts from Current state so prior progress and open blindspots are never lost.
4. Ignore casual greetings, connection checks, and app/UI troubleshooting—never create concepts for UI issues or meta chat.
5. Never use inline highlight delimiters (==, @@, !!, ++) in concept names or notes. Each note must be 1 concise, informative line.`,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          concepts: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                concept: { type: Type.STRING },
                status: { type: Type.STRING },
                note: { type: Type.STRING },
              },
              required: ['concept', 'status', 'note'],
            },
          },
        },
        required: ['concepts'],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim());
  const list = Array.isArray(parsed?.concepts) ? parsed.concepts : [];
  const now = Date.now();
  return list
    .filter((item: Record<string, unknown>) => typeof item?.concept === 'string')
    .slice(0, 24)
    .map((item: Record<string, unknown>, idx: number) => ({
      id: `cs_${now}_${idx}`,
      concept: stripHighlightMarkup(String(item.concept)).trim(),
      status: ['misunderstood', 'unresolved', 'shaky', 'understood'].includes(String(item.status))
        ? (item.status as ConceptState['status'])
        : 'unresolved',
      note: stripHighlightMarkup(String(item.note || '')).trim(),
      updatedAt: now,
    }))
    .filter((item: ConceptState) => item.concept.length > 0);
}

export async function transcribeWithGemini(
  audioBuffer: Buffer,
  mimeType: string
): Promise<string> {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Check Settings > Secrets.');
  }
  const rawMime = (mimeType || 'audio/webm').split(';')[0].trim().toLowerCase();
  const normalizedMime = rawMime.startsWith('audio/') ? rawMime : 'audio/webm';
  const base64Audio = audioBuffer.toString('base64');

  const requestBody = {
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: normalizedMime,
            data: base64Audio,
          },
        },
        {
          text: 'Transcribe the spoken words in this audio accurately. Return only the spoken transcript text, or an empty string if there is no speech.',
        },
      ],
    },
  };

  // Try gemini-3.5-transcribe on v1beta first, then fall back to gemini-4-hydrogen on default client
  const attempts: Array<{ model: string; apiVersion?: string }> = [
    { model: GEMINI_STT_MODEL, apiVersion: 'v1beta' },
    { model: GEMINI_CHAT_MODEL },
  ];

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const client = new GoogleGenAI({
        apiKey,
        ...(attempt.apiVersion ? { apiVersion: attempt.apiVersion } : {}),
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
      const response = await client.models.generateContent({
        model: attempt.model,
        ...requestBody,
      });
      return (response.text ?? '').trim();
    } catch (err) {
      lastError = err;
      const msg = (err as Error)?.message || String(err);
      if (/not found|NOT_FOUND|404|is not supported for generateContent/i.test(msg)) {
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

export interface AnalyzedTextbookBlock {
  type: 'text' | 'figure';
  content?: string;
  caption?: string;
  box_2d?: [number, number, number, number];
  align?: 'left' | 'center' | 'right' | 'full';
  widthPct?: number;
}

export interface AnalyzedTextbookPageResult {
  pageKind: 'text_only' | 'visual_only' | 'mixed';
  blocks: AnalyzedTextbookBlock[];
}

export async function analyzeTextbookPageWithGemini(params: {
  model?: GeminiModel;
  imageDataUrl: string;
  mimeType?: string;
  pageNumber: number;
}): Promise<AnalyzedTextbookPageResult> {
  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;
  const parsedUrl = parseDataUrl(params.imageDataUrl);
  if (!parsedUrl) {
    throw new Error('Invalid image data URL for textbook page analysis.');
  }
  const rawMime = (params.mimeType || parsedUrl.mimeType || 'image/jpeg').toLowerCase();
  const mimeType = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
  if (!SUPPORTED_RASTER_MIMES.has(mimeType)) {
    throw new Error(`Unsupported textbook page image type: ${mimeType}`);
  }

  const delays = [800, 1800];
  let lastError: unknown;
  let parsed: Record<string, unknown> | null = null;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: parsedUrl.base64,
              },
            },
            {
              text: `Analyze this uploaded image (sequence #${params.pageNumber}). Determine whether it is text-only, a standalone visual image/photo/diagram without body prose, or a mixed textbook page with both text and figures. Extract any text verbatim (Markdown/LaTeX), isolate/crop figures with 2D bounding boxes, capture each figure's spatial placement ("align": "left" | "center" | "right" | "full" and "widthPct": 25..100), and give every figure or standalone image a concise, descriptive study name in "caption".`,
            },
          ],
        },
        config: {
          systemInstruction: `You are a precision textbook digitizer and visual study analyzer. Convert any uploaded image—whether a textbook page, a mixed page with diagrams, or a standalone supplemental photo/illustration—into ordered blocks ("text" and "figure") that preserve both exact text and visual page layout.

CRITICAL RULES:
1. NEVER CHANGE WORDS OR PHRASING (when body text is present):
   - Transcribe every word, sentence, number, heading, list item, footnote, and table cell 100% VERBATIM in its original language (English, Persian/Farsi, or mixed).
   - Do NOT paraphrase, summarize, simplify, translate, or alter the author's wording in any way.
2. CLEAN WEBSITE-STYLE FORMATTING ONLY:
   - Rejoin broken end-of-line word wraps / hyphenations into smooth continuous prose.
   - Format structure cleanly using Markdown headings (##, ###), bullet or numbered lists, Markdown comparison tables (| Col 1 | Col 2 |), **bold** / *italic* matching emphasis, and LaTeX ($...$ inline, $$...$$ block) for equations and chemical formulas.
   - Omit running page numbers or repetitive book header/footer chrome if present.
3. STRICT SEPARATION OF TEXT VS. VISUAL FIGURES, SPATIAL LAYOUT & DESCRIPTIVE NAMING:
   - Whenever there is a diagram, chart, graph, illustration, molecular/chemical structure, reaction scheme, or photo, emit a "figure" block with:
     - "type": "figure"
     - "box_2d": [ymin, xmin, ymax, xmax] in normalized 0..1000 coordinates tightly enclosing the visual figure and any internal labels/axes (use [0, 0, 1000, 1000] if the entire image is the visual subject).
     - "align": "left" | "center" | "right" | "full" describing how the figure sits on the page:
       - "left": the figure occupies the left side/margin alongside adjacent body text (emit this "figure" block IMMEDIATELY BEFORE the adjacent "text" block so text wraps beside it on the right).
       - "right": the figure occupies the right side/margin alongside adjacent body text (emit this "figure" block IMMEDIATELY BEFORE the adjacent "text" block so text wraps beside it on the left).
       - "center": a compact or standalone figure centered on its own row between paragraphs.
       - "full": a wide banner/diagram spanning nearly the full page or column width.
     - "widthPct": integer (25..100) estimating the figure's percentage width relative to the text column (typically 30..50 for "left"/"right" side-by-side figures, 45..75 for "center", 100 for "full").
     - "caption": if a printed caption/figure title is visible, preserve it verbatim; otherwise, analyze the image and write a concise, accurate, descriptive study title/name (e.g., "Human Heart Cross-Section", "Oxygen-Hemoglobin Dissociation Curve", "Mitosis Metaphase Diagram") instead of generic "Figure".
   - NEVER describe a figure's visual appearance in prose, and NEVER put labels that sit inside a diagram into a "text" block if they belong inside the cropped figure box.
4. CLASSIFICATION ("pageKind"):
   - "text_only": only readable text/equations/tables; emit ONLY "text" blocks (no "figure" blocks).
   - "visual_only": a standalone image, photo, diagram, or illustration with no surrounding textbook body prose (even if it contains short internal diagram labels); emit ONLY "figure" block(s) with descriptive "caption" name(s), and NO "text" blocks.
   - "mixed": both textbook body prose and one or more visual figures; emit "text" and "figure" blocks in natural layout order (placing side-by-side "left"/"right" figures immediately before the "text" block that sits beside them).`,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              pageKind: {
                type: Type.STRING,
              },
              blocks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    type: { type: Type.STRING },
                    content: { type: Type.STRING },
                    caption: { type: Type.STRING },
                    align: { type: Type.STRING },
                    widthPct: { type: Type.INTEGER },
                    box_2d: {
                      type: Type.ARRAY,
                      items: { type: Type.INTEGER },
                    },
                  },
                  required: ['type'],
                },
              },
            },
            required: ['pageKind', 'blocks'],
          },
        },
      });

      const rawText = (response.text ?? '{}').trim();
      const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const jsonCandidate = fenced?.[1] ? fenced[1].trim() : rawText;
      parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < delays.length && (isTransientError(err) || err instanceof SyntaxError)) {
        await waitWithAbort(delays[attempt]);
        continue;
      }
      throw err;
    }
  }

  if (!parsed) {
    throw lastError instanceof Error ? lastError : new Error('Failed to parse textbook page analysis.');
  }

  const rawKind = String(parsed?.pageKind || 'mixed');
  const pageKind: AnalyzedTextbookPageResult['pageKind'] =
    rawKind === 'text_only' || rawKind === 'visual_only' ? rawKind : 'mixed';

  const rawBlocks: Array<Record<string, unknown>> = Array.isArray(parsed?.blocks)
    ? (parsed.blocks as Array<Record<string, unknown>>)
    : [];
  const blocks: AnalyzedTextbookBlock[] = rawBlocks
    .map((b): AnalyzedTextbookBlock | null => {
      const t = b?.type === 'figure' ? 'figure' : b?.type === 'text' ? 'text' : null;
      if (!t) return null;
      if (t === 'text') {
        const content = typeof b.content === 'string' ? b.content.trim() : '';
        if (!content) return null;
        return { type: 'text', content };
      }
      const box = Array.isArray(b.box_2d) && b.box_2d.length === 4
        ? ([
            Number(b.box_2d[0]) || 0,
            Number(b.box_2d[1]) || 0,
            Number(b.box_2d[2]) || 1000,
            Number(b.box_2d[3]) || 1000,
          ] as [number, number, number, number])
        : undefined;
      const rawAlign = typeof b.align === 'string' ? b.align.trim().toLowerCase() : '';
      const align =
        rawAlign === 'left' || rawAlign === 'center' || rawAlign === 'right' || rawAlign === 'full'
          ? (rawAlign as 'left' | 'center' | 'right' | 'full')
          : undefined;
      const widthPct =
        typeof b.widthPct === 'number' && Number.isFinite(b.widthPct)
          ? Math.min(100, Math.max(24, Math.round(b.widthPct)))
          : undefined;
      return {
        type: 'figure',
        caption: typeof b.caption === 'string' ? b.caption.trim() : '',
        ...(box ? { box_2d: box } : {}),
        ...(align ? { align } : {}),
        ...(widthPct !== undefined ? { widthPct } : {}),
      };
    })
    .filter((item: AnalyzedTextbookBlock | null): item is AnalyzedTextbookBlock => item !== null);

  return { pageKind, blocks };
}

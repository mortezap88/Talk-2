export interface ParsedQaSuggestion {
  question: string;
  answer: string;
}

export type ChatIntent =
  | { type: 'add_last_question' }
  | { type: 'delete_question'; index: number }
  | { type: 'change_question'; index: number; newQuestion: string };

export interface MessageSegment {
  type: 'text' | 'code';
  content: string;
  language?: string;
}

const PERSIAN_DIGITS: Record<string, string> = {
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
};

export function normalizeDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (ch) => PERSIAN_DIGITS[ch] ?? ch);
}

/**
 * Parses numbered questions with `Answer:` (English) or `پاسخ:` / `جواب:` (Persian) lines
 * from an assistant message while keeping the original reply intact.
 */
export function parseQaSuggestions(text: string): ParsedQaSuggestion[] {
  if (!text || !text.trim()) return [];

  const lines = text.split(/\r?\n/);
  const results: ParsedQaSuggestion[] = [];

  const questionHeaderRe =
    /^\s*(?:\*{0,2})?(?:[Qq](?:uestion)?\s*)?([0-9۰-۹٠-٩]+)[.)\]:\-]\s*(.+?)\s*$/;
  const answerPrefixRe =
    /^\s*(?:[-*•]\s*)?(?:\*{0,2})?(?:Answer|Ans|پاسخ|جواب)\s*[:：]\s*(?:\*{0,2})?(.*)$/i;

  let currentQuestion: string | null = null;
  let currentAnswerLines: string[] = [];
  let collectingAnswer = false;

  const flush = () => {
    if (currentQuestion && collectingAnswer) {
      const answer = currentAnswerLines.join('\n').trim();
      let question = currentQuestion.trim();
      if (question.startsWith('**') && question.endsWith('**') && question.length > 4) {
        question = question.slice(2, -2).trim();
      }
      if (question && answer) {
        results.push({ question, answer });
      }
    }
    currentQuestion = null;
    currentAnswerLines = [];
    collectingAnswer = false;
  };

  for (const line of lines) {
    const answerMatch = line.match(answerPrefixRe);
    if (answerMatch && currentQuestion !== null) {
      collectingAnswer = true;
      if (answerMatch[1]?.trim()) {
        currentAnswerLines.push(answerMatch[1].trim());
      }
      continue;
    }

    const headerMatch = line.match(questionHeaderRe);
    if (headerMatch) {
      // Check if inline answer exists on the same line (e.g., "1. What is X? Answer: Y")
      const body = headerMatch[2];
      const inlineSplit = body.match(/^(.*?)\s+(?:Answer|Ans|پاسخ|جواب)\s*[:：]\s*(.+)$/i);
      flush();
      if (inlineSplit) {
        currentQuestion = inlineSplit[1].trim();
        collectingAnswer = true;
        currentAnswerLines = [inlineSplit[2].trim()];
      } else {
        currentQuestion = body.trim();
        collectingAnswer = false;
        currentAnswerLines = [];
      }
      continue;
    }

    if (currentQuestion !== null) {
      if (collectingAnswer) {
        // Stop collecting answer on markdown horizontal rules or obvious section breaks
        if (/^\s*---+\s*$/.test(line)) {
          flush();
        } else {
          currentAnswerLines.push(line);
        }
      } else if (line.trim()) {
        // Multi-line question before Answer:
        currentQuestion = `${currentQuestion} ${line.trim()}`.trim();
      }
    }
  }

  flush();
  return results;
}

/**
 * Parses direct chat intents that edit the Questions list locally without an AI call.
 */
export function parseChatIntent(rawInput: string): ChatIntent | null {
  const input = normalizeDigits(rawInput).trim();
  if (!input) return null;

  if (/^(?:please\s+)?(?:add|save)\s+this\s+question[.!?]*$/i.test(input)) {
    return { type: 'add_last_question' };
  }

  const delMatch = input.match(
    /^(?:please\s+)?(?:delete|remove)\s+question\s+#?(\d+)[.!?]*$/i
  );
  if (delMatch) {
    const index = Number.parseInt(delMatch[1], 10);
    if (Number.isFinite(index) && index >= 1) {
      return { type: 'delete_question', index };
    }
  }

  const changeMatch = input.match(
    /^(?:please\s+)?(?:change|update|edit)\s+question\s+#?(\d+)\s+to\s+(.+)$/is
  );
  if (changeMatch) {
    const index = Number.parseInt(changeMatch[1], 10);
    const newQuestion = changeMatch[2].trim();
    if (Number.isFinite(index) && index >= 1 && newQuestion) {
      return { type: 'change_question', index, newQuestion };
    }
  }

  return null;
}

/**
 * Splits a message into plain text and fenced code blocks for safe React rendering.
 */
export function parseMessageSegments(content: string): MessageSegment[] {
  if (!content) return [];
  const segments: MessageSegment[] = [];
  const fenceRe = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        content: content.slice(lastIndex, match.index),
      });
    }
    segments.push({
      type: 'code',
      language: match[1]?.trim() || undefined,
      content: match[2].replace(/\n$/, ''),
    });
    lastIndex = fenceRe.lastIndex;
  }

  if (lastIndex < content.length) {
    segments.push({
      type: 'text',
      content: content.slice(lastIndex),
    });
  }

  return segments;
}

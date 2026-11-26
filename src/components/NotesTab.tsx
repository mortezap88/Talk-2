import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { NoteData, RightPanelMode } from '../types/talk';
import { RichMessage } from './RichMessage';

interface NotesTabProps {
  chatId: string;
  note: NoteData;
  mode?: RightPanelMode;
  onSaveNote: (chatId: string, nextNote: NoteData) => Promise<void>;
}

export function NotesTab({ chatId, note, mode = 'edit', onSaveNote }: NotesTabProps) {
  const [body, setBody] = useState(note.body);
  const [saveFailed, setSaveFailed] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBodyRef = useRef<string | null>(null);
  const activeChatRef = useRef(chatId);
  const onSaveNoteRef = useRef(onSaveNote);
  onSaveNoteRef.current = onSaveNote;

  useEffect(() => {
    activeChatRef.current = chatId;
    setBody(note.body);
    setSaveFailed(false);
    pendingBodyRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [chatId, note.body]);

  const scheduleSave = (nextBody: string) => {
    setSaveFailed(false);
    pendingBodyRef.current = nextBody;
    if (timerRef.current) clearTimeout(timerRef.current);
    const targetChatId = chatId;
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      const bodyToSave = pendingBodyRef.current ?? nextBody;
      pendingBodyRef.current = null;
      try {
        await onSaveNoteRef.current(targetChatId, {
          title: '',
          body: bodyToSave,
          tags: [],
          updatedAt: Date.now(),
        });
        if (activeChatRef.current === targetChatId) {
          setSaveFailed(false);
        }
      } catch {
        if (activeChatRef.current === targetChatId) {
          setSaveFailed(true);
        }
      }
    }, 600);
  };

  useEffect(() => {
    const mountedChatId = chatId;
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (pendingBodyRef.current !== null) {
        const bodyToSave = pendingBodyRef.current;
        pendingBodyRef.current = null;
        void onSaveNoteRef
          .current(mountedChatId, {
            title: '',
            body: bodyToSave,
            tags: [],
            updatedAt: Date.now(),
          })
          .catch(() => {});
      }
    };
  }, [chatId]);

  if (mode === 'read') {
    return (
      <div className="doc-scroll flex-1 min-h-0 overflow-y-auto bg-white dark:bg-slate-900 px-5 sm:px-7 pt-14 pb-8">
        <div className="w-full space-y-4">
          {saveFailed ? (
            <div
              role="alert"
              className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 flex items-center gap-2 text-xs text-red-700 dark:text-red-300"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>Save failed</span>
            </div>
          ) : null}

          {body.trim() ? (
            <div className="text-slate-900 dark:text-slate-100">
              <RichMessage content={body} variant="assistant" />
            </div>
          ) : (
            <p className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">
              No notes yet. Switch to Edit mode to write notes for this chat.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="doc-scroll flex-1 min-h-0 overflow-y-auto bg-slate-50 dark:bg-slate-950 px-4 sm:px-5 pt-14 pb-5">
      <div className="max-w-4xl mx-auto space-y-4">
        {saveFailed ? (
          <div
            role="alert"
            className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 flex items-center gap-2 text-xs text-red-700 dark:text-red-300"
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>Save failed</span>
          </div>
        ) : null}

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <textarea
            id="note-body"
            aria-label="Conversation notes"
            dir="auto"
            rows={18}
            value={body}
            onChange={(e) => {
              const v = e.target.value;
              setBody(v);
              scheduleSave(v);
            }}
            placeholder="Write key formulas, important takeaways, or reminders for this chat…"
            className="bidi-plaintext w-full px-3.5 py-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 text-sm text-slate-900 dark:text-slate-100 leading-relaxed focus:outline-none focus:border-sky-500 resize-y"
          />
        </div>
      </div>
    </div>
  );
}

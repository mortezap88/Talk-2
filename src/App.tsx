import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { talkApi } from './api/talkClient';
import { ChatManagerDrawer } from './components/ChatManagerDrawer';
import { ChatTab } from './components/ChatTab';
import { MemoryPanel } from './components/MemoryPanel';
import { NotesTab } from './components/NotesTab';
import { QuestionsTab } from './components/QuestionsTab';
import { RightPanelSwitcher } from './components/RightPanelSwitcher';
import { SettingsModal } from './components/SettingsModal';
import { TextbookTab } from './components/TextbookTab';
import { WorkspaceRail } from './components/WorkspaceRail';
import type {
  AppSettings,
  ChatAttachment,
  ChatItem,
  ChatMemory,
  ChatMessage,
  FlashcardItem,
  GeminiModel,
  MemoryPack,
  ModeTab,
  NoteData,
  RightPanelMode,
  StoredQuestion,
  TextbookData,
  ThemeMode,
  ThinkingLevel,
} from './types/talk';
import { createId, normalizeThinkingLevelForModel } from './utils/formatters';
import { processSelectedFiles } from './utils/fileAttachments';
import {
  analyzeActiveWindow,
  assembleContextPrompt,
  COMPACTION_TRIGGER_TOKENS,
  createEmptyMemory,
  estimateMessageTokens,
  estimateTokens,
  insertRollingPack,
  needsCompaction,
  PACK_SLOTS,
  selectCompactionChunk,
} from './utils/memoryEngine';
import { parseChatIntent, parseQaSuggestions, type ParsedQaSuggestion } from './utils/qaParser';

const EMPTY_NOTE: NoteData = { title: '', body: '', tags: [], updatedAt: 0 };
const EMPTY_TEXTBOOK: TextbookData = { title: '', body: '', images: [], updatedAt: 0 };

function applyThemeClass(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'dark') {
    root.classList.add('dark');
  } else if (mode === 'light') {
    root.classList.remove('dark');
  } else {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', Boolean(prefersDark));
  }
}

export default function App() {
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ModeTab>('textbook');
  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode>('edit');
  const [leftPanePct, setLeftPanePct] = useState<number>(50);
  const [mobilePane, setMobilePane] = useState<'chat' | 'panel'>('chat');
  const splitContainerRef = useRef<HTMLDivElement | null>(null);

  const [notesByChat, setNotesByChat] = useState<Record<string, NoteData>>({});
  const [questionsByChat, setQuestionsByChat] = useState<Record<string, StoredQuestion[]>>({});
  const [memoryByChat, setMemoryByChat] = useState<Record<string, ChatMemory>>({});
  const [cardsByChat, setCardsByChat] = useState<Record<string, FlashcardItem[]>>({});
  const [textbooksByChat, setTextbooksByChat] = useState<Record<string, TextbookData>>({});

  const [settings, setSettings] = useState<AppSettings>({
    provider: 'gemini',
    geminiModel: 'gemini-4-hydrogen',
    thinkingLevel: 'medium',
    themeMode: 'system',
    chatModel: 'gemini-4-hydrogen',
    sttModel: 'gemini-3.5-transcribe',
  });

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isDrawerPinned, setIsDrawerPinned] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [isSearchingWeb, setIsSearchingWeb] = useState(false);

  const [draftByChat, setDraftByChat] = useState<Record<string, string>>({});
  const [attachmentsByChat, setAttachmentsByChat] = useState<Record<string, ChatAttachment[]>>({});
  const [webSearchArmed, setWebSearchArmed] = useState(false);

  // Streaming state keyed by requestId
  const [streamingState, setStreamingState] = useState<{
    requestId: string;
    chatId: string;
    text: string;
  } | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);

  const [compactingChatId, setCompactingChatId] = useState<string | null>(null);
  const memoryRef = useRef(memoryByChat);
  memoryRef.current = memoryByChat;

  // Apply theme mode & listen to OS preference when 'system'
  useEffect(() => {
    applyThemeClass(settings.themeMode);
    if (settings.themeMode !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyThemeClass('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [settings.themeMode]);

  const loadChatContextData = useCallback(async (chatId: string) => {
    const [note, questions, memory, cards, loadedTextbook] = await Promise.all([
      talkApi.kvGet<NoteData>(`note:${chatId}`),
      talkApi.kvGet<StoredQuestion[]>(`questions:${chatId}`),
      talkApi.kvGet<ChatMemory>(`memory:${chatId}`),
      talkApi.listCards(chatId),
      talkApi.kvGet<TextbookData>(`textbook:${chatId}`),
    ]);

    setNotesByChat((prev) => ({ ...prev, [chatId]: note ?? { ...EMPTY_NOTE, updatedAt: Date.now() } }));
    setQuestionsByChat((prev) => ({ ...prev, [chatId]: Array.isArray(questions) ? questions : [] }));
    setMemoryByChat((prev) => ({
      ...prev,
      [chatId]: memory && memory.version === 2 ? memory : createEmptyMemory(),
    }));
    setCardsByChat((prev) => ({ ...prev, [chatId]: cards }));
    setTextbooksByChat((prev) => ({
      ...prev,
      [chatId]: loadedTextbook ?? { ...EMPTY_TEXTBOOK },
    }));
  }, []);

  const reloadWorkspaceFromStore = useCallback(async () => {
    const [loadedChats, loadedSettings] = await Promise.all([
      talkApi.listChats(),
      talkApi.getSettings(),
    ]);
    setSettings(loadedSettings);
    setNotesByChat({});
    setQuestionsByChat({});
    setMemoryByChat({});
    setCardsByChat({});
    setTextbooksByChat({});
    setDraftByChat({});
    setAttachmentsByChat({});
    if (loadedChats.length > 0) {
      setChats(loadedChats);
      setActiveChatId(loadedChats[0].id);
      await loadChatContextData(loadedChats[0].id);
    } else {
      const fresh = await talkApi.createChat('New study chat');
      setChats([fresh]);
      setActiveChatId(fresh.id);
      await loadChatContextData(fresh.id);
    }
  }, [loadChatContextData]);

  // Initial load
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [loadedChats, loadedSettings] = await Promise.all([
          talkApi.listChats(),
          talkApi.getSettings(),
        ]);
        if (!mounted) return;
        setSettings(loadedSettings);
        if (loadedChats.length > 0) {
          setChats(loadedChats);
          setActiveChatId(loadedChats[0].id);
          await loadChatContextData(loadedChats[0].id);
        } else {
          const fresh = await talkApi.createChat('New study chat');
          if (!mounted) return;
          setChats([fresh]);
          setActiveChatId(fresh.id);
          await loadChatContextData(fresh.id);
        }
      } catch (err) {
        if (mounted) {
          setErrorBanner((err as Error).message || 'Failed to load workspace from local storage.');
        }
      } finally {
        if (mounted) setIsLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [loadChatContextData]);

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const activeNote = (activeChatId && notesByChat[activeChatId]) || EMPTY_NOTE;
  const activeQuestions = (activeChatId && questionsByChat[activeChatId]) || [];
  const activeMemory = (activeChatId && memoryByChat[activeChatId]) || createEmptyMemory();
  const activeCards = (activeChatId && cardsByChat[activeChatId]) || [];
  const activeTextbook = (activeChatId && textbooksByChat[activeChatId]) || EMPTY_TEXTBOOK;
  const chatInput = (activeChatId && draftByChat[activeChatId]) || '';
  const pendingAttachments = (activeChatId && attachmentsByChat[activeChatId]) || [];

  const handleSelectChat = async (chatId: string) => {
    setActiveChatId(chatId);
    setErrorBanner(null);
    if (!isDrawerPinned) {
      setIsDrawerOpen(false);
    }
    if (
      !notesByChat[chatId] ||
      !memoryByChat[chatId] ||
      !questionsByChat[chatId] ||
      !textbooksByChat[chatId]
    ) {
      await loadChatContextData(chatId);
    }
  };

  const handleCreateChat = async () => {
    try {
      const created = await talkApi.createChat(`Study Session ${chats.length + 1}`);
      setChats((prev) => [created, ...prev]);
      setActiveChatId(created.id);
      setMobilePane('chat');
      await loadChatContextData(created.id);
      if (!isDrawerPinned) setIsDrawerOpen(false);
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  };

  const handleRenameChat = async (chatId: string, newTitle: string) => {
    try {
      const updated = await talkApi.updateChat(chatId, { title: newTitle });
      setChats((prev) => prev.map((c) => (c.id === chatId ? updated : c)));
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  };

  const handleDeleteChat = async (chatId: string) => {
    try {
      await talkApi.deleteChat(chatId);
      setNotesByChat((prev) => {
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      setQuestionsByChat((prev) => {
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      setMemoryByChat((prev) => {
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      setCardsByChat((prev) => {
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      setTextbooksByChat((prev) => {
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      setDraftByChat((prev) => {
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      setAttachmentsByChat((prev) => {
        const next = { ...prev };
        delete next[chatId];
        return next;
      });

      const remaining = chats.filter((c) => c.id !== chatId);
      if (remaining.length === 0) {
        const fresh = await talkApi.createChat('New study chat');
        setChats([fresh]);
        setActiveChatId(fresh.id);
        await loadChatContextData(fresh.id);
      } else {
        setChats(remaining);
        if (activeChatId === chatId) {
          setActiveChatId(remaining[0].id);
          await loadChatContextData(remaining[0].id);
        }
      }
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  };

  const handleSaveNote = async (chatId: string, nextNote: NoteData) => {
    setNotesByChat((prev) => ({ ...prev, [chatId]: nextNote }));
    await talkApi.kvSet(`note:${chatId}`, nextNote);
  };

  const handleSaveTextbook = async (chatId: string, next: TextbookData) => {
    setTextbooksByChat((prev) => ({ ...prev, [chatId]: next }));
    await talkApi.kvSet(`textbook:${chatId}`, next);
  };

  // Question + Flashcards synchronization helpers
  const addQuestionAndCard = async (chatId: string, question: string, answer: string) => {
    const chatTitle = chats.find((c) => c.id === chatId)?.title || 'General Study';
    const existing = questionsByChat[chatId] || [];
    const duplicate = existing.find(
      (q) => q.question.trim().toLowerCase() === question.trim().toLowerCase()
    );
    if (duplicate) return;

    const now = Date.now();
    const qId = createId('q');
    const optimisticQ: StoredQuestion = {
      id: qId,
      question,
      answer,
      createdAt: now,
      updatedAt: now,
    };
    const nextList = [...existing, optimisticQ];
    setQuestionsByChat((prev) => ({ ...prev, [chatId]: nextList }));

    try {
      const card = await talkApi.createCard({
        chatId,
        questionId: qId,
        question,
        answer,
        subject: chatTitle,
      });
      const syncedList = nextList.map((q) => (q.id === qId ? { ...q, flashcardId: card.id } : q));
      setQuestionsByChat((prev) => ({
        ...prev,
        [chatId]: (prev[chatId] || syncedList).map((q) =>
          q.id === qId ? { ...q, flashcardId: card.id } : q
        ),
      }));
      setCardsByChat((prev) => ({ ...prev, [chatId]: [...(prev[chatId] || []), card] }));
      await talkApi.kvSet(`questions:${chatId}`, syncedList);
    } catch (err) {
      setQuestionsByChat((prev) => ({
        ...prev,
        [chatId]: (prev[chatId] || []).filter((q) => q.id !== qId),
      }));
      throw err;
    }
  };

  const updateQuestionAndCard = async (
    chatId: string,
    questionId: string,
    question: string,
    answer: string
  ) => {
    const existing = questionsByChat[chatId] || [];
    const target = existing.find((q) => q.id === questionId);
    if (!target) return;

    const nextList = existing.map((q) =>
      q.id === questionId ? { ...q, question, answer, updatedAt: Date.now() } : q
    );
    setQuestionsByChat((prev) => ({ ...prev, [chatId]: nextList }));
    await talkApi.kvSet(`questions:${chatId}`, nextList);

    if (target.flashcardId) {
      const updatedCard = await talkApi.updateCard(target.flashcardId, { question, answer });
      setCardsByChat((prev) => ({
        ...prev,
        [chatId]: (prev[chatId] || []).map((c) => (c.id === updatedCard.id ? updatedCard : c)),
      }));
    }
  };

  const deleteQuestionAndCard = async (chatId: string, questionId: string) => {
    const existing = questionsByChat[chatId] || [];
    const target = existing.find((q) => q.id === questionId);
    if (!target) return;

    const nextList = existing.filter((q) => q.id !== questionId);
    setQuestionsByChat((prev) => ({ ...prev, [chatId]: nextList }));
    await talkApi.kvSet(`questions:${chatId}`, nextList);

    if (target.flashcardId) {
      await talkApi.deleteCard(target.flashcardId).catch(() => {});
      setCardsByChat((prev) => ({
        ...prev,
        [chatId]: (prev[chatId] || []).filter((c) => c.id !== target.flashcardId),
      }));
    }
  };

  const handleToggleSuggestedQa = async (suggestion: ParsedQaSuggestion, checked: boolean) => {
    if (!activeChatId) return;
    const normalized = suggestion.question.trim().toLowerCase();
    const existing = questionsByChat[activeChatId] || [];
    const match = existing.find((q) => q.question.trim().toLowerCase() === normalized);
    try {
      if (checked && !match) {
        await addQuestionAndCard(activeChatId, suggestion.question, suggestion.answer);
      } else if (!checked && match) {
        await deleteQuestionAndCard(activeChatId, match.id);
      }
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  };

  // Memory compaction runner (background + forced, single-stage 15-slot rolling buffer)
  const runMemoryCompaction = async (chatId: string, chatMessages: ChatMessage[], force = false) => {
    const startMem = memoryRef.current[chatId] || createEmptyMemory();
    const startEpoch = startMem.epoch;
    setCompactingChatId(chatId);

    try {
      for (let iteration = 0; iteration < 5; iteration++) {
        const latestMem = memoryRef.current[chatId] || startMem;
        if (latestMem.epoch !== startEpoch) {
          return;
        }

        const analysis = analyzeActiveWindow(chatMessages, latestMem.compactedCount);
        let toCompact: ChatMessage[] = [];

        if (analysis.uncompactedOutsideWindow.length > 0) {
          if (!force && analysis.uncompactedOutsideTokens < COMPACTION_TRIGGER_TOKENS) {
            break;
          }
          toCompact = selectCompactionChunk(
            analysis.uncompactedOutsideWindow,
            COMPACTION_TRIGGER_TOKENS
          ).messages;
        } else if (force && iteration === 0 && analysis.uncompactedTotalCount > 2) {
          const sliceCount = Math.max(2, Math.floor(analysis.activeWindow.length / 2));
          toCompact = analysis.activeWindow.slice(0, sliceCount);
        } else {
          break;
        }

        if (toCompact.length === 0) break;

        const inputTokens = toCompact.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

        const summaryRes = await talkApi.summarizeMemory({
          stage: 1,
          inputTokens,
          messages: toCompact,
        });

        const afterMem = memoryRef.current[chatId] || latestMem;
        if (afterMem.epoch !== startEpoch) {
          return;
        }

        const now = Date.now();
        const newPack: MemoryPack = {
          id: createId('pack_s1'),
          stage: 1,
          summary: summaryRes.summary,
          bullets: summaryRes.bullets,
          tokenCount: estimateTokens(summaryRes.summary),
          sourceRange: [afterMem.compactedCount, afterMem.compactedCount + toCompact.length],
          createdAt: now,
        };

        const packs = insertRollingPack(afterMem.packs, newPack, PACK_SLOTS);

        const updatedMemory: ChatMemory = {
          version: 2,
          compactedCount: afterMem.compactedCount + toCompact.length,
          compactedTokens: afterMem.compactedTokens + inputTokens,
          epoch: afterMem.epoch,
          learnerState: [],
          packs,
          updatedAt: Date.now(),
          lastError: undefined,
        };

        memoryRef.current = { ...memoryRef.current, [chatId]: updatedMemory };
        setMemoryByChat((prev) => ({ ...prev, [chatId]: updatedMemory }));
        await talkApi.kvSet(`memory:${chatId}`, updatedMemory);

        if (force && analysis.uncompactedOutsideTokens < COMPACTION_TRIGGER_TOKENS) {
          break;
        }
      }
    } catch (err) {
      const currentMem = memoryRef.current[chatId] || startMem;
      const erroredMemory: ChatMemory = {
        ...currentMem,
        lastError: (err as Error).message || 'Memory compaction failed',
        updatedAt: Date.now(),
      };
      setMemoryByChat((prev) => ({ ...prev, [chatId]: erroredMemory }));
      await talkApi.kvSet(`memory:${chatId}`, erroredMemory).catch(() => {});
    } finally {
      setCompactingChatId((prev) => (prev === chatId ? null : prev));
    }
  };

  const handleDeletePack = async (packId: string) => {
    if (!activeChatId) return;
    const current = memoryByChat[activeChatId] || createEmptyMemory();
    const updated: ChatMemory = {
      ...current,
      epoch: current.epoch + 1,
      packs: current.packs.filter((p) => p.id !== packId),
      updatedAt: Date.now(),
    };
    setMemoryByChat((prev) => ({ ...prev, [activeChatId]: updated }));
    await talkApi.kvSet(`memory:${activeChatId}`, updated);
  };

  const handleSelectThinkingLevel = async (next: ThinkingLevel) => {
    setSettings((prev) => ({ ...prev, thinkingLevel: next }));
    try {
      const saved = await talkApi.updateSettings({ thinkingLevel: next });
      setSettings(saved);
    } catch {
      // keep optimistic state
    }
  };

  const handleSaveSettings = async (
    themeMode: ThemeMode,
    geminiModel: GeminiModel
  ) => {
    const nextThinkingLevel = normalizeThinkingLevelForModel(settings.thinkingLevel, geminiModel);
    setSettings((prev) => ({
      ...prev,
      themeMode,
      provider: 'gemini',
      geminiModel,
      thinkingLevel: nextThinkingLevel,
      chatModel: geminiModel,
    }));
    setIsSettingsOpen(false);
    try {
      const saved = await talkApi.updateSettings({
        themeMode,
        provider: 'gemini',
        geminiModel,
        thinkingLevel: nextThinkingLevel,
      });
      setSettings(saved);
    } catch (err) {
      setErrorBanner((err as Error).message);
    }
  };

  const handleCancelStream = async () => {
    const reqId = activeRequestIdRef.current;
    if (reqId) {
      await talkApi.cancelChat(reqId).catch(() => {});
    }
  };

  const handleSendMessage = async (
    text: string,
    attachments: ChatAttachment[],
    useWebSearch: boolean
  ) => {
    if (!activeChat) return;
    const chatId = activeChat.id;
    setErrorBanner(null);

    const userMsg: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    const messagesWithUser = [...activeChat.messages, userMsg];
    const nextTitle =
      activeChat.messages.length === 0 && activeChat.title.startsWith('Study Session')
        ? text.slice(0, 42) || activeChat.title
        : activeChat.title;

    setChats((prev) =>
      prev.map((c) =>
        c.id === chatId
          ? { ...c, title: nextTitle, messages: messagesWithUser, updatedAt: Date.now() }
          : c
      )
    );
    await talkApi.updateChat(chatId, { title: nextTitle, messages: messagesWithUser });

    // Check direct chat intents (no AI call)
    const intent = parseChatIntent(text);
    if (intent && attachments.length === 0) {
      let confirmation = '';
      if (intent.type === 'add_last_question') {
        const lastAssistant = [...activeChat.messages]
          .reverse()
          .find((m) => m.role === 'assistant' && !m.memoryStage);
        const parsed = lastAssistant ? parseQaSuggestions(lastAssistant.content) : [];
        const existing = questionsByChat[chatId] || [];
        const nextToAdd = parsed.find(
          (p) => !existing.some((q) => q.question.trim().toLowerCase() === p.question.trim().toLowerCase())
        ) ?? parsed[0];
        if (nextToAdd) {
          await addQuestionAndCard(chatId, nextToAdd.question, nextToAdd.answer);
          confirmation = `Saved question to your Questions list and created an EXAM flashcard:\n"${nextToAdd.question}"`;
        } else {
          confirmation = 'No suggested question was found in the previous tutor message to add.';
        }
      } else if (intent.type === 'delete_question') {
        const list = questionsByChat[chatId] || [];
        const target = list[intent.index - 1];
        if (target) {
          await deleteQuestionAndCard(chatId, target.id);
          confirmation = `Deleted question ${intent.index}: "${target.question}"`;
        } else {
          confirmation = `Question ${intent.index} does not exist (there are ${list.length} saved questions).`;
        }
      } else if (intent.type === 'change_question') {
        const list = questionsByChat[chatId] || [];
        const target = list[intent.index - 1];
        if (target) {
          await updateQuestionAndCard(chatId, target.id, intent.newQuestion, target.answer);
          confirmation = `Updated question ${intent.index} to:\n"${intent.newQuestion}"`;
        } else {
          confirmation = `Question ${intent.index} does not exist (there are ${list.length} saved questions).`;
        }
      }

      const replyMsg: ChatMessage = {
        id: createId('msg'),
        role: 'assistant',
        content: confirmation,
        createdAt: Date.now(),
      };
      const updatedMessages = [...messagesWithUser, replyMsg];
      setChats((prev) =>
        prev.map((c) => (c.id === chatId ? { ...c, messages: updatedMessages, updatedAt: Date.now() } : c))
      );
      await talkApi.updateChat(chatId, { messages: updatedMessages });
      return;
    }

    // Optional Tavily web search before sending
    const extraSystemNotices: string[] = [];
    if (useWebSearch && text.trim()) {
      setIsSearchingWeb(true);
      try {
        const searchRes = await talkApi.webSearch(text);
        const formattedResults = searchRes.results
          .map((r, i) => `${i + 1}. ${r.title} (${r.url})\n${r.content}`)
          .join('\n\n');
        extraSystemNotices.push(
          `## Live Web Search Results (Tavily)\n${searchRes.answer ? `Summary: ${searchRes.answer}\n\n` : ''}${formattedResults}`
        );
      } catch (err) {
        setErrorBanner((err as Error).message);
      } finally {
        setIsSearchingWeb(false);
      }
    }

    const requestId = createId('req');
    activeRequestIdRef.current = requestId;
    setStreamingState({ requestId, chatId, text: '' });

    const assembled = assembleContextPrompt({
      memory: memoryByChat[chatId] || createEmptyMemory(),
      note: notesByChat[chatId],
      textbook: textbooksByChat[chatId] || EMPTY_TEXTBOOK,
      questions: questionsByChat[chatId] || [],
      messages: messagesWithUser,
      extraSystemNotices,
    });

    let accumulated = '';

    try {
      await talkApi.streamChat(
        {
          requestId,
          chatId,
          messages: assembled.selectedMessages,
          systemPrompt: assembled.systemPrompt,
          thinkingLevel: settings.thinkingLevel,
          textbookImages: assembled.textbookImagesForLatestUser,
        },
        {
          onChunk: (rid, delta) => {
            if (rid !== activeRequestIdRef.current) return;
            accumulated += delta;
            setStreamingState((prev) =>
              prev && prev.requestId === rid ? { ...prev, text: prev.text + delta } : prev
            );
          },
          onDone: async (rid, fullText, cancelled, usage) => {
            if (rid !== activeRequestIdRef.current) return;
            activeRequestIdRef.current = null;
            setStreamingState(null);

            const finalContent = (fullText || accumulated).trim();
            if (!finalContent) {
              if (!cancelled) {
                setErrorBanner('The model returned an empty response. Please try again.');
              }
              return;
            }

            const assistantMsg: ChatMessage = {
              id: createId('msg'),
              role: 'assistant',
              content: finalContent,
              createdAt: Date.now(),
              ...(usage ? { tokenUsage: usage } : {}),
            };
            const finalMessages = [...messagesWithUser, assistantMsg];
            setChats((prev) =>
              prev.map((c) =>
                c.id === chatId ? { ...c, messages: finalMessages, updatedAt: Date.now() } : c
              )
            );
            await talkApi.updateChat(chatId, { messages: finalMessages });

            // Background compaction runs after reply is saved & composer unlocks
            if (needsCompaction(finalMessages, memoryRef.current[chatId] || createEmptyMemory())) {
              void runMemoryCompaction(chatId, finalMessages, false);
            }
          },
          onError: (rid, error) => {
            if (rid !== activeRequestIdRef.current) return;
            activeRequestIdRef.current = null;
            setStreamingState(null);
            setErrorBanner(error);
          },
        }
      );
    } catch (err) {
      if (activeRequestIdRef.current === requestId) {
        activeRequestIdRef.current = null;
        setStreamingState(null);
        setErrorBanner((err as Error).message || 'Failed to stream response.');
      }
    }
  };

  const handleProcessChatFiles = async (files: FileList | File[]) => {
    if (!activeChatId) return;
    const targetChatId = activeChatId;
    const { images, textBlocks } = await processSelectedFiles(files);
    if (images.length > 0) {
      setAttachmentsByChat((prev) => ({
        ...prev,
        [targetChatId]: [...(prev[targetChatId] || []), ...images],
      }));
    }
    if (textBlocks.length > 0) {
      setDraftByChat((prev) => {
        const current = prev[targetChatId] || '';
        const prefix = current.trim() ? `${current.trimEnd()}\n\n` : '';
        return { ...prev, [targetChatId]: `${prefix}${textBlocks.join('\n\n')}` };
      });
    }
    if (images.length > 0 || textBlocks.length > 0) {
      setMobilePane('chat');
    }
  };

  const handleStartResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;

    const updateFromClientX = (clientX: number) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const rawPct = ((clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(72, Math.max(30, Math.round(rawPct * 10) / 10));
      setLeftPanePct(clamped);
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateFromClientX(moveEvent.clientX);
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
      <div className="relative flex-1 min-h-0 flex">
        <ChatManagerDrawer
          chats={chats}
          activeChatId={activeChatId}
          isOpen={isDrawerOpen}
          isPinned={isDrawerPinned}
          onCloseDrawer={() => setIsDrawerOpen(false)}
          onTogglePin={() => {
            setIsDrawerPinned((p) => {
              const next = !p;
              setIsDrawerOpen(next);
              return next;
            });
          }}
          onSelectChat={handleSelectChat}
          onCreateChat={handleCreateChat}
          onRenameChat={handleRenameChat}
          onDeleteChat={handleDeleteChat}
        />

        <main className="relative flex-1 min-w-0 min-h-0 flex flex-col">
          {isLoading || !activeChat ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-500 dark:text-slate-400">
              Loading study workspace…
            </div>
          ) : (
            <>
              {/* Mobile-only compact pane toggle (desktop always shows side-by-side) */}
              <div className="md:hidden shrink-0 h-11 px-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-center">
                <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700/70">
                  <button
                    type="button"
                    onClick={() => setMobilePane('chat')}
                    className={`h-7 px-3 rounded-md text-xs font-medium transition-colors ${
                      mobilePane === 'chat'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-xs'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    onClick={() => setMobilePane('panel')}
                    className={`h-7 px-3 rounded-md text-xs font-medium transition-colors ${
                      mobilePane === 'panel'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-xs'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {activeTab === 'notes'
                      ? 'Notepad'
                      : activeTab === 'textbook'
                      ? 'Textbook'
                      : activeTab === 'questions'
                      ? `Questions (${activeQuestions.length})`
                      : 'Memory'}
                  </button>
                </div>
              </div>

              {/* Two-Section Split Workspace: Left = Always Chat, Right = Switchable Study Panel */}
              <div
                ref={splitContainerRef}
                style={{ '--left-pane-width': `${leftPanePct}%` } as CSSProperties}
                className="flex-1 min-h-0 flex flex-row overflow-hidden"
              >
                {/* Left Side: Always-open Chat */}
                <section
                  aria-label="Chat workspace"
                  className={`relative min-w-0 min-h-0 flex-col bg-slate-50 dark:bg-slate-950 md:w-[var(--left-pane-width)] md:shrink-0 ${
                    mobilePane === 'chat' ? 'flex w-full' : 'hidden md:flex'
                  }`}
                >
                  <WorkspaceRail
                    showSessionButton={!isDrawerOpen && !isDrawerPinned}
                    onOpenSessionDrawer={() => setIsDrawerOpen(true)}
                    webSearchArmed={webSearchArmed}
                    onToggleWebSearch={() => setWebSearchArmed((v) => !v)}
                    geminiModel={settings.geminiModel}
                    thinkingLevel={settings.thinkingLevel}
                    onSelectThinkingLevel={handleSelectThinkingLevel}
                    onOpenSettings={() => setIsSettingsOpen(true)}
                  />

                  <ChatTab
                    chatId={activeChat.id}
                    chatTitle={activeChat.title}
                    messages={activeChat.messages}
                    savedQuestions={activeQuestions}
                    note={activeNote}
                    memory={activeMemory}
                    textbook={activeTextbook}
                    geminiModel={settings.geminiModel}
                    streamingText={
                      streamingState && streamingState.chatId === activeChat.id
                        ? streamingState.text
                        : null
                    }
                    isStreaming={Boolean(streamingState && streamingState.chatId === activeChat.id)}
                    isSearchingWeb={isSearchingWeb}
                    errorBanner={errorBanner}
                    onDismissError={() => setErrorBanner(null)}
                    input={chatInput}
                    onChangeInput={(val) =>
                      setDraftByChat((prev) => ({ ...prev, [activeChat.id]: val }))
                    }
                    attachments={pendingAttachments}
                    onRemoveAttachment={(id) =>
                      setAttachmentsByChat((prev) => ({
                        ...prev,
                        [activeChat.id]: (prev[activeChat.id] || []).filter(
                          (item) => item.id !== id
                        ),
                      }))
                    }
                    onClearAttachments={() =>
                      setAttachmentsByChat((prev) => ({ ...prev, [activeChat.id]: [] }))
                    }
                    onProcessFiles={handleProcessChatFiles}
                    webSearchArmed={webSearchArmed}
                    onClearWebSearch={() => setWebSearchArmed(false)}
                    onSendMessage={handleSendMessage}
                    onCancelStream={handleCancelStream}
                    onToggleSuggestedQa={handleToggleSuggestedQa}
                    onTranscribeAudio={async (blob) => {
                      const res = await talkApi.transcribeAudio(blob);
                      return res.text;
                    }}
                  />
                </section>

                {/* Resizable Split Handle */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize chat and study panel"
                  title="Drag to resize · Double-click to reset"
                  onPointerDown={handleStartResize}
                  onDoubleClick={() => setLeftPanePct(50)}
                  className="hidden md:flex w-1.5 shrink-0 cursor-col-resize bg-slate-200/80 dark:bg-slate-800 hover:bg-sky-400/80 dark:hover:bg-sky-600/80 transition-colors items-center justify-center group select-none"
                >
                  <div className="w-0.5 h-8 rounded-full bg-slate-400/50 dark:bg-slate-600 group-hover:bg-white/90 transition-colors" />
                </div>

                {/* Right Side: Centered Top Floating Switcher + Notepad / Textbook / Questions / Memory */}
                <section
                  aria-label="Study reference workspace"
                  className={`relative flex-1 min-w-0 min-h-0 flex-col bg-slate-50 dark:bg-slate-950 ${
                    mobilePane === 'panel' ? 'flex w-full' : 'hidden md:flex'
                  }`}
                >
                  <RightPanelSwitcher
                    activeTab={activeTab}
                    onSelectTab={setActiveTab}
                    panelMode={rightPanelMode}
                    onSelectPanelMode={setRightPanelMode}
                    questionCount={activeQuestions.length}
                    isCompacting={Boolean(activeChatId && compactingChatId === activeChatId)}
                    memoryError={activeMemory.lastError}
                  />

                  {activeTab === 'notes' ? (
                    <NotesTab
                      key={`notes_${activeChat.id}`}
                      chatId={activeChat.id}
                      note={activeNote}
                      onSaveNote={handleSaveNote}
                    />
                  ) : activeTab === 'textbook' ? (
                    <TextbookTab
                      key={`textbook_${activeChat.id}`}
                      chatId={activeChat.id}
                      textbook={activeTextbook}
                      mode={rightPanelMode}
                      onSaveTextbook={handleSaveTextbook}
                    />
                  ) : activeTab === 'questions' ? (
                    <QuestionsTab
                      key={`questions_${activeChat.id}`}
                      questions={activeQuestions}
                      cards={activeCards}
                      onAddQuestion={(q, a) => addQuestionAndCard(activeChat.id, q, a)}
                      onUpdateQuestion={(id, q, a) => updateQuestionAndCard(activeChat.id, id, q, a)}
                      onDeleteQuestion={(id) => deleteQuestionAndCard(activeChat.id, id)}
                    />
                  ) : (
                    <MemoryPanel
                      key={`memory_${activeChat.id}`}
                      memory={activeMemory}
                      messages={activeChat.messages}
                      isCompacting={Boolean(activeChatId && compactingChatId === activeChatId)}
                      onCompactNow={() => {
                        void runMemoryCompaction(activeChat.id, activeChat.messages, true);
                      }}
                      onDeletePack={handleDeletePack}
                    />
                  )}
                </section>
              </div>
            </>
          )}
        </main>
      </div>

      <SettingsModal
        isOpen={isSettingsOpen}
        currentTheme={settings.themeMode}
        currentGeminiModel={settings.geminiModel}
        currentThinkingLevel={settings.thinkingLevel}
        onSave={handleSaveSettings}
        onExportBackup={async () => {
          const snapshot = await talkApi.exportWorkspace();
          const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
            type: 'application/json',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `talk-backup-${new Date().toISOString().slice(0, 10)}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        }}
        onImportBackup={async (file) => {
          const text = await file.text();
          const parsed = JSON.parse(text);
          await talkApi.importWorkspace(parsed);
          await reloadWorkspaceFromStore();
        }}
        onResetWorkspace={async () => {
          await talkApi.resetWorkspace();
          await reloadWorkspaceFromStore();
        }}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Camera, CornerUpLeft, Loader2, Mic, Trash2, X } from 'lucide-react';
import type { Expense, Trip } from '../../types';
import { ui } from '../../components/ui';
import ExpenseModal from '../../components/ExpenseModal';
import ItemSplitPanel from '../../components/ItemSplitPanel';
import PhotoLightbox from '../../components/PhotoLightbox';
import BrandMark from '../../components/BrandMark';
import { useBackClose } from '../../hooks/useBackClose';
import { isSubmitEnter } from '../../utils/keyboard';
import { photoUrl } from '../../utils/storage';
import { formatMoney } from '../../utils/money';
import { ASSISTANT_CATCHPHRASE, ASSISTANT_CHAT_TITLE, ASSISTANT_EMOJI, ASSISTANT_NAME } from '../../config/assistant';
import * as api from './api';
import {
  applyBlocks, emptyChat, lastSavedDraft, latestPendingDraft, loadChat, MAX_HISTORY, newId, patchItem,
  pendingDrafts, saveChat, SEND_HISTORY, type ChatState,
} from './chatStore';
import { DeleteCard, DraftCard, PickExistingCard, RichText, SummaryCardView, UpdateCard } from './ChatCards';
import { changeCurrency, draftToExpense, soloDraft } from './draftOps';
import {
  CANCEL_DRAFT_KEYWORDS, DELETE_LIST_KEYWORDS, EDIT_LIST_KEYWORDS, HELP_KEYWORDS, matchQuickCommand,
  QUICK_COMMANDS, runQuickCommand, UNDO_KEYWORDS, type QuickCommand,
} from './quick';
import type { ChatItem, DraftExpense, DraftItem, ReplyTarget } from './types';

interface Props {
  open: boolean;
  onClose: () => void;
  trip: Trip;
  /** 帳目（含離線待上傳的），快捷查詢與「挑一筆」用 */
  expenses: Expense[];
  /** 每人淨額（折合主幣別，stats.balances.GRAND_TOTAL） */
  balances: Record<string, number>;
  currentUser: string | null;
  onPickUser: () => void;
  /** 有東西寫進帳本了，請外層重新抓 */
  onChanged: () => void;
  /** 開既有支出的編輯表單、刪除確認（Dashboard 原本的流程） */
  onEditExpense: (e: Expense) => void;
  onDeleteExpense: (e: Expense) => void;
  showToast: (msg: string, type?: 'success' | 'error') => void;
}

const HELP_TEXT = `${ASSISTANT_CATCHPHRASE} 我是${ASSISTANT_NAME} ${ASSISTANT_EMOJI} 在這裡可以：
・直接打字記帳：「晚餐 3200 小明付」「計程車 1500 我付，我跟阿杰分」，一句話記好幾筆也行
・按 📷 傳收據或商品照片（可以一次選好幾張），我會讀出金額和品項
・卡片上可以直接改金額、日期、分類，點開「付款／分攤」就能選人；逐項分、只算我也都在卡片上
・想補充某張卡片，按卡片下面的「回覆」再打字，我就知道你在講哪一張
・問帳：「這趟總共花多少？」「我還要付誰多少？」「上週吃最多的是哪天？」
・問行程、天氣、附近吃什麼，或請我改／刪已經存好的支出（會先出一張確認卡）
下面那排按鈕是常用查詢，按了馬上出來。`;

const EXAMPLES = ['晚餐 3000 大家分', '今天總共花多少？', '明天的行程是什麼？'];

type Busy = Record<string, boolean>;

/** 逐項分面板是 LIFF 那一頁原封不動搬來的，整個蓋住畫面；返回鍵關掉它 */
const FullScreen: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => {
  useBackClose(true, onClose);
  return <div className="fixed inset-0 z-[55] overflow-y-auto overscroll-contain bg-canvas">{children}</div>;
};

// Web Speech API（Chrome、Safari 有；Firefox 沒有就不顯示麥克風）
type SpeechRecognitionLike = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null; onerror: (() => void) | null;
  start: () => void; stop: () => void;
};
const SpeechRecognitionCtor = (typeof window !== 'undefined'
  ? (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition
  : undefined);

/**
 * 跟耀西聊天記帳（網頁版）。
 *
 * 跟 LINE 用同一顆腦（Edge Function web-chat 與 line-webhook 共用 _shared/assistant/），
 * 但不受 LINE 的限制：卡片直接在對話裡改、可以指定回覆哪一張卡、一次回好幾則、快捷查詢免等。
 * 對話與草稿存在這台裝置（chatStore.ts），不寫資料庫。
 */
const ChatPanel: React.FC<Props> = ({
  open, onClose, trip, expenses, balances, currentUser, onPickUser, onChanged, onEditExpense, onDeleteExpense, showToast,
}) => {
  const [chat, setChat] = useState<ChatState>(() => loadChat(trip.id));
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<{ target: ReplyTarget; label: string } | null>(null);
  /** 等 AI 回覆中（文字一次一則；照片各自上傳） */
  const [thinking, setThinking] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>({});
  const [formFor, setFormFor] = useState<{ itemId: string; expense: Expense } | null>(null);
  const [itemsFor, setItemsFor] = useState<DraftItem | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const openRef = useRef(open);
  openRef.current = open;
  /** 聊天室關著的時候回覆到了：跳一個提示，不然使用者不知道要回來看 */
  const notifyIfClosed = () => { if (!openRef.current) showToast(`${ASSISTANT_NAME}回覆了，打開聊天就看得到`); };
  const readOnly = trip.is_archived;

  // 換旅程時 Dashboard 會用 key 換一個新的 ChatPanel（上一趟還在等的回覆不會落到這一趟）
  useEffect(() => { saveChat(trip.id, chat); }, [trip.id, chat]);

  useBackClose(open, onClose);
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = 'unset'; };
  }, [open]);

  // 新訊息進來就捲到最下面
  const itemCount = chat.items.length;
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [open, itemCount, thinking]);

  const update = useCallback((fn: (s: ChatState) => ChatState) => setChat(prev => fn(prev)), []);
  const addItems = useCallback((items: ChatItem[]) => update(s => ({ ...s, items: [...s.items, ...items] })), [update]);
  const patch = useCallback(<T extends ChatItem>(id: string, p: Partial<T>) => update(s => ({ ...s, items: patchItem<T>(s.items, id, p) })), [update]);
  const botText = (t: string): ChatItem => ({ id: newId(), at: Date.now(), role: 'bot', kind: 'text', text: t });
  const setBusyFor = (id: string, v: boolean) => setBusy(b => ({ ...b, [id]: v }));
  /** 按了卡片上的按鈕也記進對話紀錄：不然模型以為那張卡還沒存，「剛剛那筆改 500」會再出一張新卡 */
  const remember = (content: string) => update(s => ({ ...s, history: [...s.history, { role: 'model' as const, content }].slice(-MAX_HISTORY) }));
  const refOf = (id?: string) => (id ? ` ref=${id.slice(0, 8)}` : '');

  const base = { tripId: trip.id, memberName: currentUser };

  // ── 送出 ───────────────────────────────

  const runQuick = (cmd: QuickCommand) => {
    const result = runQuickCommand(cmd, trip, expenses, balances);
    addItems([typeof result === 'string'
      ? botText(result)
      : { id: newId(), at: Date.now(), role: 'bot', kind: 'summary', ...result }]);
  };

  const send = async (raw: string) => {
    const t = raw.trim();
    if (!t || thinking) return;
    const target = replyTo;
    setText('');
    setReplyTo(null);
    addItems([{ id: newId(), at: Date.now(), role: 'user', kind: 'text', text: t, replyLabel: target?.label }]);

    // 跟 LINE 一樣的精確指令，在這台裝置上就做得完
    const quick = matchQuickCommand(t);
    if (quick) { runQuick(quick); return; }
    if (HELP_KEYWORDS.includes(t)) { addItems([botText(HELP_TEXT)]); return; }
    if (EDIT_LIST_KEYWORDS.includes(t) || DELETE_LIST_KEYWORDS.includes(t)) {
      addItems([{ id: newId(), at: Date.now(), role: 'bot', kind: 'pick', text: '要改或刪哪一筆？點一下就能處理：', mode: EDIT_LIST_KEYWORDS.includes(t) ? 'edit' : 'delete' }]);
      return;
    }
    if (UNDO_KEYWORDS.includes(t)) {
      if (readOnly) { addItems([botText('🔒 這趟旅程已封存，不能撤銷或刪除支出。')]); return; }
      const last = lastSavedDraft(chatRef.current.items);
      if (!last) { addItems([botText('這裡沒有剛存入、可以撤銷的支出。要刪其他筆，打「刪除支出」從清單挑。')]); return; }
      const result = await undo(last);
      // 卡片在上面，可能已經捲出畫面：在下面也回一句
      if (result) addItems([botText(result)]);
      return;
    }
    if (CANCEL_DRAFT_KEYWORDS.includes(t) && !target) {
      const draft = latestPendingDraft(chatRef.current.items);
      if (draft) {
        await cancelDraft(draft);
        addItems([botText(`🗑 已取消還沒存的「${draft.draft.exp.d || '這筆'}」。（要刪除已經存入的支出，請打「刪除支出」。）`)]);
        return;
      }
    }

    setThinking(`${ASSISTANT_NAME}正在想…`);
    try {
      const s = chatRef.current;
      const reply = await api.sendMessage({
        ...base, text: t,
        history: s.history.slice(-SEND_HISTORY),
        drafts: pendingDrafts(s.items),
        replyTo: target?.target ?? null,
      });
      update(cur => ({
        items: applyBlocks(cur.items, reply.blocks),
        history: [...cur.history, ...reply.history].slice(-MAX_HISTORY),
      }));
      notifyIfClosed();
    } catch (e) {
      addItems([botText(`😵 ${e instanceof Error ? e.message : '發生錯誤，請稍後再試。'}剛剛那句放回輸入框了，按送出就能再試一次。`)]);
      // 沒送出去的那句放回輸入框（使用者還沒開始打新的才放），回覆的卡片也接回去
      setText(cur => (cur.trim() ? cur : t));
      if (target) setReplyTo(prev => prev ?? target);
      if (!openRef.current) showToast('剛剛那句沒送出去，打開聊天再送一次', 'error');
    } finally {
      setThinking(null);
    }
  };

  /** 這次開著的頁面裡選的照片（失敗時按「重試」用，重新整理就沒了） */
  const photoFiles = useRef(new Map<string, File>());

  /** 一張照片：上傳 → 辨識 → 出卡。照片泡泡一選就出現（本機預覽），不必等上傳完 */
  const processPhoto = async (bubbleId: string, file: File) => {
    const bubble = chatRef.current.items.find(i => i.id === bubbleId);
    // 重試時，已經傳上去的照片不再傳一次（不然 Storage 會多一張沒人用的）
    let path = bubble?.kind === 'photo' ? bubble.path : '';
    try {
      if (!path) {
        patch(bubbleId, { status: 'uploading' });
        path = await api.uploadChatPhoto(trip.id, file);
      }
      patch(bubbleId, { path, status: 'reading' });
      const reply = await api.sendPhoto({ ...base, photoPath: path });
      const gotCard = reply.blocks.some(b => b.type === 'draft' || b.type === 'currency');
      update(cur => ({
        items: applyBlocks(cur.items, reply.blocks),
        history: [...cur.history, ...reply.history].slice(-MAX_HISTORY),
      }));
      if (gotCard) {
        patch(bubbleId, { status: undefined });
        photoFiles.current.delete(bubbleId);
        notifyIfClosed();
      } else {
        // 函式那邊處理失敗會把照片刪掉、只回一句話：這張要從頭再傳一次才行
        patch(bubbleId, { path: '', status: 'failed' });
      }
    } catch (e) {
      // 網路斷在半路：照片（如果傳上去了）留著，重試時直接拿它辨識
      patch(bubbleId, { status: 'failed' });
      if (!openRef.current) showToast('有一張照片沒處理好，打開聊天按「重試」', 'error');
      addItems([botText(`😵 有一張照片沒處理好：${e instanceof Error ? e.message : '請再試一次'}（按照片上的「重試」）`)]);
    }
  };

  const sendPhotos = async (files: File[]) => {
    if (files.length === 0 || readOnly) return;
    const now = Date.now();
    const bubbles = files.map((file, i) => {
      const id = newId();
      photoFiles.current.set(id, file);
      return { id, file, item: { id, at: now + i, role: 'user' as const, kind: 'photo' as const, path: '', localUrl: URL.createObjectURL(file), status: 'uploading' as const } };
    });
    addItems(bubbles.map(b => b.item));
    // 同時最多處理 3 張：一張要十幾秒，一張一張來的話選 5 張要等一分鐘
    const queue = [...bubbles];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await processPhoto(next.id, next.file);
    };
    await Promise.all([worker(), worker(), worker()]);
  };

  /** 重試：照片已經在 Storage（網路斷在辨識那一步）就直接辨識，重新整理過也行；不然要有這次選的檔案 */
  const canRetryPhoto = (item: Extract<ChatItem, { kind: 'photo' }>) => !!item.path || photoFiles.current.has(item.id);
  const retryPhoto = (bubbleId: string) => {
    const file = photoFiles.current.get(bubbleId) ?? new File([], 'already-uploaded.jpg');
    processPhoto(bubbleId, file);
  };

  // ── 卡片上的按鈕 ───────────────────────────────

  const findDraft = (id: string) => chatRef.current.items.find((i): i is DraftItem => i.id === id && i.kind === 'draft');

  const changeDraft = (item: DraftItem, exp: DraftExpense) =>
    patch<DraftItem>(item.id, { draft: { ...item.draft, exp } });

  /** 正在送出的卡片。按鈕的 disabled 要等下一次 render，手快連點兩下會存成兩筆，所以另外用 ref 擋 */
  const inFlight = useRef(new Set<string>());

  const saveItem = async (item: DraftItem, exp?: DraftExpense) => {
    if (inFlight.current.has(item.id)) return;
    inFlight.current.add(item.id);
    const draft = exp ? { ...item.draft, exp } : item.draft;
    const saveId = item.saveId ?? crypto.randomUUID();
    if (!item.saveId) patch<DraftItem>(item.id, { saveId });
    setBusyFor(item.id, true);
    try {
      const res = await api.saveDraft({ ...base, draft, saveId });
      if (res.ok) {
        patch<DraftItem>(item.id, { draft, status: 'saved', expenseId: res.expenseId, resultText: res.text });
        remember(`[已存入${refOf(res.expenseId)}] ${draft.exp.d} ${draft.exp.a} ${draft.exp.c}（使用者按了確認存入，這筆已經在帳本裡，要改請用 propose_expense_update）`);
        onChanged();
      } else {
        if (exp) patch<DraftItem>(item.id, { draft });
        showToast(res.text, 'error');
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : '存入失敗，請再試一次', 'error');
    } finally {
      inFlight.current.delete(item.id);
      setBusyFor(item.id, false);
    }
  };

  const solo = (item: DraftItem) => {
    if (!currentUser) { onPickUser(); return; }
    const exp = soloDraft(item.draft.exp, trip, currentUser);
    // 有金額就直接存（跟 LINE 一樣不再多一張卡）；照片記帳還沒金額就只換付款與分攤
    if (Number(exp.a) > 0) saveItem(item, exp);
    else changeDraft(item, exp);
  };

  async function cancelDraft(item: DraftItem) {
    patch<DraftItem>(item.id, { status: 'cancelled' });
    remember(`[已取消草稿 nonce=${item.draft.nonce}] ${item.draft.exp.d}（沒有存入）`);
    // 同一張照片可能還掛在另一張沒處理的卡上（例如重試辨識多出一張），那張還要用就不刪
    const stillUsed = new Set(chatRef.current.items.flatMap(i =>
      i.kind === 'draft' && i.id !== item.id && i.status === 'pending' ? i.draft.photoIds : []));
    const photos = item.draft.photoIds.filter(p => !stillUsed.has(p));
    if (photos.length > 0) {
      try { await api.discardPhotos({ ...base, photoIds: photos }); } catch { /* 照片留著只佔空間，之後的孤兒清理會收 */ }
    }
  }

  async function undo(item: DraftItem): Promise<string | null> {
    if (!item.expenseId || inFlight.current.has(item.id)) return null;
    inFlight.current.add(item.id);
    setBusyFor(item.id, true);
    try {
      const res = await api.deleteExpense({ ...base, expenseId: item.expenseId, undo: true });
      if (res.ok) {
        patch<DraftItem>(item.id, { status: 'undone', resultText: res.text });
        remember(`[已撤銷${refOf(item.expenseId)}] ${item.draft.exp.d}（已移到垃圾桶）`);
        onChanged();
        return res.text;
      }
      showToast(res.text, 'error');
      return null;
    } catch (e) {
      showToast(e instanceof Error ? e.message : '撤銷失敗', 'error');
      return null;
    } finally {
      inFlight.current.delete(item.id);
      setBusyFor(item.id, false);
    }
  }

  const applyUpdateCard = async (item: Extract<ChatItem, { kind: 'update' }>) => {
    if (inFlight.current.has(item.id)) return;
    inFlight.current.add(item.id);
    setBusyFor(item.id, true);
    try {
      const res = await api.applyUpdate({ ...base, expenseId: item.expenseId, exp: item.exp });
      if (res.ok) { patch(item.id, { status: 'done', resultText: res.text }); remember(`[已修改${refOf(item.expenseId)}] ${item.existing.description}`); onChanged(); }
      else showToast(res.text, 'error');
    } catch (e) {
      showToast(e instanceof Error ? e.message : '修改失敗', 'error');
    } finally {
      inFlight.current.delete(item.id);
      setBusyFor(item.id, false);
    }
  };

  const confirmDelete = async (item: Extract<ChatItem, { kind: 'delete' }>) => {
    if (inFlight.current.has(item.id)) return;
    inFlight.current.add(item.id);
    setBusyFor(item.id, true);
    try {
      const res = await api.deleteExpense({ ...base, expenseId: item.expenseId });
      if (res.ok) { patch(item.id, { status: 'done', resultText: res.text }); remember(`[已刪除${refOf(item.expenseId)}] ${item.existing.description}`); onChanged(); }
      else showToast(res.text, 'error');
    } catch (e) {
      showToast(e instanceof Error ? e.message : '刪除失敗', 'error');
    } finally {
      inFlight.current.delete(item.id);
      setBusyFor(item.id, false);
    }
  };

  /** 修改預覽的「再調整」：表單直接帶入**提議的新內容**（LINE 的 LIFF 只能開原內容） */
  const editProposed = (item: Extract<ChatItem, { kind: 'update' }>) => {
    const existing = expenses.find(e => e.id === item.expenseId);
    if (!existing) { showToast('找不到這筆支出，可能已經被刪掉了', 'error'); return; }
    const e = item.exp;
    setFormFor({
      itemId: item.id,
      expense: { ...existing, description: e.d, amount: e.a, currency: e.c, date: e.dt, category: e.cat, payer_data: e.p, split_data: e.s },
    });
  };

  const replyToDraft = (item: DraftItem) => {
    if (item.status === 'saved' && item.expenseId) {
      setReplyTo({ target: { kind: 'expense', id: item.expenseId, label: item.draft.exp.d }, label: item.draft.exp.d || '這筆支出' });
    } else {
      setReplyTo({ target: { kind: 'draft', nonce: item.draft.nonce }, label: item.draft.exp.d || '這張卡片' });
    }
    inputRef.current?.focus();
  };

  const replyToExpense = (id: string, label: string) => {
    setReplyTo({ target: { kind: 'expense', id, label }, label });
    inputRef.current?.focus();
  };

  // ── 語音輸入 ───────────────────────────────

  const toggleMic = () => {
    if (!SpeechRecognitionCtor) return;
    if (listening) { recognition.current?.stop(); return; }
    const rec = new SpeechRecognitionCtor();
    rec.lang = 'zh-TW';
    rec.interimResults = true;
    rec.continuous = false;
    const before = text;
    rec.onresult = (e) => {
      const said = Array.from(e.results).map(r => r[0]?.transcript ?? '').join('');
      setText(`${before}${said}`);
    };
    rec.onend = () => { setListening(false); inputRef.current?.focus(); };
    rec.onerror = () => setListening(false);
    recognition.current = rec;
    setListening(true);
    rec.start();
  };

  const clearChat = () => {
    // 還沒存的照片也一起清掉，不留孤兒
    const photos = chat.items.flatMap(i => (i.kind === 'draft' && i.status === 'pending' ? i.draft.photoIds : []));
    if (photos.length > 0) api.discardPhotos({ ...base, photoIds: photos }).catch(() => undefined);
    setChat(emptyChat());
  };

  // 想超過 12 秒（查行程、上網、看收據）就換一句，讓人知道還在動
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!thinking) return;
    const id = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(id);
  }, [thinking]);

  // 輸入框跟著內容長高（Safari 還不支援 field-sizing），最多 5 行
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [text, open]);

  const pendingCount = useMemo(() => chat.items.filter(i => i.kind === 'draft' && i.status === 'pending').length, [chat.items]);

  if (!open) return null;

  const renderItem = (item: ChatItem) => {
    if (item.role === 'user') {
      if (item.kind === 'photo') {
        // 這次選的照片先用本機預覽（換成網路上的那張會閃一下白），重新整理後才讀 Storage
        const src = item.localUrl ?? (item.path ? photoUrl(item.path) : undefined);
        return (
          <div className="ml-auto relative w-36 h-36 rounded-2xl overflow-hidden border border-line bg-sunk">
            {src && (
              <button onClick={() => item.path && setLightbox(item.path)} className="block w-full h-full" aria-label="看照片">
                <img src={src} alt="傳出的照片" className={`w-full h-full object-cover ${item.status && item.status !== 'failed' ? 'opacity-70' : ''}`} loading="lazy" />
              </button>
            )}
            {(item.status === 'uploading' || item.status === 'reading') && (
              <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-scrim text-white text-xs py-1.5">
                <Loader2 size={13} className="animate-spin" />{item.status === 'uploading' ? '上傳中…' : '讀收據中…'}
              </span>
            )}
            {item.status === 'failed' && (
              <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-scrim text-white text-xs">
                沒處理好
                {canRetryPhoto(item) && (
                  <button onClick={() => retryPhoto(item.id)} className="rounded-full bg-surface text-ink px-3 py-1 font-bold">重試</button>
                )}
              </span>
            )}
          </div>
        );
      }
      return (
        <div className="ml-auto max-w-[85%] space-y-1">
          {item.replyLabel && (
            <p className="text-[11px] text-muted text-right flex items-center justify-end gap-1"><CornerUpLeft size={11} />回覆「{item.replyLabel}」</p>
          )}
          <p className="rounded-2xl rounded-br-md bg-primary text-on-primary px-3.5 py-2 text-[15px] whitespace-pre-wrap break-words">{item.text}</p>
        </div>
      );
    }
    switch (item.kind) {
      case 'text':
        return (
          <p className="max-w-[88%] rounded-2xl rounded-bl-md bg-surface border border-line px-3.5 py-2 text-[15px] whitespace-pre-wrap break-words">
            <RichText text={item.text} />
          </p>
        );
      case 'draft':
        return (
          <DraftCard
            item={item}
            trip={trip}
            me={currentUser}
            busy={!!busy[item.id]}
            readOnly={readOnly}
            onChange={exp => changeDraft(item, exp)}
            onSave={() => saveItem(findDraft(item.id) ?? item)}
            onSolo={() => solo(findDraft(item.id) ?? item)}
            onCancel={() => cancelDraft(item)}
            onUndo={() => undo(item)}
            onFullForm={() => setFormFor({ itemId: item.id, expense: draftToExpense(item.draft, trip) })}
            onItems={() => setItemsFor(item)}
            onCurrency={c => patch<DraftItem>(item.id, { draft: { ...item.draft, exp: changeCurrency(item.draft.exp, trip, c) }, currencies: undefined })}
            onReply={readOnly ? undefined : () => replyToDraft(item)}
            onOpenPhoto={setLightbox}
          />
        );
      case 'update':
        return (
          <UpdateCard
            item={item}
            trip={trip}
            busy={!!busy[item.id]}
            readOnly={readOnly}
            onApply={() => applyUpdateCard(item)}
            onEdit={() => editProposed(item)}
            onCancel={() => patch(item.id, { status: 'cancelled' })}
            onReply={() => replyToExpense(item.expenseId, item.existing.description)}
          />
        );
      case 'delete':
        return (
          <DeleteCard
            item={item}
            trip={trip}
            busy={!!busy[item.id]}
            readOnly={readOnly}
            onConfirm={() => confirmDelete(item)}
            onCancel={() => patch(item.id, { status: 'cancelled' })}
          />
        );
      case 'pick':
        return <PickExistingCard text={item.text} trip={trip} expenses={expenses} readOnly={readOnly} onEdit={onEditExpense} onDelete={onDeleteExpense} />;
      case 'summary':
        return <SummaryCardView title={item.title} subtitle={item.subtitle} sections={item.sections} totals={item.totals} notes={item.notes} />;
    }
  };

  const formItem = formFor ? chat.items.find(i => i.id === formFor.itemId) : null;

  return (
    <div className="fixed inset-0 z-[45] flex md:justify-end bg-scrim/0 md:bg-scrim anim-fade" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section
        className="relative flex flex-col w-full md:w-[440px] h-dvh bg-canvas md:border-l md:border-line md:shadow-2xl"
        aria-label={`跟${ASSISTANT_NAME}聊天記帳`}
        role="dialog"
      >
        {/* 標題列 */}
        {/* 離線提示條在最上面（--app-top-offset），標題列要讓開，不然 ✕ 點不到 */}
        <header className="shrink-0 flex items-center gap-2 px-3 h-14 border-b border-line bg-surface" style={{ paddingTop: 'max(env(safe-area-inset-top), var(--app-top-offset, 0px))', boxSizing: 'content-box' }}>
          <BrandMark />
          <div className="flex-1 min-w-0 leading-tight">
            <p className="text-[15px] font-bold truncate">{ASSISTANT_CHAT_TITLE}</p>
            <p className="text-[11px] text-muted truncate">
              {trip.name}{currentUser ? ` · 我是 ${currentUser}` : ''}{pendingCount > 0 ? ` · ${pendingCount} 張待確認` : ''}
            </p>
          </div>
          {chat.items.length > 0 && (
            <button onClick={clearChat} className={ui.iconBtn} aria-label="清除對話" title="清除這台裝置上的對話紀錄（已存入的支出不受影響）"><Trash2 size={18} /></button>
          )}
          <button onClick={onClose} className={ui.iconBtn} aria-label="關閉"><X size={20} /></button>
        </header>

        {/* 對話 */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 space-y-3">
          {chat.items.length === 0 && (
            <div className="space-y-3">
              <p className="max-w-[88%] rounded-2xl rounded-bl-md bg-surface border border-line px-3.5 py-2 text-[15px] whitespace-pre-wrap">{HELP_TEXT}</p>
              {!readOnly && (
                <div className="flex flex-wrap gap-1.5">
                  {EXAMPLES.map(ex => <button key={ex} onClick={() => send(ex)} className={`${ui.chip} ${ui.chipOff}`}>{ex}</button>)}
                </div>
              )}
            </div>
          )}
          {chat.items.map(item => <div key={item.id} className="flex">{renderItem(item)}</div>)}
          {thinking && (
            <p className="inline-flex items-center gap-2 rounded-2xl bg-surface border border-line px-3.5 py-2 text-sm text-ink-2">
              <Loader2 size={15} className="animate-spin" />
              {slow ? '還在查，再等一下下…' : thinking}
            </p>
          )}
        </div>

        {/* 輸入區 */}
        <footer className="shrink-0 border-t border-line bg-surface px-3 pt-2 pb-[max(10px,env(safe-area-inset-bottom))] space-y-2">
          <div className="flex gap-1.5 overflow-x-auto -mx-3 px-3 no-scrollbar">
            {QUICK_COMMANDS.map(c => (
              <button key={c.key} onClick={() => { addItems([{ id: newId(), at: Date.now(), role: 'user', kind: 'text', text: c.keywords[0] }]); runQuick(c.key); }} className={`${ui.chip} ${ui.chipOff}`}>{c.label}</button>
            ))}
            <button onClick={() => addItems([botText(HELP_TEXT)])} className={`${ui.chip} ${ui.chipOff}`}>❓ 說明</button>
          </div>
          {!currentUser && (
            <button onClick={onPickUser} className="w-full text-left rounded-xl bg-warn/10 text-warn px-3 py-1.5 text-xs">
              先選「我是誰」，記帳時「我付的」才知道是誰 → 點這裡選
            </button>
          )}
          {replyTo && (
            <div className="flex items-center gap-2 rounded-xl bg-sunk px-3 py-1.5 text-xs text-ink-2">
              <CornerUpLeft size={13} className="shrink-0" />
              <span className="flex-1 min-w-0 truncate">回覆「{replyTo.label}」</span>
              <button onClick={() => setReplyTo(null)} aria-label="不回覆這張" className="p-1 -m-1 text-muted hover:text-ink"><X size={14} /></button>
            </div>
          )}
          <div className="flex items-end gap-1.5">
            {!readOnly && (
              <>
                <button onClick={() => fileRef.current?.click()} className={`${ui.iconBtn} shrink-0 w-10 h-10`} aria-label="傳收據照片" title="傳收據或商品照片（可以選好幾張）">
                  <Camera size={21} />
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; sendPhotos(files); }}
                />
              </>
            )}
            <textarea
              ref={inputRef}
              rows={1}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                // 手機上 Enter 換行；電腦上 Enter 送出、Shift+Enter 換行
                if (isSubmitEnter(e) && !e.shiftKey && window.matchMedia('(hover: hover)').matches) {
                  e.preventDefault();
                  send(text);
                }
              }}
              placeholder={replyTo ? '補充或修正這張卡片…' : readOnly ? '問問這趟旅程的帳…' : '記一筆，或問我任何事…'}
              className={`${ui.input} flex-1 resize-none max-h-32 py-2 leading-6`}
              style={{ fieldSizing: 'content' } as React.CSSProperties}
              aria-label="訊息"
            />
            {SpeechRecognitionCtor && !text.trim() ? (
              <button onClick={toggleMic} className={`shrink-0 w-10 h-10 rounded-full inline-flex items-center justify-center transition-colors ${listening ? 'bg-neg text-white animate-pulse' : 'text-ink-2 hover:bg-sunk'}`} aria-label={listening ? '停止語音輸入' : '語音輸入'}>
                <Mic size={20} />
              </button>
            ) : (
              <button
                onClick={() => send(text)}
                disabled={!text.trim() || !!thinking}
                className="shrink-0 w-10 h-10 rounded-full bg-primary text-on-primary inline-flex items-center justify-center disabled:opacity-40 active:scale-95 transition"
                aria-label="送出"
              >
                {thinking ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={20} strokeWidth={2.6} />}
              </button>
            )}
          </div>
        </footer>
      </section>

      {/* 完整表單：草稿存成新的一筆；修改預覽改的是既有那一筆。
          跟 Dashboard 一樣一直掛著、用 isOpen 開關：一掛上就是開的話，開發模式（StrictMode）重跑的
          自動分帳 effect 會拿第一次 render 的 0 元把逐項分好的金額蓋掉 */}
      <ExpenseModal
        isOpen={!!formFor && !!formItem}
        onClose={() => setFormFor(null)}
        trip={trip}
        currentUser={currentUser}
        showToast={showToast}
        editData={formFor?.expense ?? null}
        onSuccess={(savedId) => {
          onChanged();
          if (formItem?.kind === 'draft') {
            patch<DraftItem>(formItem.id, {
              status: 'saved',
              expenseId: savedId ?? undefined,
              resultText: '✅ 已用完整表單存入，內容以帳目裡的為準。',
            });
            remember(`[已存入${refOf(savedId ?? undefined)}] ${formFor?.expense.description ?? ''}（用完整表單存的）`);
          } else if (formItem?.kind === 'update') {
            patch(formItem.id, { status: 'done', resultText: '✏️ 已用表單修改，內容以帳目裡的為準。' });
            remember(`[已修改${refOf(formItem.expenseId)}] ${formItem.existing.description}（用完整表單改的）`);
          }
        }}
      />

      {itemsFor && (
        <FullScreen onClose={() => setItemsFor(null)}>
          <ItemSplitPanel
            trip={trip}
            currency={itemsFor.draft.exp.c}
            total={Number(itemsFor.draft.exp.a) || 0}
            items={itemsFor.draft.items}
            initialOthers={Object.keys(itemsFor.draft.exp.s)}
            payer={Object.keys(itemsFor.draft.exp.p)[0] ?? null}
            onDone={(split) => {
              const cur = findDraft(itemsFor.id) ?? itemsFor;
              changeDraft(cur, { ...cur.draft.exp, s: split });
              const summary = Object.entries(split).map(([m, v]) => `${m} ${formatMoney(v, cur.draft.exp.c, trip.precision_config)}`).join('、');
              addItems([botText(`🧾 照品項分好了：${summary}。確認沒問題就按卡片上的「確認存入」。`)]);
              setItemsFor(null);
            }}
            // 「直接編輯」：跳過指派，打開完整表單自己填每個人的金額
            onSkip={() => {
              const cur = findDraft(itemsFor.id) ?? itemsFor;
              setItemsFor(null);
              setFormFor({ itemId: cur.id, expense: draftToExpense(cur.draft, trip) });
            }}
          />
        </FullScreen>
      )}

      {lightbox && (
        <PhotoLightbox photos={[photoUrl(lightbox)]} index={0} onIndex={() => undefined} onClose={() => setLightbox(null)} alt="收據" />
      )}
    </div>
  );
};

export default ChatPanel;

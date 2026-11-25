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

const HELP_TEXT = `Yoshi! 我是耀西 🥚 在這裡可以：
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
  const [uploading, setUploading] = useState(0);
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
  const readOnly = trip.is_archived;

  // 換旅程時讀那一趟自己的對話
  const [loadedFor, setLoadedFor] = useState(trip.id);
  if (loadedFor !== trip.id) {
    setLoadedFor(trip.id);
    setChat(loadChat(trip.id));
  }
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
  }, [open, itemCount, thinking, uploading]);

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

    setThinking('耀西正在想…');
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
    } catch (e) {
      addItems([botText(`😵 ${e instanceof Error ? e.message : '發生錯誤，請稍後再試。'}`)]);
    } finally {
      setThinking(null);
    }
  };

  const sendPhotos = async (files: File[]) => {
    if (files.length === 0 || readOnly) return;
    setUploading(n => n + files.length);
    // 一張一張來：每張各出一張卡，順序跟選的一樣
    for (const file of files) {
      try {
        const path = await api.uploadChatPhoto(trip.id, file);
        addItems([{ id: newId(), at: Date.now(), role: 'user', kind: 'photo', path }]);
        const reply = await api.sendPhoto({ ...base, photoPath: path });
        update(cur => ({
          items: applyBlocks(cur.items, reply.blocks),
          history: [...cur.history, ...reply.history].slice(-MAX_HISTORY),
        }));
      } catch (e) {
        addItems([botText(`😵 照片沒有傳成功：${e instanceof Error ? e.message : '請再試一次'}`)]);
      } finally {
        setUploading(n => n - 1);
      }
    }
  };

  // ── 卡片上的按鈕 ───────────────────────────────

  const findDraft = (id: string) => chatRef.current.items.find((i): i is DraftItem => i.id === id && i.kind === 'draft');

  const changeDraft = (item: DraftItem, exp: DraftExpense) =>
    patch<DraftItem>(item.id, { draft: { ...item.draft, exp } });

  const saveItem = async (item: DraftItem, exp?: DraftExpense) => {
    const draft = exp ? { ...item.draft, exp } : item.draft;
    setBusyFor(item.id, true);
    try {
      const res = await api.saveDraft({ ...base, draft });
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
    if (item.draft.photoIds.length > 0) {
      try { await api.discardPhotos({ ...base, photoIds: item.draft.photoIds }); } catch { /* 照片留著只佔空間，之後的孤兒清理會收 */ }
    }
  }

  async function undo(item: DraftItem): Promise<string | null> {
    if (!item.expenseId) return null;
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
      setBusyFor(item.id, false);
    }
  }

  const applyUpdateCard = async (item: Extract<ChatItem, { kind: 'update' }>) => {
    setBusyFor(item.id, true);
    try {
      const res = await api.applyUpdate({ ...base, expenseId: item.expenseId, exp: item.exp });
      if (res.ok) { patch(item.id, { status: 'done', resultText: res.text }); remember(`[已修改${refOf(item.expenseId)}] ${item.existing.description}`); onChanged(); }
      else showToast(res.text, 'error');
    } catch (e) {
      showToast(e instanceof Error ? e.message : '修改失敗', 'error');
    } finally {
      setBusyFor(item.id, false);
    }
  };

  const confirmDelete = async (item: Extract<ChatItem, { kind: 'delete' }>) => {
    setBusyFor(item.id, true);
    try {
      const res = await api.deleteExpense({ ...base, expenseId: item.expenseId });
      if (res.ok) { patch(item.id, { status: 'done', resultText: res.text }); remember(`[已刪除${refOf(item.expenseId)}] ${item.existing.description}`); onChanged(); }
      else showToast(res.text, 'error');
    } catch (e) {
      showToast(e instanceof Error ? e.message : '刪除失敗', 'error');
    } finally {
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

  const pendingCount = useMemo(() => chat.items.filter(i => i.kind === 'draft' && i.status === 'pending').length, [chat.items]);

  if (!open) return null;

  const renderItem = (item: ChatItem) => {
    if (item.role === 'user') {
      if (item.kind === 'photo') {
        return (
          <button onClick={() => setLightbox(item.path)} className="ml-auto block w-36 rounded-2xl overflow-hidden border border-line bg-sunk">
            <img src={photoUrl(item.path)} alt="傳出的照片" className="w-full h-36 object-cover" loading="lazy" />
          </button>
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
        aria-label="跟耀西聊天記帳"
        role="dialog"
      >
        {/* 標題列 */}
        <header className="shrink-0 flex items-center gap-2 px-3 h-14 border-b border-line bg-surface" style={{ paddingTop: 'env(safe-area-inset-top)', boxSizing: 'content-box' }}>
          <BrandMark />
          <div className="flex-1 min-w-0 leading-tight">
            <p className="text-[15px] font-bold truncate">耀西記帳</p>
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
          {!currentUser && (
            <button onClick={onPickUser} className={`${ui.warnBox} w-full text-left`}>
              先選「我是誰」，記帳時「我付的」才知道是誰。點這裡選。
            </button>
          )}
          {chat.items.map(item => <div key={item.id} className="flex">{renderItem(item)}</div>)}
          {(thinking || uploading > 0) && (
            <p className="inline-flex items-center gap-2 rounded-2xl bg-surface border border-line px-3.5 py-2 text-sm text-ink-2">
              <Loader2 size={15} className="animate-spin" />
              {uploading > 0 ? `正在看照片${uploading > 1 ? `（還有 ${uploading} 張）` : ''}…` : thinking}
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

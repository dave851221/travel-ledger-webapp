import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import BrandMark from '../components/BrandMark';
import { PRODUCT_NAME } from '../config/mode';

/**
 * 服務條款與隱私權政策（開放版，2026-11-28）。
 * 草稿與討論在 Claude Docs「旅行小本本 服務條款與隱私權政策」；改內容時兩邊一起改，並更新 UPDATED。
 * 內容照網站實際的做法寫：資料放哪、交給哪些服務、怎麼刪除（見 docs/SECURITY.md）。
 */
const UPDATED = '2026-11-28';
const OPERATOR = 'David';
const CONTACT = 'dave851221@gmail.com';

const H2: React.FC<{ children: React.ReactNode }> = ({ children }) => <h2 className="text-lg font-bold mt-8 mb-2">{children}</h2>;
const H3: React.FC<{ children: React.ReactNode }> = ({ children }) => <h3 className="text-[15px] font-bold mt-5 mb-1.5">{children}</h3>;
const P: React.FC<{ children: React.ReactNode }> = ({ children }) => <p className="text-sm leading-relaxed text-ink-2 mb-2">{children}</p>;
const UL: React.FC<{ items: React.ReactNode[] }> = ({ items }) => (
  <ul className="list-disc pl-5 space-y-1 text-sm leading-relaxed text-ink-2 mb-2">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
);
const Table: React.FC<{ head: string[]; rows: string[][] }> = ({ head, rows }) => (
  <div className="overflow-x-auto mb-3">
    <table className="w-full text-sm border border-line rounded-xl overflow-hidden">
      <thead className="bg-sunk"><tr>{head.map(h => <th key={h} className="text-left font-bold px-3 py-2 border-b border-line">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-line last:border-0">{r.map((c, j) => <td key={j} className="px-3 py-2 align-top text-ink-2">{c}</td>)}</tr>)}</tbody>
    </table>
  </div>
);
const Mail = () => <a className="underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>;

const Terms = () => (
  <>
    <H2>服務條款</H2>
    <P>使用{PRODUCT_NAME}（網站與 LINE 官方帳號「旅行喵喵」，以下稱「本服務」），就表示你同意以下條款。</P>
    <H3>1. 本服務是什麼</H3>
    <P>本服務讓一起旅行的人記帳、分帳、結清，並可以透過 AI 小幫手（旅行喵喵）用文字、語音或收據照片記帳。經營者：{OPERATOR}。</P>
    <H3>2. 帳號</H3>
    <UL items={[
      '你用 LINE 或 Google 登入，兩種可以連到同一個帳號。請保管好你的 LINE、Google 帳號。',
      '你可以隨時在「我的帳號」刪除帳號。刪除後，你建立的旅程與照片會一起刪除，無法復原。',
    ]} />
    <H3>3. 你的內容</H3>
    <UL items={[
      '旅程、帳目、照片、行程是你和旅伴的，我們只為了提供服務而保存、處理它們。',
      '成員看得到同一趟旅程的所有帳目與照片。你開了「分享給別人看」，拿到連結的人就看得到那趟旅程（不能修改）；隨時可以關掉或重新產生連結。',
      '請不要上傳違法、侵害他人權利或你沒有權利分享的內容。',
    ]} />
    <H3>4. AI 功能</H3>
    <UL items={[
      '旅行喵喵讀取收據、理解文字與語音可能出錯。存入前都會先給你確認，金額與分帳以你確認的內容為準。',
      '推薦地點、天氣、行程建議只供參考，請自行確認營業時間與交通。',
    ]} />
    <H3>5. 額度與付費</H3>
    <UL items={[
      '每趟旅程有記帳筆數、AI 次數、照片張數的上限，數字以網站上顯示的為準。達到上限只是不能再新增，已有的資料不會被刪除。',
      '付費解鎖與加購開放後，價格、付款方式與退款規則會另外公告。',
    ]} />
    <H3>6. 不可以做的事</H3>
    <UL items={[
      '用程式大量呼叫、刷 AI 額度、試圖讀取不屬於你的旅程。',
      '把本服務用在詐騙、騷擾或其他違法用途。',
    ]} />
    <P>違反時，我們可以暫停該旅程的 AI 功能或停用帳號。</P>
    <H3>7. 服務變動與責任</H3>
    <UL items={[
      '我們會盡力維持服務穩定，但可能因為維護、第三方服務（LINE、Google、雲端主機）故障而暫時無法使用。',
      '分帳結果是依你們輸入的資料計算的，實際付款前請自行確認。在法律允許的範圍內，我們不負責因使用本服務產生的間接損失。',
      '我們可能修改本條款；重大修改會在網站上公告。',
    ]} />
    <H3>8. 準據法</H3>
    <P>本條款以中華民國（台灣）法律為準據法，以臺灣臺北地方法院為第一審管轄法院。</P>
  </>
);

const Privacy = () => (
  <>
    <H2>隱私權政策</H2>
    <P>我們只收集記帳需要的資料，不賣資料、不放廣告追蹤。</P>
    <H3>1. 我們收集什麼</H3>
    <Table head={['資料', '來源', '用途']} rows={[
      ['LINE 或 Google 的顯示名稱、email、帳號 ID', '你登入時由 LINE／Google 提供', '登入、辨認是哪個成員'],
      ['旅程、成員名字、帳目、分帳、行程試算表連結', '你和旅伴輸入', '記帳、結算、顯示行程'],
      ['收據與商品照片', '你上傳（網站或 LINE）', '讀取金額、相簿、回顧影片'],
      ['和旅行喵喵的對話、語音', '你在 LINE 或網站傳的訊息', '記帳、回答問題'],
      ['AI 使用次數', '系統記錄', '計算額度、防止濫用'],
    ]} />
    <P>我們不收集你的密碼（登入由 LINE／Google 處理），也不收集信用卡號。</P>
    <H3>2. 資料放在哪裡、交給誰處理</H3>
    <Table head={['服務', '處理什麼', '地點']} rows={[
      ['Supabase', '帳號、旅程、帳目資料庫', '澳洲雪梨'],
      ['Cloudflare', '網站、照片（私有空間，只有成員或分享連結能看）', '全球'],
      ['LINE', '登入、官方帳號訊息', '日本／台灣'],
      ['Google', '登入、Gemini AI（收據辨識、語音轉文字、對話）、Google 地圖、你自己連結的試算表', '全球'],
      ['Anthropic', 'Claude AI（對話、收據辨識）', '美國'],
    ]} />
    <P>交給 AI 的只有當次需要的內容（這張收據、這句話、這趟旅程的成員與近期帳目）。語音轉文字目前使用 Google 的免費方案，內容可能被 Google 用來改善其產品；不想這樣的話，請用打字記帳。</P>
    <H3>3. 保存與刪除</H3>
    <UL items={[
      '刪除的帳目先放垃圾桶 24 小時，之後永久刪除，照片一起刪。',
      '刪除旅程：帳目、照片、成員資料一起刪除。',
      '刪除帳號：你建立的旅程一起刪除；你參加別人的旅程，帳目上你的名字會留著（那是大家的帳）。',
      'LINE 的對話紀錄只留記帳需要的最近幾輪；網站上的對話只存在你自己的手機。',
    ]} />
    <H3>4. 你的權利</H3>
    <P>你可以隨時查看、修改、匯出（CSV）、刪除你的資料與帳號。其他個資相關的請求（例如要求列出我們保存的資料），請寄信到 <Mail />，我們會在 30 天內回覆。</P>
    <H3>5. 瀏覽器裡存的東西</H3>
    <P>網站會在你的瀏覽器存登入狀態、旅程快取（離線也看得到）、對話紀錄與偏好設定。登出時會清掉屬於你帳號的部分。我們沒有使用廣告或第三方追蹤 cookie。</P>
    <H3>6. 未成年人</H3>
    <P>未滿 18 歲請在法定代理人同意下使用，付費功能需由法定代理人操作。</P>
    <H3>7. 政策更新與聯絡</H3>
    <P>本政策更新時會在網站上公告並更新日期。問題請寄到 <Mail />。</P>
  </>
);

/** #/terms 與 #/privacy：同一頁，依網址捲到對應的段落（不用登入就能看） */
const Legal: React.FC<{ section: 'terms' | 'privacy' }> = ({ section }) => {
  useEffect(() => {
    document.title = `${section === 'terms' ? '服務條款' : '隱私權政策'} · ${PRODUCT_NAME}`;
    document.getElementById(section)?.scrollIntoView();
  }, [section]);

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <main className="w-full max-w-2xl mx-auto px-4 sm:px-6 pt-[max(16px,env(safe-area-inset-top))] pb-16">
        <header className="flex items-center gap-2.5 py-3">
          <Link to="/" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"><ArrowLeft size={16} />回首頁</Link>
          <span className="ml-auto inline-flex items-center gap-2 font-bold"><BrandMark size={26} />{PRODUCT_NAME}</span>
        </header>
        <p className="text-xs text-muted mt-2">最後更新：{UPDATED}・經營者：{OPERATOR}・聯絡：<Mail /></p>
        <nav className="flex gap-2 mt-3">
          <Link to="/terms" className={`rounded-full px-3 py-1 text-sm border ${section === 'terms' ? 'border-ink font-bold' : 'border-line text-ink-2'}`}>服務條款</Link>
          <Link to="/privacy" className={`rounded-full px-3 py-1 text-sm border ${section === 'privacy' ? 'border-ink font-bold' : 'border-line text-ink-2'}`}>隱私權政策</Link>
        </nav>
        <section id="terms" className="bg-surface border border-line rounded-2xl px-5 py-2 mt-4 scroll-mt-4"><Terms /></section>
        <section id="privacy" className="bg-surface border border-line rounded-2xl px-5 py-2 mt-4 scroll-mt-4"><Privacy /></section>
      </main>
    </div>
  );
};

export default Legal;

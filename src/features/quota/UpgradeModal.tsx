import React from 'react';
import { Check, Sparkles } from 'lucide-react';
import Modal from '../../components/Modal';
import { ui } from '../../components/ui';
import MascotArt from '../../components/MascotArt';

/**
 * 升級（免費 → 解鎖）／加購（解鎖後再加額度）。
 * 付款（綠界）還沒接上：先把方案講清楚，付款按鈕顯示「即將開放」。
 * 數字跟資料庫 app.plan_limits 的預設一致；之後接付款時改成從伺服器讀。
 */
const PLANS = [
  { key: 'free', name: '免費旅程', price: 'NT$0', items: ['記帳 50 筆', 'AI 記帳 15 次', '照片 15 張'] },
  { key: 'paid', name: '解鎖旅程', price: 'NT$99／趟', items: ['記帳 600 筆', 'AI 記帳 300 次', '照片 300 張', '一人付，全團一起用'] },
];

const UpgradeModal: React.FC<{ isOpen: boolean; onClose: () => void; paid: boolean }> = ({ isOpen, onClose, paid }) => (
  <Modal isOpen={isOpen} onClose={onClose} title={paid ? '加購額度' : '升級旅程'}>
    <div className="space-y-4">
      <MascotArt slot="upgrade" width={140} className="mx-auto" />
      {paid ? (
        <div className={`${ui.card} p-4 space-y-1`}>
          <p className="font-bold">加購包</p>
          <p className="text-sm text-ink-2">這趟用完了還想繼續記，可以再加購記帳筆數、AI 次數與照片，沒有期限。</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {PLANS.map(p => (
            <div key={p.key} className={`rounded-2xl border p-3 space-y-2 ${p.key === 'paid' ? 'border-accent bg-accent/5' : 'border-line'}`}>
              <p className="font-bold text-sm">{p.name}</p>
              <p className="num font-extrabold">{p.price}</p>
              <ul className="space-y-1">
                {p.items.map(i => (
                  <li key={i} className="flex items-start gap-1 text-xs text-ink-2"><Check size={13} className="shrink-0 mt-0.5 text-pos" />{i}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted">不限時間，用量用完才需要升級或加購。</p>
      <button type="button" disabled className={`${ui.btnAccent} w-full`}>
        <Sparkles size={16} />線上付款即將開放
      </button>
    </div>
  </Modal>
);

export default UpgradeModal;

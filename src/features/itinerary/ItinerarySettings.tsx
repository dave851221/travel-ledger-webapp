import React, { useState } from 'react';
import { Check, ExternalLink, Loader2, Replace, Unlink } from 'lucide-react';
import { supabase } from '../../api/supabase';
import Modal from '../../components/Modal';
import ConfirmDialog from '../../components/ConfirmDialog';
import { ui } from '../../components/ui';
import type { Trip } from '../../types';
import { STYLE_KEYS, STYLES, THEME_KEYS, THEMES, type StyleKey, type ThemeKey } from './themes';
import { sheetEditUrl } from './sheet';

/**
 * 行程設定（只有建立者、管理員看得到入口；資料庫的 trips_guard_update 也會擋）：
 * 色系、呈現方式、試算表（換一份、取消連結）。
 * 取消連結收在這裡、而且要再確認一次（David 2026-11-28：放在頁面上容易誤按）。
 */
const ItinerarySettings: React.FC<{
  trip: Trip;
  isOpen: boolean;
  onClose: () => void;
  onChanged: () => void;
  /** 目前的色系與呈現方式（行程本身的預設，或這趟存的） */
  theme: ThemeKey;
  style: StyleKey;
  /** 有連試算表時才有：換一份（回到貼連結的畫面） */
  onChangeSheet?: () => void;
}> = ({ trip, isOpen, onClose, onChanged, theme, style, onChangeSheet }) => {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const save = async (patch: Partial<Pick<Trip, 'itinerary_color' | 'itinerary_style' | 'itinerary_sheet'>>, key: string) => {
    setSaving(key);
    setError(null);
    const { error: err } = await supabase.from('trips').update(patch).eq('id', trip.id);
    setSaving(null);
    if (err) { setError(err.message.includes('not_admin') ? '只有建立者或管理員可以改行程設定' : '存檔失敗，請再試一次'); return false; }
    onChanged();
    return true;
  };

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title="行程設定" maxWidth="max-w-xl">
        <div className="space-y-6">
          <section className="space-y-2.5">
            <h3 className="text-sm font-bold">色系</h3>
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
              {THEME_KEYS.map(k => {
                const on = k === theme;
                const [a, b] = THEMES[k].swatch;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => !on && save({ itinerary_color: k }, `c-${k}`)}
                    aria-pressed={on}
                    className={`group flex flex-col items-center gap-1 rounded-xl p-1.5 transition-colors ${on ? 'bg-sunk ring-2 ring-ink' : 'hover:bg-sunk'}`}
                  >
                    <span className="relative w-full aspect-[4/3] rounded-lg" style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}>
                      {(on || saving === `c-${k}`) && (
                        <span className="absolute inset-0 flex items-center justify-center text-white">
                          {saving === `c-${k}` ? <Loader2 size={16} className="animate-spin" /> : <Check size={18} strokeWidth={3} />}
                        </span>
                      )}
                    </span>
                    <span className="text-[11px] text-ink-2">{THEMES[k].label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="space-y-2.5">
            <h3 className="text-sm font-bold">呈現方式</h3>
            <div className="grid grid-cols-2 gap-2">
              {STYLE_KEYS.map(k => {
                const on = k === style;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => !on && save({ itinerary_style: k }, `s-${k}`)}
                    aria-pressed={on}
                    className={`text-left rounded-xl border px-3 py-2.5 transition-colors ${on ? 'border-ink bg-sunk' : 'border-line hover:bg-sunk'}`}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-bold">
                      {STYLES[k].label}
                      {saving === `s-${k}` ? <Loader2 size={13} className="animate-spin" /> : on && <Check size={14} strokeWidth={3} />}
                    </span>
                    <span className="block text-xs text-muted mt-0.5">{STYLES[k].hint}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {trip.itinerary_sheet && (
            <section className="space-y-2.5">
              <h3 className="text-sm font-bold">Google 試算表</h3>
              <div className="flex flex-wrap gap-2">
                <a href={sheetEditUrl(trip.itinerary_sheet)} target="_blank" rel="noopener noreferrer" className={`${ui.btnSecondary} h-9 py-0`}>
                  <ExternalLink size={14} />打開試算表
                </a>
                {onChangeSheet && (
                  <button type="button" onClick={() => { onClose(); onChangeSheet(); }} className={`${ui.btnSecondary} h-9 py-0`}>
                    <Replace size={14} />換一份試算表
                  </button>
                )}
              </div>
              <button type="button" onClick={() => setConfirmUnlink(true)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-neg pt-1">
                <Unlink size={12} />取消連結這份試算表
              </button>
            </section>
          )}

          {error && <p className="text-sm text-neg">{error}</p>}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={confirmUnlink}
        onClose={() => setConfirmUnlink(false)}
        onConfirm={async () => {
          if (await save({ itinerary_sheet: null }, 'unlink')) { setConfirmUnlink(false); onClose(); }
        }}
        title="取消連結試算表"
        icon={<Unlink size={20} />}
        heading="這趟不再顯示這份試算表的行程？"
        description="試算表本身不會被刪除，之後隨時可以再連結回來。"
        confirmLabel="取消連結"
        cancelLabel="先不要"
      />
    </>
  );
};

export default ItinerarySettings;

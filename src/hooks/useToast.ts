import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastType = 'success' | 'error';

export interface ToastState {
  message: string;
  type: ToastType;
}

const TOAST_DURATION_MS = 2500;

/**
 * 短暫的提示訊息。
 *
 * 專案禁止使用原生 alert()，通知一律走這裡、確認動作走 ConfirmDialog。
 */
export const useToast = () => {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, type });
    timerRef.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }, []);

  // 元件卸載時清掉計時器，避免在已卸載的元件上 setState
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { toast, showToast };
};

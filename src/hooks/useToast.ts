import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastType = 'success' | 'error';

/** An optional button on the toast, e.g. "還原" right after a delete. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastState {
  message: string;
  type: ToastType;
  action?: ToastAction;
}

const TOAST_DURATION_MS = 2500;
/** Errors and toasts with a button stay longer: there is something to read or to press. */
const TOAST_LONG_DURATION_MS = 5000;
/** A plain message longer than this also gets the long duration. */
const LONG_MESSAGE_LENGTH = 18;

/**
 * 短暫的提示訊息。
 *
 * 專案禁止使用原生 alert()，通知一律走這裡、確認動作走 ConfirmDialog。
 */
export const useToast = () => {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissToast = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast(null);
  }, []);

  const showToast = useCallback((message: string, type: ToastType = 'success', action?: ToastAction) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, type, action });
    const long = type === 'error' || !!action || message.length > LONG_MESSAGE_LENGTH;
    timerRef.current = setTimeout(() => setToast(null), long ? TOAST_LONG_DURATION_MS : TOAST_DURATION_MS);
  }, []);

  // 元件卸載時清掉計時器，避免在已卸載的元件上 setState
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { toast, showToast, dismissToast };
};

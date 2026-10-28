/**
 * Shared class strings for form controls and buttons.
 *
 * Tailwind only generates classes it can find as complete strings in the
 * source, so these are spelled out in full rather than composed.
 * Inputs are 16px on phones: anything smaller makes iOS Safari zoom in on focus.
 */
export const ui = {
  label: 'block text-xs font-medium text-ink-2 mb-1.5',
  hint: 'text-xs text-muted',
  input:
    'w-full px-3.5 py-2.5 rounded-xl bg-surface border border-line text-ink text-base sm:text-sm outline-none transition placeholder:text-muted focus:border-ink-2 focus:ring-4 focus:ring-accent/20 disabled:opacity-60',
  select:
    'w-full px-3.5 py-2.5 rounded-xl bg-surface border border-line text-ink text-base sm:text-sm outline-none transition focus:border-ink-2 focus:ring-4 focus:ring-accent/20',
  btnPrimary:
    'inline-flex items-center justify-center gap-2 rounded-xl bg-primary text-on-primary font-bold px-4 py-2.5 text-sm transition hover:opacity-90 active:scale-[.98] disabled:opacity-40 disabled:active:scale-100',
  btnAccent:
    'inline-flex items-center justify-center gap-2 rounded-xl bg-accent text-on-accent font-bold px-4 py-2.5 text-sm transition hover:brightness-105 active:scale-[.98] disabled:opacity-40',
  btnSecondary:
    'inline-flex items-center justify-center gap-2 rounded-xl bg-surface border border-line text-ink font-medium px-4 py-2.5 text-sm transition hover:bg-sunk active:scale-[.98] disabled:opacity-40',
  btnDanger:
    'inline-flex items-center justify-center gap-2 rounded-xl bg-neg/10 text-neg font-bold px-4 py-2.5 text-sm transition hover:bg-neg hover:text-white active:scale-[.98] disabled:opacity-40',
  iconBtn:
    'inline-flex items-center justify-center w-9 h-9 rounded-xl text-ink-2 hover:text-ink hover:bg-sunk transition-colors',
  card: 'bg-surface border border-line rounded-2xl',
  chip: 'shrink-0 px-3 py-1.5 rounded-full text-xs border transition-colors whitespace-nowrap',
  chipOn: 'bg-primary border-primary text-on-primary font-medium',
  chipOff: 'bg-surface border-line text-ink-2 hover:text-ink',
  errorBox: 'flex items-start gap-2 rounded-xl bg-neg/10 text-neg px-3 py-2.5 text-sm',
  warnBox: 'flex items-start gap-2.5 rounded-xl bg-warn/10 text-warn px-3.5 py-3 text-sm',
} as const;

import React from 'react';
import type { Note, Place } from './types';
import { linkPlaceNames, parseRichText } from './plan';

const LINK_CLASS = 'text-[var(--t-accent)] underline decoration-[color-mix(in_srgb,var(--t-accent)_40%,transparent)] decoration-1 underline-offset-[3px] hover:decoration-2';

/**
 * Renders `[label](url)` links and `**bold**` inside itinerary text.
 * With `places`, any place name that appears in the plain text becomes a map link too.
 */
export const RichText: React.FC<{ text: string; places?: Place[] }> = ({ text, places }) => (
  <>
    {linkPlaceNames(parseRichText(text), places ?? []).map((seg, i) => {
      if (seg.type === 'link') {
        return (
          <a key={i} href={seg.href} target="_blank" rel="noreferrer" className={LINK_CLASS} onClick={e => e.stopPropagation()}>
            {seg.text}
          </a>
        );
      }
      if (seg.type === 'bold') return <strong key={i} className="font-bold text-ink">{seg.text}</strong>;
      return <React.Fragment key={i}>{seg.text}</React.Fragment>;
    })}
  </>
);

const TONE_CLASS = {
  warn: 'text-neg font-medium',
  tip: 'text-[var(--t-accent)] font-medium',
  muted: 'text-muted',
} as const;

/** A note list; nested items indent one level and use a smaller bullet. */
export const NoteList: React.FC<{ notes: Note[]; depth?: number }> = ({ notes, depth = 0 }) => (
  <ul className={`space-y-1 ${depth > 0 ? 'mt-1 ml-3.5' : ''}`}>
    {notes.map((note, i) => {
      const n = typeof note === 'string' ? { text: note } : note;
      return (
        <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-ink-2">
          <span
            className={`shrink-0 mt-[8px] rounded-full ${depth > 0 ? 'w-1 h-1 bg-muted/60' : 'w-1.5 h-1.5'} ${
              n.tone === 'warn' ? 'bg-neg' : n.tone === 'tip' ? 'bg-[var(--t-accent)]' : depth > 0 ? '' : 'bg-muted/70'
            }`}
            aria-hidden
          />
          <div className="min-w-0">
            <span className={n.tone ? TONE_CLASS[n.tone] : ''}>
              {n.tone === 'warn' && <span className="sr-only">注意：</span>}
              <RichText text={n.text} />
            </span>
            {n.items && n.items.length > 0 && <NoteList notes={n.items} depth={depth + 1} />}
          </div>
        </li>
      );
    })}
  </ul>
);

import React from 'react';

const TINTS = ['#4a6fc0', '#2e9a80', '#8a68c4', '#d9822b', '#c2527a', '#3f9aa6'];

const hashName = (name: string) => name.split('').reduce((a, c) => a + c.charCodeAt(0), 0);

/** First character of a member's name in a round tile. "Me" is drawn solid. */
const MemberAvatar: React.FC<{ name: string; size?: number; isMe?: boolean; ring?: boolean }> = ({
  name,
  size = 30,
  isMe = false,
  ring = false,
}) => {
  const tint = TINTS[hashName(name) % TINTS.length];
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-bold shrink-0 select-none ${
        isMe ? 'bg-primary text-on-primary' : ''
      } ${ring ? 'ring-2 ring-canvas' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        ...(isMe ? {} : { background: `color-mix(in srgb, ${tint} 18%, transparent)`, color: tint }),
      }}
      aria-hidden
    >
      {name.slice(0, 1)}
    </span>
  );
};

export default MemberAvatar;

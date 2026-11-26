import React, { createContext, useContext } from 'react';

// 8 個彼此分得開的顏色。一趟旅程依成員順序輪著用，8 人以內一定不重複。
const TINTS = ['#4a6fc0', '#2e9a80', '#c2527a', '#d9822b', '#8a68c4', '#3f9aa6', '#7a8b2e', '#b5603b'];

const hashName = (name: string) => name.split('').reduce((a, c) => a + c.charCodeAt(0), 0);

/**
 * 這趟旅程的成員順序。以前顏色由名字的字碼加總決定，不同的名字常常撞到同一色
 * （「代均」和「爸爸」一樣紅）；有成員清單時改依順序配色，8 人以內保證不同。
 * Dashboard 與邀請頁用 MemberColorProvider 包起來；沒有包的地方退回舊的雜湊。
 */
const MemberOrderContext = createContext<string[] | null>(null);

export const MemberColorProvider: React.FC<{ members: string[]; children: React.ReactNode }> = ({ members, children }) => (
  <MemberOrderContext.Provider value={members}>{children}</MemberOrderContext.Provider>
);

/** 成員的代表色 */
function memberTint(name: string, members: string[] | null): string {
  const i = members ? members.indexOf(name) : -1;
  return TINTS[(i >= 0 ? i : hashName(name)) % TINTS.length];
}

/** First character of a member's name in a round tile. "Me" is drawn solid. */
const MemberAvatar: React.FC<{ name: string; size?: number; isMe?: boolean; ring?: boolean }> = ({
  name,
  size = 30,
  isMe = false,
  ring = false,
}) => {
  const tint = memberTint(name, useContext(MemberOrderContext));
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

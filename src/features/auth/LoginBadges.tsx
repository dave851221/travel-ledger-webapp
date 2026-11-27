import React from 'react';

import { type LoginInfo, providerLabel } from './loginInfo';

/** 「LINE · 張小明」「Google · 王小美 · d***1@gmail.com」：看得出是誰、用什麼登入 */
const LoginBadges: React.FC<{ logins: LoginInfo[] }> = ({ logins }) => (
  // 一種登入方式一行；名稱和帳號放不下時換行，不截斷（要看得出是誰）
  <span className="flex flex-col gap-0.5 mt-0.5">
    {logins.length === 0 && <span className="text-[11px] text-muted">其他方式登入</span>}
    {logins.map((l, i) => (
      <span key={i} className="flex flex-wrap items-center gap-x-1 text-[11px] leading-4 text-muted min-w-0">
        <span className={`shrink-0 rounded px-1 font-bold ${l.provider === 'line' ? 'text-pos bg-pos/10' : 'text-ink-2 bg-sunk'}`}>
          {providerLabel(l.provider)}
        </span>
        {l.name && <span className="[overflow-wrap:anywhere]">{l.name}</span>}
        {l.account && <span className="[overflow-wrap:anywhere]">{l.account}</span>}
      </span>
    ))}
  </span>
);

export default LoginBadges;

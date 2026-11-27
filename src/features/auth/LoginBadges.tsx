import React from 'react';

import { type LoginInfo, providerLabel } from './loginInfo';

/**
 * 「LINE｜張小明」「Google｜王小美 d***1@gmail.com」：看得出是誰、用什麼登入。
 * 跟「我的帳號」的登入方式同一套排法：標籤同寬、名稱對齊同一欄；放不下時在自己那一欄換行，不截斷（要看得出是誰）。
 */
const LoginBadges: React.FC<{ logins: LoginInfo[] }> = ({ logins }) => (
  <span className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1 mt-1">
    {logins.length === 0 && <span className="col-span-2 text-[11px] text-muted">其他方式登入</span>}
    {logins.map((l, i) => (
      <React.Fragment key={i}>
        <span className={`text-center rounded-md py-0.5 text-[10px] font-bold leading-4 ${l.provider === 'line' ? 'text-pos bg-pos/10' : 'text-ink-2 bg-sunk'}`}>
          {providerLabel(l.provider)}
        </span>
        <span className="text-[11px] leading-5 text-muted [overflow-wrap:anywhere]">
          {l.name && <span className="text-ink-2">{l.name}</span>}
          {l.name && l.account && <span className="mx-1 text-line">｜</span>}
          {l.account}
          {!l.name && !l.account && (l.provider === 'line' ? 'LINE 帳號' : 'Google 帳號')}
        </span>
      </React.Fragment>
    ))}
  </span>
);

export default LoginBadges;

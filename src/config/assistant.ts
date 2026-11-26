/**
 * 網頁上機器人的名字（只有這一份）：舊版是「耀西」，開放版是「旅行喵喵」（src/config/mode.ts）。
 * 後端 prompt 裡的名字在 supabase/functions/_shared/assistant/persona.ts，兩邊一起改。
 */
import { IS_PUBLIC } from './mode';

export const ASSISTANT_NAME = IS_PUBLIC ? '旅行喵喵' : '耀西';
export const ASSISTANT_CATCHPHRASE = IS_PUBLIC ? '喵～' : 'Yoshi!';
export const ASSISTANT_EMOJI = IS_PUBLIC ? '🐱' : '🥚';
/** 入口按鈕與聊天室標題 */
export const ASSISTANT_CHAT_TITLE = `${ASSISTANT_NAME}記帳`;

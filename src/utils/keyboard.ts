/**
 * 使用者是否「真的」按下 Enter 要送出。
 *
 * 注音、倉頡等輸入法在選字時按 Enter 也會觸發 keydown，
 * 不排除的話打「拉麵」選完字就被當成送出，只剩半截的內容。
 * `keyCode === 229` 是舊版 Safari 在組字期間回報的值（它不一定帶 isComposing）。
 */
export const isSubmitEnter = (e: {
  key: string;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}): boolean =>
  e.key === 'Enter' && !e.nativeEvent?.isComposing && e.keyCode !== 229;

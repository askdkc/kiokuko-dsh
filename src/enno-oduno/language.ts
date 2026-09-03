import type { UserFacingLanguage } from './types.js';

const JAPANESE_SCRIPT = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Select the bounded presentation language from the original user task. */
export function userFacingLanguageForTask(task: string): UserFacingLanguage {
  return JAPANESE_SCRIPT.test(task) ? 'ja' : 'en';
}

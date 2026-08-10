// ニュースパネルの「時間外も取得」トグル(#news-offhours-toggle)。
//
// ★なぜ 🎛️(詳細設定)ではなくニュースパネルに置くか:
//   詳細設定の右カラム(#params-col2)は lite で丸ごと隠れる枠で、この設定は **lite でも操作できる
//   必要がある**(ユーザー指示)。params-col2 を lite で出すと、そこに同居している他の項目まで
//   lite に露出してしまう。ニュースパネルは lite/full で同一(web/lib/variantLiteNews.test.ts)なので、
//   この設定だけを両方の版で見せられる唯一の素直な置き場所になる。
//
// ★保存は「変えた瞬間に1回」。詳細設定のような「保存」ボタンが無い場所なので、
//   押し忘れで効いていないという無言の失敗を作らないため。失敗したら **元に戻して理由を出す**
//   (画面のチェックだけ入って実際は保存されていない、という状態を残さない)。
//
// jsdom を入れていないので、DOM そのものではなく最小インターフェース越しに書く(web/lib/variant.ts と同じ流儀)。

// チェックボックスの最小面。
export interface CheckboxLike {
  checked: boolean;
  disabled: boolean;
  addEventListener(type: 'change', handler: () => void): void;
}
// 状態表示(小さな文字)の最小面。
export interface TextLike { textContent: string | null }

export interface NewsOffHoursDeps {
  /** /api/settings を読む。失敗は throw してよい。 */
  fetchSettings: () => Promise<Record<string, unknown>>;
  /** /api/settings/keys へ 1 項目だけ保存する。保存できたら true。 */
  saveEnabled: (enabled: boolean) => Promise<boolean>;
}

/** 設定応答から「時間外も取得」の実効値を読む(純関数)。
 *  ★未設定・非boolean・取得失敗は **false = 現行挙動**。既定を ON 側に倒さない。 */
export function offHoursEnabledFrom(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false;
  return (settings as Record<string, unknown>).newsOffHoursEnabled === true;
}

/** トグルを現在の設定に合わせて初期化し、変更時に保存する配線を張る。 */
export async function initNewsOffHoursToggle(
  cb: CheckboxLike | null,
  status: TextLike | null,
  deps: NewsOffHoursDeps,
): Promise<void> {
  if (!cb) return;
  const say = (msg: string): void => { if (status) status.textContent = msg; };

  try {
    cb.checked = offHoursEnabledFrom(await deps.fetchSettings());
  } catch {
    cb.checked = false;   // 取得失敗は既定(OFF)側で表示する=実際の server 既定と一致する
    say('設定を読めませんでした');
  }

  cb.addEventListener('change', () => {
    const want = cb.checked;
    cb.disabled = true;
    say('保存中…');
    void deps.saveEnabled(want)
      .then(ok => {
        if (ok) { say(want ? '時間外も取得します(15分間隔)' : ''); return; }
        cb.checked = !want;   // ★保存できていないのにチェックだけ残さない
        say('保存に失敗しました');
      })
      .catch(() => { cb.checked = !want; say('保存に失敗しました'); })
      .finally(() => { cb.disabled = false; });
  });
}

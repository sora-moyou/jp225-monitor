// ─── エラー本文から秘密(APIキー)を落とす ────────────────────────────────
//
// ★なぜ独立モジュールか: これまで modelCheck.ts に置いていたが、providers.ts の
//   **ログ整形**でも同じ規則が要る。providers.ts ← modelCheck.ts の依存が既にあるため、
//   modelCheck から import すると循環になる。秘密を落とす規則は1か所(SSOT)でなければ
//   「片方だけ伏字が漏れる」が起きるので、依存の無い葉モジュールに置く。
//   modelCheck.ts は従来どおり redactSecrets を再エクスポートする(既存の import 先は不変)。

/** 伏せた跡。**残す**こと(何かを消したという事実は診断に要る)。 */
const MASK = '<キー伏字>';

/** キーらしき文字列の並び(接頭辞の後ろ)。実キーは英数字が主で、
 *  エコーバック時の伏字(`sk-proj-****…Y9EA`)を拾うため `*` と区切りも許す。 */
const TAIL = '[A-Za-z0-9*_-]{6,}';

// ─── 左境界の扱い(実測に基づく) ────────────────────────────────────────
//
// 旧実装は `\b(sk|gsk|…)` で、**直前が単語文字だと伏字が効かない**穴があった
// (`key:gsk_…` は伏せるが `xxgsk_…` は伏せない)。ログを 60→240 字に広げた以上、
// 広げた側で塞ぐべき穴である。
//
// ★案A「`\b` → `(?<![A-Za-z0-9])`」では **穴は塞がらない**(実測。redact.test.ts に固定):
//   `\b` も `(?<![A-Za-z0-9])` も「直前が英数字なら不一致」で、差は**直前が `_` の時だけ**。
//   `xxgsk_…` / `Xsk-proj-…` / `1AIzaSy…` はどちらでも漏れたままになる。
//
// ★案B「左境界を一律に撤去」だと穴は塞がるが、裸の `sk-` が
//   英単語に衝突して**伏せてはいけないものまで伏せる**:
//     task-manager-restart → ta<キー伏字>      (task の "sk" + "-manager-restart")
//     risk-free-rate       → ri<キー伏字>
//     disk-usage-warning   → di<キー伏字>
// 伏字の誤爆は「診断値が黙って消える」= 今回直したばかりの欠陥の再発なので、採らない。
//
// そこで **接頭辞ごとに左境界の扱いを変える**(案A/案Bの実測は redact.test.ts に固定):
//   (1) `gsk` / `sk-proj` / `sk-ant` / `AIza` … 英単語・モデル名・URL に現れ得ない並び。
//       → 左境界を要求しない(語中に接着していても拾う)。
//       ・"gsk" で終わる英単語は無い。
//       ・`sk-proj[-_]` / `sk-ant[-_]` は区切りまで含めた形で見るので "risk-projection"
//         ("proj" の直後が区切りでない)には当たらない。
//       ・"AIza" は Google キー固有の並び。
//   (2) 裸の `sk[-_]` … task/risk/disk/mask/kiosk 等と機械的に区別できない。
//       → 従来どおり `\b`(語頭)を要求する。**旧挙動をそのまま残す**ので取りこぼしは増えない。
//
// ★既知の未カバー(意図的): **語中に接着した裸の `sk-`/`sk_`**(旧式 OpenAI キー `sk-`+英数字)は
//   素通しする。一度は「大文字と数字を両方含む時だけ拾う」規則(3)を置いたが、実測で
//     ・小文字だけの旧式キーが接着した形は**依然として素通し**(=穴を塞ぎきれていない)
//     ・その一方で `task-queue-Worker3` / `risk-adjusted-Return2024` / `disk-Usage2024` などを伏せる
//   となり、**誤爆だけ残って狙った穴は塞げていない**形だった。伏字の誤爆は「診断値が黙って
//   消える」= 今回直したばかりの欠陥の再発なので、規則(3)は落とした。
//   いま実際に使うプロバイダのキー形式(`gsk_` / `sk-proj-` / `sk-ant-` / `AIza`)は
//   すべて規則(1)が左境界なしで捕まえるため、この未カバーで実キーが漏れる経路は無い。
const KEY_PATTERNS: readonly RegExp[] = [
  // (1) 接頭辞が固有: 左境界を要求しない
  new RegExp(`(?:gsk|sk-proj|sk-ant)[-_]${TAIL}`, 'g'),
  new RegExp(`AIza${TAIL}`, 'g'),
  // (2) 裸の sk-/sk_ は語頭のみ(旧挙動の保存)
  new RegExp(`\\bsk[-_]${TAIL}`, 'g'),
];

/** ★エラー本文に API キーらしき文字列が混ざっていたら伏せる。
 *  実測: OpenAI の 401 は `Incorrect API key provided: sk-proj-****…Y9EA` のように
 *  自分のキーを(一部伏せて)エコーバックしてくる。設定画面にそのまま出す必要はないので、
 *  こちらで確実に落としてから返す(画面・ログ・スクショのどれにも残さない)。
 *
 *  ★呼ぶ側の順序: **伏せてから切る**こと(providers.ts の formatErrForLog 参照)。
 *    先に切ると、断片が最小長を割って伏字に掛からなくなる。 */
export function redactSecrets(msg: string): string {
  let out = msg;
  for (const re of KEY_PATTERNS) out = out.replace(re, MASK);
  return out;
}

/** V8 の JSON.parse 失敗メッセージは **入力(=モデルの生出力)の断片を引用符で埋め込む**。
 *  実測(Node 24)の4形:
 *    Unexpected token 'X', "<先頭>"... is not valid JSON
 *    Unexpected token 'X', ..."<中間>"... is not valid JSON      ← 稼働機で観測された形
 *    Unexpected token 'X', ..."<末尾>" is not valid JSON
 *    Unexpected token 'X', "<全体>" is not valid JSON
 *
 *  ★なぜ落とすか(秘密の話であって、単なるノイズ除去ではない):
 *    scalp-plan のプロンプトには describeExitLogic() が **非公開の決済ロジックの実数値** を
 *    実行時注入しており、モデルは根拠文の中でその数値を言い直すことがある。
 *    パースに失敗した回の30字窓がその数値を含む可能性は否定できず、この断片は
 *    ログ(server.log)にも、scalp-plan の HTTP 応答経由で同期フォルダ(chrono_kabu.log)にも出る。
 *    秤: 失うのはパース失敗時の30字の文脈(失敗した事実と例外の種類は残る)/
 *        避けるのは非公開の数値が同期フォルダに載ること(**気づく手段が無い**)。後者を取る。
 *
 *  ★4形すべてに共通する `" is not valid JSON` を終端アンカーにして、**引用符の中身だけ**を落とす
 *    (`..."…"...` だけを狙う案では先頭形・末尾形が素通しになる)。
 *    このアンカーは V8 固有で、プロバイダのエラー文(413/404/401)には現れない。
 *  ★冪等: 置換後の `, "<入力省略>" is not valid JSON` を再度通しても同じ文字列になる。 */
export function stripParsedInputSnippet(msg: string): string {
  return msg.replace(/, (?:\.\.\.)?"[\s\S]*?"(?:\.\.\.)? is not valid JSON/g,
    ', "<入力省略>" is not valid JSON');
}

/** ★プロセスの外へ出るエラー文(ログ行・HTTP 応答)の唯一の入口。**順序をここで固定する**。
 *
 *  順序は **伏字 → 断片除去**。逆にしない理由:
 *    断片除去は「引用符の中身を丸ごと捨てる」操作なので、先に走らせると、
 *    伏字が見るべきだった文字列が**判定される前に形を変える**。秘密の判定は常に
 *    「入力そのもの」に対して行い、その後で表示用の間引きをする、という向きを崩さない。
 *    (formatErrForLog が確立した「伏字 → 除去 → 切り詰め」と同じ向き。)
 *  ★切り詰めはしない: 呼び出し側が用途に応じて決める(ログ=240字 / HTTP 応答=切らない)。 */
export function sanitizeErrorForOutput(msg: string): string {
  return stripParsedInputSnippet(redactSecrets(msg));
}

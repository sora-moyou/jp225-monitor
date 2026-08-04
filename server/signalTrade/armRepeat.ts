// 「失効後に同じ計画を出し直す」ときの歯止め(純関数)。
//
// ─── 現状(コードで確認した事実) ───────────────────────────────────
// armed-timeout で失効すると engine は state を FLAT に戻すだけで、planSuppressedAnchor(見送り抑止)は
// 設定しない。したがって次の計画サイクル(既定3分間隔)で AI へ再要求され、**同じ価格の計画が返れば
// そのまま再武装できる**。同一プランの重複排除は monitor のどこにも存在しない(検索済み: sameBracketShape は
// レンジ再評価の「維持判定」専用で、flat からの ARM 経路には効かない)。
// → 依頼の「失効後の次のシグナルに同じものも可」は **構造的には既に満たされている**。
//   足りないのは逆側、すなわち **無限に再武装し続けない歯止め** のほう。
//
// ─── 歯止めの設計 ─────────────────────────────────────────────
//  ・ブラケットを「向き + エントリー価格(5円バケット)」の署名に潰す。AI は同じ意図でも 1〜2円ずれた
//    価格を返すことがあるため、生値一致では歯止めが空振りする。実データの価格は5円刻みなので5円で丸める。
//  ・**同じ署名で連続して失効した回数** を数える。別の署名で失効したら 1 に戻る(=直近の連続だけを見る)。
//  ・ARM_REPEAT_LIMIT 回に達したら、その署名を ARM_REPEAT_BLOCK_MS のあいだブロックする。
//  ・約定したら状態ごとクリアする(その価格帯は「到達する」と実証されたので数え直す)。
//
// なぜ「回数 × 時間」の二段か:
//   回数だけだと「永久ブロック」になり、場が変わって本当に届くようになっても復帰できない。
//   時間だけだと 1回目の失効から待たされ、依頼の「同じものも可」を殺してしまう。
//   1〜2回目は素通し(=同じ計画を出し直せる)、3回目でその価格を1時間休ませる、という形にする。
//   ブロック中は planSuppressedAnchor と同じく「見送り」扱いにするので、価格が節目を跨げば
//   別の計画は普通に出る(エンジン全体が止まるわけではない)。
//
// ★このモジュールは純関数のみ(DB/LLM/時計に触らない)。now は呼び出し側が渡す。

/** 同じ署名で連続何回失効したらブロックするか。 */
export const ARM_REPEAT_LIMIT = 3;
/** ブロックする長さ[ms]。 */
export const ARM_REPEAT_BLOCK_MS = 60 * 60_000;
/** 署名を作るときの価格バケット[円](AI の微小な価格ゆらぎを同一視する)。 */
export const ARM_REPEAT_BUCKET_YEN = 5;

export interface ArmRepeatState {
  /** 直近に失効したブラケットの署名(まだ1件も失効していなければ null)。 */
  signature: string | null;
  /** その署名で **連続して** 失効した回数。 */
  streak: number;
  /** signature をブロックしている期限(epoch ms)。0=ブロックしていない。 */
  blockedUntil: number;
}

export const EMPTY_ARM_REPEAT: ArmRepeatState = { signature: null, streak: 0, blockedUntil: 0 };

const bucket = (v: number): number => Math.round(v / ARM_REPEAT_BUCKET_YEN) * ARM_REPEAT_BUCKET_YEN;

/** ブラケットの署名。向き(range は 'range')+ エントリー価格を5円バケットで丸めて並べる。
 *  レッグが1本も無い(=署名できない)場合は null。 */
export function bracketSignature(a: {
  direction?: 'buy' | 'sell';
  mode?: 'range';
  limitEntry?: number;
  stopEntry?: number;
  range?: { upper?: { entry: number }; lower?: { entry: number } };
} | null | undefined): string | null {
  if (!a) return null;
  const parts: string[] = [];
  if (a.limitEntry != null && Number.isFinite(a.limitEntry)) parts.push(`L${bucket(a.limitEntry)}`);
  if (a.stopEntry != null && Number.isFinite(a.stopEntry)) parts.push(`S${bucket(a.stopEntry)}`);
  if (a.range?.upper && Number.isFinite(a.range.upper.entry)) parts.push(`U${bucket(a.range.upper.entry)}`);
  if (a.range?.lower && Number.isFinite(a.range.lower.entry)) parts.push(`D${bucket(a.range.lower.entry)}`);
  if (!parts.length) return null;
  const dir = a.mode === 'range' || a.range != null ? 'range' : (a.direction ?? '?');
  return `${dir}|${parts.join(',')}`;
}

/** 失効を1件記録する。同じ署名の連続なら streak+1、違えば 1 に戻す。
 *  streak が ARM_REPEAT_LIMIT に達したらその署名を now+ARM_REPEAT_BLOCK_MS までブロックする。 */
export function noteArmExpiry(state: ArmRepeatState, signature: string | null, now: number): ArmRepeatState {
  if (!signature) return { ...state };   // 署名できない失効は歯止めの対象外(数えない)。
  const streak = state.signature === signature ? state.streak + 1 : 1;
  const blockedUntil = streak >= ARM_REPEAT_LIMIT ? now + ARM_REPEAT_BLOCK_MS : 0;
  return { signature, streak, blockedUntil };
}

/** 約定したら歯止めをクリアする(その価格帯は到達すると実証された)。 */
export function noteArmFilled(): ArmRepeatState {
  return { ...EMPTY_ARM_REPEAT };
}

/** この署名は今ブロックされているか。 */
export function isArmBlocked(state: ArmRepeatState, signature: string | null, now: number): boolean {
  if (!signature) return false;
  return state.signature === signature && state.blockedUntil > now;
}

/** ログ1行用: ブロック理由の説明(残り分数つき)。 */
export function describeArmBlock(state: ArmRepeatState, now: number): string {
  const remainMin = Math.max(0, Math.ceil((state.blockedUntil - now) / 60_000));
  return `同一価格の計画が${state.streak}回連続で未約定失効(上限${ARM_REPEAT_LIMIT}回)→ `
    + `この価格をあと${remainMin}分ブロック sig=${state.signature ?? '-'}`;
}

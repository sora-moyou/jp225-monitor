// 急変(shock)発火時刻のトラッカー。①ファンダ/テクニカル判定で「直前の急変以降のニュース」を
// 参照するために使う(ユーザー指定)。
//
// emitAlert が shock を出すたびに noteShock(t) を呼ぶ。lastShockAt=最新の急変、prevShockAt=その1つ前。
// - 急変(shock)を説明する時の参照開始 = prevShockAt(=この急変の1つ前の急変以降)。
// - フラッシュ等を説明する時の参照開始 = lastShockAt(=直近の急変以降)。

let lastShockAt = 0;
let prevShockAt = 0;

export function noteShock(t: number): void {
  if (t <= lastShockAt) return;   // 巻き戻り/重複は無視(単調)
  prevShockAt = lastShockAt;
  lastShockAt = t;
}

/** 説明対象の種別に応じたニュース参照の開始時刻(これ以降のニュースのみ参照)。0=制限なし。 */
export function newsSinceFor(detectionKind: string | undefined): number {
  return detectionKind === 'shock' ? prevShockAt : lastShockAt;
}

export function _reset(): void { lastShockAt = 0; prevShockAt = 0; }

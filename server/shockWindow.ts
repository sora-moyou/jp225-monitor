// 説明付きアラート(急変shock/超短期slope/暴落crash/旧magnitude)の発火時刻トラッカー。
// ①「前回アラート以降のニュースだけ参照」のために使う(同じ古いニュースを毎回引用しないため)。
//
// emitAlert が説明対象アラートを出すたび noteAlert(t) を呼ぶ。lastAlertAt=最新、prevAlertAt=その1つ前。
// 説明時の参照開始 = prevAlertAt(=1つ前のアラート以降のニュースのみ)。
// 旧実装は「直前の急変(shock)以降」だったが、超短期(slope)は急変が少ないと窓が4hに広がり、
// 同じ個別株ニュースを毎回引いていた。種別を問わず「前回アラート以降」に統一する。

let lastAlertAt = 0;
let prevAlertAt = 0;

export function noteAlert(t: number): void {
  if (t <= lastAlertAt) return;   // 巻き戻り/重複は無視(単調)
  prevAlertAt = lastAlertAt;
  lastAlertAt = t;
}

/** 説明で参照すべきニュースの開始時刻(1つ前のアラート以降)。0=まだ前例なし(=従来の固定窓にフォールバック)。 */
export function newsSinceForAlert(): number { return prevAlertAt; }

export function _reset(): void { lastAlertAt = 0; prevAlertAt = 0; }

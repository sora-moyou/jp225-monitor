// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  凍結断面の再生 — 同じ質問文(A / B v4)を、性格の違う相場で回す
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// ■ なぜ要るか
//   同一断面での質問文の対照(v1〜v4)は出尽くした。次に分からないのは
//   「ラベルが毎回『トレンド押し目・戻り』なのは **相場が同じだから** か、**質問文が偏らせている** か」。
//   これは断面を変えないと切り分けられない。よって **動かす変数を断面だけ** にして回す。
//
// ■ 凍結は既存のハーネスに任せる(作り直さない)
//   `scripts/plan-replay/freeze.mts` が、運用機の記録から時刻 T の点-in-time DB を作る。
//   ★T を含む1分足は「最大60秒の未来」を含むので、そこだけ T までの tick から作り直す —
//     この落とし穴の処理は既に freeze.mts が持っている(自前で切り直さない)。
//   時計は `scripts/plan-replay/clock.mts` の偽 Date で T へずらす(production は Date.now() を
//   直接読む箇所があるため。levelsLoop の inPollWindow / tick がそれ)。
//
// ■ ★freeze.mts が切っていないものを1つだけ足す
//   `news` 表(v0.9.67 で追加)は freeze.mts の切り詰め対象に **入っていない**。
//   そのままだと T より後のニュースが「関連ニュース」ブロックへ流れ込む(未来の漏洩)。
//   ここで T 以降を落とす。落とすのは **フィクスチャの複製** なので原本には触らない。
//
// 使い方: npx tsx server/labtest/fixture.ts <fixtureDir> [rep] [label]

import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';

/** 偽時計(scripts/plan-replay/clock.mts)。★.mts は tsconfig の include 外なので **実行時に** 読む
 *  (specifier を変数にしているのは、TS に拡張子を解決させないため。挙動は静的 import と同じ)。 */
interface FakeClock { installFakeClock(): void; setFakeNow(t: number): void; fakeNow(): number }
const CLOCK_MODULE = '../../scripts/plan-replay/clock.mts';

interface FixtureMetaLite {
  fixtureId: string; sourcePlanId: number; t: number; tJst: string; refPrice: number; system: string;
  recorded?: Record<string, unknown>;
}

const SYMBOL = 'NIY=F';

async function main(): Promise<void> {
  const dir = resolve(process.argv[2] ?? '');
  const rep = Number(process.argv[3] ?? 1);
  const sectionLabel = process.argv[4] ?? '(未分類)';
  const fx = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')) as FixtureMetaLite;

  // ★①時計を T へ ②APPDATA を凍結サンドボックスへ — どちらも **server を import する前** に。
  const clock = await import(CLOCK_MODULE) as unknown as FakeClock;
  clock.installFakeClock();
  clock.setFakeNow(fx.t);
  const sandbox = join(dir, 'sandbox', 'appdata');
  process.env.APPDATA = sandbox;

  const store = await import('../db/store.js');
  const dbPath = store.resolveDbPath();
  // ★安全弁: 実 DB に当たる前に落とす。「効いているはず」で進めない。
  if (!resolve(dbPath).startsWith(resolve(sandbox))) {
    throw new Error(`サンドボックス外の DB を指している(中止): ${dbPath}`);
  }

  // ★news の切り詰め(freeze.mts が持っていない・複製に対してのみ実行)。
  let newsDropped = 0;
  {
    const db = store.openDb(dbPath);
    try {
      newsDropped = Number(db.prepare('DELETE FROM news WHERE published_at > ?').run(fx.t).changes);
    } catch { /* news 表が無い古い DB は何もしない */ }
    finally { db.close(); }
  }

  const cache = await import('../cache.js');
  const { INSTRUMENTS } = await import('../config.js');
  const { buildLabContext } = await import('./context.js');
  const { callOnce, QUESTION_A, QUESTION_B_V4, buildPromptB, outDir, DUMMY_SIGNAL } = await import('./run.js');

  // ── 価格キャッシュの復元(凍結断面用) ─────────────────────────────────────
  //   NIY=F は台帳の ref_price を正とする(= 運用機が実際に見ていた値。その証拠が ref_price)。
  //   他銘柄は T 以前の最終 tick / 足。★changePercent はフィードの値で DB に残っていないので
  //   「JST 6:00 の足からの変化率」で近似する(原理的に凍結できない・記録にも明記する)。
  const db = store.openDb(dbPath);
  const jstBoundary = (t: number): number => {
    const six = Math.floor((t + 9 * 3600_000) / 86_400_000) * 86_400_000 + 6 * 3600_000 - 9 * 3600_000;
    return six <= t ? six : six - 86_400_000;
  };
  const boundary = jstBoundary(fx.t);
  const prices = [];
  for (const inst of INSTRUMENTS) {
    const sym = inst.symbol;
    const tick = db.prepare('SELECT t, price FROM ticks WHERE symbol=? AND t<=? ORDER BY t DESC LIMIT 1')
      .get(sym, fx.t) as { t: number; price: number } | undefined;
    const bar = db.prepare('SELECT t, c FROM bars_1m WHERE symbol=? AND t<=? ORDER BY t DESC LIMIT 1')
      .get(sym, fx.t) as { t: number; c: number } | undefined;
    let price = tick?.price ?? bar?.c;
    let ts = tick?.t ?? bar?.t;
    if (price === undefined || ts === undefined) continue;
    if (sym === SYMBOL) { price = fx.refPrice; ts = fx.t; }
    const base = (db.prepare('SELECT c FROM bars_1m WHERE symbol=? AND t<=? ORDER BY t DESC LIMIT 1')
      .get(sym, boundary) as { c: number } | undefined)?.c;
    prices.push({
      symbol: sym, price, timestamp: ts, stale: false,
      changePercent: base && base > 0 ? ((price - base) / base) * 100 : 0,
    });
  }
  db.close();
  cache.setPrices(prices as never);

  // ── ①データ組み立て(ライブ価格の取得は **しない**)→ ②A → ③B ───────────────
  // ★LABTEST_STAR_LEVELS=1 … 節目を「★(tier≧1)」のものだけに絞って渡す。
  const starOnly = /^(1|true|yes)$/i.test(process.env.LABTEST_STAR_LEVELS ?? '');
  // ★LABTEST_NO_LEVELS=1 … 節目由来のブロックを丸ごと渡さない(starOnly より優先)。
  const noLevels = /^(1|true|yes)$/i.test(process.env.LABTEST_NO_LEVELS ?? '');
  // ★LABTEST_KIRIBAN=1 … 大台(キリ番)の一覧をデータに足す(pass5c)。
  const kiriban = /^(1|true|yes)$/i.test(process.env.LABTEST_KIRIBAN ?? '');
  // ★LABTEST_SKIP_A=1 … A を呼ばず、B に A の答えを **1文字も** 渡さない(pass5a: 連鎖の交絡を切る)。
  const skipA = /^(1|true|yes)$/i.test(process.env.LABTEST_SKIP_A ?? '');
  // ★LABTEST_B_SUFFIX … B の末尾に足す1文(pass5b)。★質問文の本体は1文字も変えない。
  const bSuffix = process.env.LABTEST_B_SUFFIX ?? '';
  const promptB = bSuffix ? `${buildPromptB(fx.refPrice)}\n${bSuffix}` : buildPromptB(fx.refPrice);
  // ★ニュースの関連度に渡す質問文は **pass4 の形に固定** する。
  //   formatNewsForChat は質問文とのバイグラム重なりでニュースを選ぶので、質問文を変えると
  //   **渡すニュースまで変わってしまう**(= 動かす変数が2つになる)。pass5 系は「B の聞き方」だけを
  //   動かしたいので、ここは A + B(接尾辞なし)で固定し、データを pass4 と byte 一致させる。
  const newsQuery = `${QUESTION_A}\n${QUESTION_B_V4}`;
  const built = await buildLabContext(newsQuery,
    { livePrices: false, now: clock.fakeNow(), starLevelsOnly: starOnly, noLevels, kiriban });

  // ★LABTEST_NO_LLM=1 … 凍結が正しいかを **課金ゼロで** 先に確かめるための空回し。
  const noLlm = /^(1|true|yes)$/i.test(process.env.LABTEST_NO_LLM ?? '');
  const skipped = { messages: [] as never[], answer: null, error: '(LABTEST_NO_LLM=1 のため呼んでいない)',
    provider: null, model: null, ms: 0, usage: null };
  const msgsA = [
    { role: 'system' as const, content: built.text },
    { role: 'user' as const, content: QUESTION_A },
  ];
  const a = skipA
    ? { ...skipped, messages: [] as never, error: '(LABTEST_SKIP_A=1: A は呼んでいない)' }
    : (noLlm ? { ...skipped, messages: msgsA as never } : await callOnce(msgsA, `labtest-fx-${fx.fixtureId}-A`));
  // ★pass5a: A を呼ばない回の B は **データ + B の質問文だけ**(assistant 発話を1つも入れない)。
  const msgsB = skipA
    ? [
      { role: 'system' as const, content: built.text },
      { role: 'user' as const, content: promptB },
    ]
    : [
      ...msgsA,
      { role: 'assistant' as const, content: a.answer ?? '(A の返答が取れませんでした)' },
      { role: 'user' as const, content: promptB },
    ];
  const b = noLlm ? { ...skipped, messages: msgsB as never } : await callOnce(msgsB, `labtest-fx-${fx.fixtureId}-B`);

  const at = Date.now();
  const record = {
    kind: 'fixture' as const,
    at, atIso: new Date(at).toISOString(),
    fixture: {
      id: fx.fixtureId, planId: fx.sourcePlanId, system: fx.system,
      t: fx.t, tJst: fx.tJst, refPrice: fx.refPrice,
      sectionLabel, rep,
      starLevelsOnly: starOnly,
      noLevels,
      kiriban,
      skipA,
      bSuffix,
      dir,
      newsRowsDroppedAsFuture: newsDropped,
      recorded: fx.recorded ?? null,
      note: 'changePercent は近似(フィードの値は DB に残らない)。メモリ内ライブ足は再構築せず DB 足のみ。',
    },
    data: built.text,
    diag: built.diag,
    a, b,
    signalMode: 'dummy' as const,
    signal: DUMMY_SIGNAL,
    savedTo: null as string | null,
    systemPromptUsed: '本番の規則文は付けない(system にはデータ全文のみ)' as const,
  };

  const { mkdirSync, writeFileSync } = await import('node:fs');
  const out = outDir();
  mkdirSync(out, { recursive: true });
  const file = join(out, `fx-${fx.fixtureId}-rep${rep}-${new Date(at).toISOString().replace(/[:.]/g, '-')}.json`);
  record.savedTo = file;
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');

  console.log(`[fx] ${fx.fixtureId} rep${rep} ${sectionLabel} T=${fx.tJst} ref=${fx.refPrice} `
    + `news未来削除=${newsDropped} 節目=${built.diag.levelsUp}/${built.diag.levelsDown} `
    + (built.diag.noLevels
      ? `節目なし[主要 ${built.diag.noLevels.mainLines}行 / 上メド ${built.diag.noLevels.upItems} / `
        + `下メド ${built.diag.noLevels.downItems} / フィボ戻し ${built.diag.noLevels.fibLine ? 'あり' : 'なし'} を除去] `
      : '')
    + (built.diag.starFilter
      ? `★のみ[主要 ${built.diag.starFilter.mainBefore}→${built.diag.starFilter.mainAfter} / `
        + `上メド ${built.diag.starFilter.upBefore}→${built.diag.starFilter.upAfter} / `
        + `下メド ${built.diag.starFilter.downBefore}→${built.diag.starFilter.downAfter}] `
      : '')
    + `A=${a.error ? 'ERR' : 'ok'} B=${b.error ? 'ERR' : 'ok'} → ${file}`);
}

main().catch(e => { console.error('[fx] FAILED:', e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1); });

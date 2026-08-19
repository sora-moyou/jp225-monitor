// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  「節目は★のみ」— 出来上がったデータ本文から、★の付いた節目だけを残す(純関数)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// ■ ★とは何か(コードで確認した事実・推測していない)
//   server/llm/scalpContext.ts:182   主要節目ブロック
//       const star = l.tier >= 2 ? ' ★★' : l.tier >= 1 ? ' ★' : '';
//   server/chatContext.ts:176        上値メド/下値メド の行(変数名も star)
//       const star = l.strong ? '(強)' : '';
//   server/levels.ts:443
//       l.strong = l.tier >= 1;   // 後方互換
//
//   → **★ と (強) は同じ規則**(tier ≥ 1)。表記が2箇所で違うだけ。
//     よって「★のみ」は tier≥1 のみ = 主要節目は ★/★★ の行だけ、メドの行は (強) の項目だけ、を残す。
//     ★★(tier≥2)は★の上位なので当然残る。
//
// ■ 本番を改変しない
//   整形関数(buildScalpMarketData / formatLevelsBlock)には一切触らず、**出来上がった文字列から抜く**。
//   したがって本番の出力規則が変わればこちらも自動で追従する(規則を写していない)。

/** 除外の実測(推測で報告しないための数値)。 */
export interface StarFilterStats {
  /** 主要節目ブロック: 除外前 → 除外後 の行数。 */
  mainBefore: number;
  mainAfter: number;
  /** 上値メド / 下値メド: 除外前 → 除外後 の項目数。 */
  upBefore: number;
  upAfter: number;
  downBefore: number;
  downAfter: number;
  /** ★が1本も無くて丸ごと落ちた行/ブロックの名前。 */
  dropped: string[];
}

/** 「上値メド: A / B / C」の行を (強) の項目だけに絞る。1つも残らなければ null(=行ごと落とす)。 */
function filterMedLine(line: string, head: string): { line: string | null; before: number; after: number } {
  const body = line.slice(head.length);
  const items = body.split(' / ');
  const kept = items.filter(s => s.includes('(強)'));
  return {
    line: kept.length > 0 ? head + kept.join(' / ') : null,
    before: items.length, after: kept.length,
  };
}

/** データ本文から★の節目だけを残す。★本番の他のブロック(足・指標・アラート等)には触らない。 */
export function keepOnlyStarLevels(text: string): { text: string; stats: StarFilterStats } {
  const stats: StarFilterStats = {
    mainBefore: 0, mainAfter: 0, upBefore: 0, upAfter: 0, downBefore: 0, downAfter: 0, dropped: [],
  };
  const out: string[] = [];
  const lines = text.split('\n');
  let inMain = false;
  let mainHeaderIdx = -1;

  for (const line of lines) {
    // ── 主要節目ブロック ──────────────────────────────────────────────
    if (line.startsWith('主要節目(')) {
      inMain = true;
      mainHeaderIdx = out.length;
      out.push(line);                    // 見出し自体にも ★ の字はあるが、これは凡例なので数えない
      continue;
    }
    if (inMain) {
      if (line.trim() === '') {
        inMain = false;
        if (stats.mainAfter === 0 && mainHeaderIdx >= 0) {
          out.splice(mainHeaderIdx, 1);  // ★が1本も無ければ見出しごと落とす(空の見出しを残さない)
          stats.dropped.push('主要節目(★なし)');
        }
        out.push(line);
        continue;
      }
      stats.mainBefore++;
      if (line.includes('★')) { stats.mainAfter++; out.push(line); }
      continue;
    }
    // ── 上値メド / 下値メド ───────────────────────────────────────────
    for (const head of ['上値メド: ', '下値メド: ']) {
      if (!line.startsWith(head)) continue;
      const r = filterMedLine(line, head);
      if (head === '上値メド: ') { stats.upBefore = r.before; stats.upAfter = r.after; }
      else { stats.downBefore = r.before; stats.downAfter = r.after; }
      if (r.line === null) stats.dropped.push(`${head.trim()}(★なし)`);
      else out.push(r.line);
      break;
    }
    if (line.startsWith('上値メド: ') || line.startsWith('下値メド: ')) continue;
    out.push(line);
  }
  // 末尾で主要節目ブロックが閉じていない場合(本文の最後がブロックだった)
  if (inMain && stats.mainAfter === 0 && mainHeaderIdx >= 0) {
    out.splice(mainHeaderIdx, 1);
    stats.dropped.push('主要節目(★なし)');
  }
  return { text: out.join('\n'), stats };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  「節目を渡さない」— 節目由来のブロックを丸ごと外す(純関数)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// ■ 外す対象を **コードで** 洗い出した(推測していない)
//   (1) server/chatContext.ts:172 formatLevelsBlock(getLevelsSnapshot()) が出す 3 行:
//         ・`上値メド: …`      … LevelsResult.up
//         ・`下値メド: …`      … LevelsResult.down
//         ・`フィボ戻し(…): 50%=…円。現値はこれを…`
//              ★これも **同じ関数が LevelsResult.swing から** 出している = 節目由来。
//                前回の★フィルタでは触っていなかったが、価格(50%=…円)を名指しで渡すので今回は外す。
//   (2) server/llm/scalpContext.ts:186 `主要節目(現在値からの距離・強度 ★/s=スコア):` ブロック全体
//   (3) server/chatContext.ts:153 formatForecastBlock の `本日ADR予測メド: 上限…/下限…`
//         … ADR 予測は computeLevels へ extra として流し込まれる節目候補でもある。
//           ★今回の凍結断面では forecastLoop を回していないので **元から出ていない**(実測)。
//           出る環境で使うときのために対象に入れておく。
//
// ■ 残すもの(節目ではない)
//   足(1分/5分)・セッションOHLC・直近スイング(extractSwingPivots=足由来)・勢い行・ボラ/レンジ・
//   テクニカル指標・アラート・ニュース・成績。★見出し行(「…テクニカル(セッションH/L・フィボ)」)は
//   価格を含まないので残す(中身だけが消える)。

export interface NoLevelStats {
  /** 外した 上値メド / 下値メド の項目数(行が無ければ 0)。 */
  upItems: number;
  downItems: number;
  /** フィボ戻しの行を外したか。 */
  fibLine: boolean;
  /** 外した主要節目の行数。 */
  mainLines: number;
  /** 外した ADR 予測メドの行数(この断面では 0 のはず)。 */
  adrLines: number;
  /** 実際に外した行の一覧(報告用・そのまま列挙できる)。 */
  removed: string[];
}

/** 節目由来のブロックを丸ごと外す。★本番の整形関数には触れず、出来上がった本文から抜く。 */
export function stripLevelBlocks(text: string): { text: string; stats: NoLevelStats } {
  const stats: NoLevelStats = {
    upItems: 0, downItems: 0, fibLine: false, mainLines: 0, adrLines: 0, removed: [],
  };
  const out: string[] = [];
  let inMain = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('主要節目(')) { inMain = true; stats.removed.push(line); continue; }
    if (inMain) {
      if (line.trim() === '') { inMain = false; out.push(line); continue; }
      stats.mainLines++; stats.removed.push(line); continue;
    }
    if (line.startsWith('上値メド: ')) {
      stats.upItems = line.slice('上値メド: '.length).split(' / ').length;
      stats.removed.push(line); continue;
    }
    if (line.startsWith('下値メド: ')) {
      stats.downItems = line.slice('下値メド: '.length).split(' / ').length;
      stats.removed.push(line); continue;
    }
    if (line.startsWith('フィボ戻し(')) { stats.fibLine = true; stats.removed.push(line); continue; }
    if (line.startsWith('本日ADR予測メド: ')) { stats.adrLines++; stats.removed.push(line); continue; }
    out.push(line);
  }
  return { text: out.join('\n'), stats };
}

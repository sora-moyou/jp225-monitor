import { describe, it, expect } from 'vitest';
import {
  DETECTION_KINDS, DETECTION_KIND_SPEC, isDetectionKind, isTechnicalKind, isDirectionalKind,
  detectionKindLabel, detectionKindPromptLabel, type DetectionKind,
} from './detectionKinds.js';

// 検知種別 SSOT の不変条件と、種別追加時の「取りこぼし検出器」。
//
// ★事故の背景: 種別の知識(union / allowlist / テクニカル判定 / ラベル)が5ファイルに手書きコピーされ、
//   v0.9.36 の nwave / dailyband が一部にしか入らなかった。v0.9.48 はそのうち2つだけを直し、
//   残る2つ(バナー・L2集合)を取りこぼした=同じ病気が修正の中で再発した。

describe('検知種別 SSOT', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // ★★★ 種別を足すとこのテストが赤くなります(意図的な関所)。 ★★★
  //   赤くなったら、追記する前に次を1つずつ確認してください:
  //     1) layer は決めたか
  //          L1 = 価格変化そのもの → ニュース AI に原因を聞く(バナーに🔄と15分変化率が出る)
  //          L2 = テクニカル状態   → LLM を呼ばず note の固定文/「直近の状況」の母集団に入る
  //     2) label(履歴一覧・バナーのタグ)と promptLabel(AI プロンプトの種別名)を決めたか
  //     2b) directional は正しいか
  //          true  = 上/下の意味がある → ▲/▼ と方向色が付く
  //          false = 方向の概念が無い(BB幅の収縮/拡大など) → 矢印も方向色も出ない。
  //                  payload.direction は必須項目なので 'up' を積むが、それを方向として見せると
  //                  「無い方向を主張する」無言の嘘になる(AI へ渡る「直近の状況」にも入る)
  //     3) その種別を **誰が alerts に書くか**: collector も検知するなら
  //        server/alertHistory.ts の MONITOR_ONLY_KINDS に入れてはいけない(二重記録になる)
  //     4) 発火頻度は実データで見たか(`npx tsx scripts/alert-audit.mts`)
  //   1〜2 は型でも守られます(表の項目が欠けると tsc が落ちる)。3〜4 は型では守れないので目視です。
  // ─────────────────────────────────────────────────────────────────────────
  it('全種別(この一覧が唯一の関所。増減したら上のチェックリストを確認すること)', () => {
    expect([...DETECTION_KINDS]).toEqual([
      'slope', 'magnitude', 'shock', 'crash',
      'double', 'ma_sr', 'level_sr', 'break', 'pivot', 'trend', 'dailyband', 'nwave', 'bandwalk',
      'squeeze', 'bulge',
      'granville', 'dtb', 'ma', 'swingdtb',
    ]);
  });

  it('L2(テクニカル)種別の一覧 — バナー固定文/「直近の状況」/LLM の急変文抑止が全てこの集合で決まる', () => {
    expect(DETECTION_KINDS.filter(isTechnicalKind)).toEqual([
      'double', 'ma_sr', 'level_sr', 'break', 'pivot', 'trend', 'dailyband', 'nwave', 'bandwalk',
      'squeeze', 'bulge',
      'granville', 'dtb', 'ma', 'swingdtb',
    ]);
    // ★2026-08-15 追加。L2 に居ないとバナーが「[トレンド]」になり、/api/explain が LLM を呼びに行って 400 になる。
    expect(isTechnicalKind('squeeze')).toBe(true);
    expect(isTechnicalKind('bulge')).toBe(true);
    // ★v0.9.36 の取りこぼし本体。L1 に落ちると「[トレンド]」表示・LLM 呼び出し(→400)・AI 文脈からの脱落が同時に起きる。
    expect(isTechnicalKind('nwave')).toBe(true);
    // ★v0.9.61 追加。L2 に居ないとバナーが「[トレンド]」になり、/api/explain が LLM を呼びに行って 400 になる。
    expect(isTechnicalKind('bandwalk')).toBe(true);
    expect(isTechnicalKind('dailyband')).toBe(true);
  });

  it('L1 は価格変化系の4種別だけ(ニュース AI で説明する側)', () => {
    expect(DETECTION_KINDS.filter(k => !isTechnicalKind(k))).toEqual(['slope', 'magnitude', 'shock', 'crash']);
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  方向(directional) — 「方向を持たない検知に ▲/▼ と色を付けていた」欠陥の関所
  // ─────────────────────────────────────────────────────────────────────────
  it('方向を持たない種別はスクイーズ/バルジだけ(それ以外は全て方向あり)', () => {
    expect(DETECTION_KINDS.filter(k => !isDirectionalKind(k))).toEqual(['squeeze', 'bulge']);
    // BB幅の収縮/拡大は「上下どちらへ出るか」を語らない。payload.direction は必須項目なので
    // 'up' が入るが、それを方向として表示・解釈してはいけない。
    expect(isDirectionalKind('squeeze')).toBe(false);
    expect(isDirectionalKind('bulge')).toBe(false);
  });

  it('未知の種別は「方向あり」に落ちる — 表の外の種別が黙って方向なし表示に変わらないため', () => {
    expect(isDirectionalKind('someFutureKind')).toBe(true);
    expect(isDirectionalKind(null)).toBe(true);
    expect(isDirectionalKind(undefined)).toBe(true);
  });

  it('全種別が promptLabel を持ち、label は「固有名 or null(窓秒から導出)」のどちらか', () => {
    for (const k of DETECTION_KINDS) {
      const spec = DETECTION_KIND_SPEC[k];
      expect(spec.promptLabel.length, `${k}: promptLabel`).toBeGreaterThan(0);
      expect(spec.label === null || spec.label.length > 0, `${k}: label`).toBe(true);
      expect(detectionKindPromptLabel(k)).toBe(spec.promptLabel);
      expect(detectionKindLabel(k)).toBe(spec.label);
    }
  });

  it('固有ラベルを持たないのは旧 z-score 系(slope/magnitude)だけ', () => {
    expect(DETECTION_KINDS.filter(k => detectionKindLabel(k) === null)).toEqual(['slope', 'magnitude']);
  });

  it('isDetectionKind は表にある文字列だけを通す(未知/非文字列は false)', () => {
    for (const k of DETECTION_KINDS) expect(isDetectionKind(k)).toBe(true);
    for (const v of ['', 'Nwave', 'unknown', 'toString', null, undefined, 42, {}]) {
      expect(isDetectionKind(v), String(v)).toBe(false);
    }
  });

  it('未知の種別は「L1・固有ラベル無し・promptLabel=トレンド」に落ちる(旧 else 分岐と同じ)', () => {
    // 過去 DB の想定外文字列で例外にしない。ただし L2 側に紛れ込ませない(黙って固定文にしない)。
    const unknown = 'someFutureKind' as DetectionKind;
    expect(isTechnicalKind(unknown)).toBe(false);
    expect(detectionKindLabel(unknown)).toBeNull();
    expect(detectionKindPromptLabel(unknown)).toBe('トレンド');
    expect(detectionKindLabel(null)).toBeNull();
  });
});

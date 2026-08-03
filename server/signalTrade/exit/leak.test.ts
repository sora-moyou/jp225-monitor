// ★漏洩検査(このリポジトリだけが公開先を持つ = ここに無いと意味が無い検査)
//
// ■ なぜ要るか(消すとまた同じ壊れ方をするので理由を残す)
//   このリポジトリの remote は2本あり、片方は **公開** リポジトリ(lite)へ push される。
//   非公開の決済ロジック(フェーズ式利益ロックのラダー)の実数値は ./private.ts と ./private.test.ts
//   にだけ在り、.gitignore の PRIVATE-BACKUP:BEGIN〜END 区間で除外されている。
//   つまり「除外が効いている」ことと「値が別のファイルへ書き写されていない」ことの2つが崩れた瞬間に、
//   実運用の決済ロジックが公開される。人間の注意力ではなく、テストで止める。
//   ★「いま漏れていない」を「これからも漏れない」に変えるのがこのファイルの仕事。
//
// ■ 検査(すべて git が知っているファイル = 追跡済み + 未追跡かつ非ignore が対象)
//   ① private の実ファイルが **追跡されていない**(最後の防壁)
//   ② .gitignore の PRIVATE-BACKUP 区間が在り、**その区間の行** が private を除外している
//   ③ 強い文脈(非公開の export 名 / 数値キー名を名指しする行)に秘密の数値が無い … 零容認
//   ④ 秘密のキー名そのものが公開ソースに現れない … 零容認(構造の漏洩)
//   ⑤ 定義の指紋(16桁hex)が公開ソースに現れない … 零容認
//   ⑥ 段のペア(同じ cfg に同居する2値が同一行)… 零容認(既知の偽陽性は行ハッシュで個別に登録)
//   ⑦ 弱い文脈(peak/床/ラチェット等の説明行に秘密値が1つ)… 既知の偽陽性ファイルを baseline と突合
//
// ■ ★このテストのソースに秘密を書かないこと(検査そのものが漏洩になる)
//   照合対象(数値・キー名・export 名・指紋)は **実行時に ./private.ts から読む**。
//   固定値は1つも書かない。フィクスチャの数字も実行時に組み立てる(nonSecretSample)。
//   §自己検査(最後のテスト)で「このファイル自身に秘密が入っていない」ことを毎回確かめる。
//
// ■ private が無い環境(公開クローン / CI / 他の開発機)
//   照合すべき秘密が手元に無い = 検査できない。**黙って緑にしない**: ctx.skip() で skip として
//   数え、理由を console に出す。検査は「秘密を持っている開発機(=出荷元)」の責務。
//   ①② は秘密を必要としないので、その環境でも必ず走る。
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** server/signalTrade/exit/leak.test.ts → リポジトリのルート。 */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

/** このファイル自身(自己検査の対象)。 */
const SELF_REL = ['server', 'signalTrade', 'exit', 'leak.test.ts'].join('/');

/** 秘密ファイルの **パス名**(.gitignore に書かれている = すでに公開情報。値ではない)。 */
const SECRET_PATHS = [
  'server/signalTrade/exit/private.ts',
  'server/signalTrade/exit/private.test.ts',
] as const;

const BEGIN_MARK = 'PRIVATE-BACKUP:BEGIN';
const END_MARK = 'PRIVATE-BACKUP:END';

/** 検査するテキスト拡張子(バイナリは除外)。 */
const TEXT_EXT = [
  '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css',
  '.rs', '.toml', '.yml', '.yaml', '.snap', '.txt',
];

/** ★弱い文脈のトークン(決済ラダーの説明でよく使う語)。**公開語彙**であって秘密ではない
 *  (index.ts が公開フォールバックの説明文で使っている語)。
 *  'floor'/'Floor' は Math.floor 等で頻出するので入れない(強い文脈のキー名側で拾う)。 */
const WEAK_TOKENS = [
  'peak', 'Peak', '床', 'ラチェット', 'phaseExit', 'phase-exit', 'phase_exit',
  '利益ロック', '含み益', '決済逆指値',
] as const;

// ─── 既知の偽陽性(baseline) ────────────────────────────────────────────────────
//
// ★運用規約: **増やさない**。増やすときは「なぜ決済ラダーと無関係か」を必ず書く。
//   ここに載っていない新しい一致は必ず赤くなる。

/** ⑥ 段のペア(cfg に同居する2値が同一行)の既知偽陽性。行の内容ハッシュで個別に登録する
 *  = ファイル丸ごとの除外にしない(同じファイルの **別の行** で漏らしたら赤くなる)。
 *  ★ハッシュ対象の行は **すでに公開されている追跡ファイルの本文** なので、ハッシュ化で新たに漏れるものは無い。 */
const PAIR_ALLOW: readonly { hash: string; why: string }[] = [
  // エントリー側(LC/距離)の設定値を並べた設計文書。決済ラダーとは別系統のパラメータで、たまたま同値。
  { hash: '5f2f15c7d8c3', why: 'docs/.../2026-07-16-centralize-entry-controls-design.md: エントリー側LC/距離の列挙' },
  { hash: '41a12493e86b', why: 'docs/.../2026-07-16-centralize-entry-controls-design.md: 同上(再掲行)' },
  // 決済記録テストが自前で持つ **玩具のラダー**(1段だけ)の説明と期待値。非公開の段構成とは無関係。
  { hash: '9930cfa8433b', why: 'server/signalTrade/exitRecord.test.ts: テスト専用の玩具ラダーの説明' },
  { hash: '38fbf5f310e9', why: 'server/signalTrade/exitRecord.test.ts: 同テストの期待値コメント' },
];

/** ⑦ 弱い文脈の既知偽陽性。ファイル別の **上限件数**。
 *  - 表に無いファイルで1件でも出たら赤(新しい漏洩候補)
 *  - 表にあるファイルでも件数が増えたら赤(そのファイルで新たに増えた=見に行く価値がある)
 *  - 表にあるのに0件になったら赤(古びた例外は消す。例外表を腐らせない)
 *  ★件数が減っただけでは赤にしない(無関係な編集で毎回赤くなるのを避ける)。
 *  ★ここで丸ごと許した行も、⑥(段のペア)と③(強い文脈)は **例外なく** 効く。 */
const WEAK_BASELINE: Readonly<Record<string, number>> = {
  // 玩具ラダー(peak 閾値と床)を持つ決済記録テスト。丸めた練習値がたまたま同値。
  'server/signalTrade/exitRecord.test.ts': 11,
  // 差し替え実装(_setExitImpl)の玩具ラダーと、建値/価格のフィクスチャ。
  'server/signalTrade/engine.test.ts': 9,
  // エントリー側の設定値(LC/距離)を並べた設計文書。
  'docs/superpowers/specs/2026-07-16-centralize-entry-controls-design.md': 2,
  // リプレイの玩具ラダー(強制決済の検証)。
  'server/replay/replayForce.test.ts': 2,
  'server/replay/replay.test.ts': 1,
  // 画面の説明・使い方(注文の例示価格)。
  'USER_GUIDE.md': 1,
  'web/index.html': 1,
  // 別系統のバックテスト(SR 戦略)のCLI既定値。決済ラダーとは無関係の実験パラメータ。
  'scripts/sr-stop60-runner.mts': 1,
  // 時刻・枚数・距離などの数値が「床」「peak」と同居しただけのテスト群。
  'server/basedata.test.ts': 1,
  'server/db/shadowCensoring.test.ts': 1,
  'server/db/shadowStore.test.ts': 1,
  'server/llm/scalpPlanPipeline.test.ts': 1,
  'server/routes/exitStopAuthority.test.ts': 1,
  'server/signalTrade/exit/index.test.ts': 1,
};

// ─── 秘密の収集(実行時に private から。ソースには1つも書かない) ─────────────────

interface Harvest {
  /** 照合する秘密の整数。 */
  numbers: ReadonlySet<number>;
  /** 同じ cfg オブジェクトに同居していた2値の組("小|大")。段のペア判定に使う。 */
  pairs: ReadonlySet<string>;
  /** 数値を値に持つキー名(= ラダーの構造名)。 */
  cfgKeys: readonly string[];
  /** private の export 名(強い文脈のトークン)。 */
  exportNames: readonly string[];
  /** 定義の指紋(16桁以上の hex 文字列)。 */
  fingerprints: readonly string[];
}

const pairKey = (a: number, b: number): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** 行から「値として意味のある整数」を拾う。
 *  ★trade2 版から変えた点(実測で穴だった):
 *   - `\b\d+\b` をやめた。非公開の説明文は `peak ≥ <値>pt` の形で、数字と `p` の間に単語境界が
 *     無いため **単位付きの数値を丸ごと取り逃していた**(=一番ありそうな漏洩の形が素通り)。
 *   - 桁区切り(12_345 / 12,345)を1つの数に畳む(部分列が偶然一致するのを防ぐ)。
 *   - 小数・版番号は落とす。
 *   - **英字の直後の数字は拾わない**(識別子に埋まった数字・hex の断片)。
 *  ★この doc コメントに具体的な数字を書かないこと(このファイル自身が走査対象で、例示の数字が
 *    たまたま実値と一致すると「検査が漏洩する」)。 */
export function extractNumbers(line: string, contextTokens: readonly string[]): number[] {
  let s = line;
  for (const t of contextTokens) s = s.split(t).join(' ');
  s = s.replace(/(?<=\d)[,_](?=\d)/g, '');   // 桁区切り
  s = s.replace(/\b[0-9a-f]{8,}\b/gi, ' ');  // 長い hex(指紋・行ハッシュ・ID)。先頭の数字だけが値に見える事故を防ぐ
  s = s.replace(/\d{4}-\d{2}-\d{2}/g, ' ');  // ISO 日付(設計書のファイル名で頻出)
  s = s.replace(/#\d+/g, ' ');               // 指摘 #12
  s = s.replace(/\d+(?:\.\d+)+/g, ' ');      // 小数 / 版番号
  return [...s.matchAll(/(?<![A-Za-z_$\d.])\d+/g)].map((m) => Number(m[0]));
}

/** 値/キー/指紋を再帰的に集める。**キー名は「値が数値のキー」だけ**(name/epoch のような
 *  汎用語を強い文脈トークンにすると、console.log や CSS まで巻き込んで検査が使い物にならない)。 */
function collect(value: unknown, into: {
  numbers: Set<number>; pairs: Set<string>; keys: Set<string>; fingerprints: Set<string>;
}, collectKeys: boolean, depth = 0, seen = new Set<unknown>()): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'number') { if (Number.isFinite(value)) into.numbers.add(value); return; }
  if (typeof value === 'string') {
    if (/^[0-9a-f]{16,}$/i.test(value)) into.fingerprints.add(value);
    // 説明文(実数値つき)から数値を拾う。将来 cfg の形が変わって定数が関数の中へ移っても
    // 検査が **無音で空振りしない** ようにするための二重取り。
    for (const n of extractNumbers(value, [])) into.numbers.add(n);
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) { for (const v of value) collect(v, into, collectKeys, depth + 1, seen); return; }
  const local: number[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) { if (collectKeys) into.keys.add(k); local.push(v); }
    collect(v, into, collectKeys, depth + 1, seen);
  }
  for (let i = 0; i < local.length; i++) {
    for (let j = i + 1; j < local.length; j++) into.pairs.add(pairKey(local[i]!, local[j]!));
  }
}

/** ./private.ts を読む。無ければ null(公開クローン / CI)。
 *  ★EXIT_LEAK_GUARD_SIMULATE_ABSENT=1 は「private が無い環境」を再現するための検証用スイッチ。
 *    立っているときは必ず警告を出す(黙って検査を無効化しない)。 */
async function loadPrivate(): Promise<Record<string, unknown> | null> {
  if (process.env.EXIT_LEAK_GUARD_SIMULATE_ABSENT === '1') {
    console.warn('[leak-guard] EXIT_LEAK_GUARD_SIMULATE_ABSENT=1: private 不在を模擬しています(検査は skip)。');
    return null;
  }
  try {
    // 公開リポには private.ts が無い。指定子は index.ts と同じ形にする。
    // @ts-ignore optional private module (absent in public repo)
    return (await import('./private.js')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function harvestSecrets(): Promise<Harvest | null> {
  const mod = await loadPrivate();
  if (!mod) return null;
  const into = { numbers: new Set<number>(), pairs: new Set<string>(), keys: new Set<string>(), fingerprints: new Set<string>() };
  const exportNames: string[] = [];
  for (const [name, value] of Object.entries(mod)) {
    exportNames.push(name);
    if (typeof value !== 'function') collect(value, into, true);
  }
  // 引数を取らない export は呼んで戻り値も見る(表・説明文・指紋はここにしか無い)。
  for (const value of Object.values(mod)) {
    if (typeof value === 'function' && (value as (...a: unknown[]) => unknown).length === 0) {
      try { collect((value as () => unknown)(), into, false); } catch { /* 規約違反で throw する export もある */ }
    }
  }
  const numbers = new Set([...into.numbers].filter((n) => Number.isInteger(n) && n > 1));
  const pairs = new Set([...into.pairs].filter((p) => p.split('|').every((x) => numbers.has(Number(x)))));
  if (numbers.size === 0) return null;   // 照合できる秘密が無い = 検査不能(劣化した private)
  return {
    numbers, pairs,
    cfgKeys: [...into.keys].sort(),
    exportNames: exportNames.sort(),
    fingerprints: [...into.fingerprints].sort(),
  };
}

// ─── 走査 ────────────────────────────────────────────────────────────────────

interface Finding {
  file: string; line: number; excerpt: string; hash: string;
  kind: 'strong' | 'weak';
  /** cfg に同居する2値が同一行に出た(= 段のペアの形)。 */
  paired: boolean;
}

const lineHash = (line: string): string => createHash('sha256').update(line.trim()).digest('hex').slice(0, 12);

/** git が知っているテキストファイル(追跡済み + 未追跡かつ非ignore)。
 *  ★未追跡も見る理由: 追跡済みだけを見ると **新規ファイルで漏らしても緑のまま**。
 *    git add した瞬間に公開されうるものは add 前から対象にする。ignore 済みは git に入らないので対象外。 */
export function gitKnownTextFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p.length > 0 && TEXT_EXT.some((e) => p.endsWith(e)));
}

/** 1ファイル分の走査(純関数・テキストを渡す)。 */
export function scanText(rel: string, text: string, h: Harvest): Finding[] {
  const strongTokens = [...h.exportNames, ...h.cfgKeys];
  const contextTokens = [...strongTokens, ...WEAK_TOKENS];
  const found: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const strong = strongTokens.some((t) => line.includes(t));
    const weak = WEAK_TOKENS.some((t) => line.includes(t));
    if (!strong && !weak) continue;
    const hits = [...new Set(extractNumbers(line, contextTokens).filter((n) => h.numbers.has(n)))];
    if (hits.length === 0) continue;
    let paired = false;
    for (let a = 0; a < hits.length && !paired; a++) {
      for (let b = a + 1; b < hits.length; b++) {
        if (h.pairs.has(pairKey(hits[a]!, hits[b]!))) { paired = true; break; }
      }
    }
    const trimmed = line.trim();
    found.push({
      file: rel, line: i + 1, hash: lineHash(trimmed),
      excerpt: trimmed.slice(0, 128), kind: strong ? 'strong' : 'weak', paired,
    });
  }
  return found;
}

/** 渡されたファイル群を走査する(root 配下の相対パス)。 */
export function scanFiles(root: string, rels: readonly string[], h: Harvest): Finding[] {
  const out: Finding[] = [];
  for (const rel of rels) {
    let text: string;
    try { text = readFileSync(join(root, rel.split('/').join(sep)), 'utf-8'); } catch { continue; }
    out.push(...scanText(rel, text, h));
  }
  return out;
}

/** 文字列(キー名・指紋)がそのまま現れるファイル。 */
export function scanLiteral(root: string, rels: readonly string[], needles: readonly string[]): string[] {
  const out: string[] = [];
  for (const rel of rels) {
    let text: string;
    try { text = readFileSync(join(root, rel.split('/').join(sep)), 'utf-8'); } catch { continue; }
    for (const n of needles) if (text.includes(n)) out.push(`${rel} :: ${n.length}文字のトークン`);
  }
  return out;
}

/** ★実際の失敗をここで作る(否定対照はこの関数が throw することで「赤くなる」ことを実証する)。 */
export function assertNoLeak(kind: string, findings: readonly Finding[]): void {
  if (findings.length === 0) return;
  const body = findings.map((f) => `  ${f.file}:${f.line} [${f.hash}] ${f.excerpt}`).join('\n');
  throw new Error(
    `非公開の決済ロジックが公開されうるファイルに漏洩しています(${kind}: ${findings.length}件)。\n${body}\n` +
    '→ 値を private.ts の外に書かないこと。意図的な偽陽性ならこのテストの例外表に理由付きで登録すること。',
  );
}

/** 否定対照を **人間が目で確かめる** ための出力(EXIT_LEAK_GUARD_FIXTURE_DIR を指定したときだけ)。
 *  ★中身は出さない(位置と判定だけ): 検出できたことの証明に実数値もキー名も要らないし、
 *    ログに残す理由も無い。フィクスチャは秘密そのものを含むので、この出力にも本文は載せない。 */
function report(kind: string, dir: string, found: readonly Finding[]): void {
  if (!process.env.EXIT_LEAK_GUARD_FIXTURE_DIR) return;
  console.warn(`[leak-guard/否定対照] ${kind}: fixtures=${dir} → assertNoLeak が throw(=赤くなる)`);
  for (const f of found) console.warn(`  検出 ${f.file}:${f.line} kind=${f.kind} paired=${f.paired}`);
}

/** 秘密と衝突しないと **実行時に保証** された数(フィクスチャ用)。
 *  ソースに裸のリテラルを残さないための道具(trade2 版から引き継いだ考え方)。 */
function nonSecretSample(h: Harvest, seed: number): number {
  let n = seed;
  while (h.numbers.has(n)) n += 1;
  return n;
}

// ─── テスト ──────────────────────────────────────────────────────────────────

const SKIP_MSG =
  '[leak-guard] ./private.ts が無いため漏洩検査を skip しました' +
  '(照合すべき秘密が手元に無い環境=公開クローン/CI。検査は秘密を持つ開発機の責務)。';

let harvest: Harvest | null = null;
let files: string[] = [];
let findings: Finding[] = [];

beforeAll(async () => {
  files = gitKnownTextFiles(REPO_ROOT);
  harvest = await harvestSecrets();
  if (harvest) findings = scanFiles(REPO_ROOT, files, harvest);
});

describe('★漏洩検査: 非公開の決済ロジックが公開リポへ渡らない', () => {
  it('① private の実ファイルが git 追跡されていない(最後の防壁)', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0').filter((p) => p.length > 0),
    );
    for (const p of SECRET_PATHS) {
      expect(tracked.has(p), `${p} が git 追跡下にあります(commit すれば公開リポへ渡ります)`).toBe(false);
    }
    // 走査対象(追跡 + 未追跡非ignore)にも入っていないこと = ignore が効いている。
    for (const p of SECRET_PATHS) expect(files).not.toContain(p);
  });

  it('② .gitignore の PRIVATE-BACKUP 区間が在り、その区間の行が private を除外している', () => {
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf-8').split(/\r?\n/);
    const begin = gitignore.findIndex((l) => l.includes(BEGIN_MARK)) + 1;   // 1-origin
    const end = gitignore.findIndex((l) => l.includes(END_MARK)) + 1;
    expect(begin, `.gitignore に ${BEGIN_MARK} がありません(区間ごと消えると秘密の定義が失われます)`).toBeGreaterThan(0);
    expect(end, `.gitignore に ${END_MARK} がありません`).toBeGreaterThan(begin);

    // 区間の中に秘密ファイルのパスが書かれている。
    const block = gitignore.slice(begin, end - 1);
    for (const p of SECRET_PATHS) {
      expect(block.some((l) => l.trim() === p), `${p} が PRIVATE-BACKUP 区間にありません`).toBe(true);
    }
    // ★「書いてある」だけでなく **git が実際にその行で除外している** こと
    //   (別の行や別の .gitignore が効いていると、区間を消しても気づけない)。
    //   ★--no-index: 追跡されている状態でも「ルールとしては除外か」を答えさせる
    //     (追跡の有無は①の担当。ここで混ざると「区間が壊れた」のか「追跡された」のか区別できない)。
    const out = execFileSync('git', ['check-ignore', '-v', '--no-index', ...SECRET_PATHS], { cwd: REPO_ROOT, encoding: 'utf-8' });
    const rules = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
    expect(rules.length, `除外ルールが引けない秘密ファイルがあります(${SECRET_PATHS.length}件中${rules.length}件)`).toBe(SECRET_PATHS.length);
    for (const line of rules) {
      const m = /^(.*?):(\d+):/.exec(line);
      expect(m, `check-ignore の出力を解釈できません: ${line}`).not.toBeNull();
      expect(m![1], '除外はルート直下の .gitignore が行うこと').toBe('.gitignore');
      const no = Number(m![2]);
      expect(no > begin && no < end, `除外している行 ${no} が PRIVATE-BACKUP 区間(${begin}..${end})の外にあります`).toBe(true);
    }
  });

  it('③ 強い文脈(非公開の export 名 / 数値キー名の行)に秘密の数値が無い', async (ctx) => {
    if (!harvest) { console.warn(SKIP_MSG); ctx.skip(); return; }
    assertNoLeak('強い文脈', findings.filter((f) => f.kind === 'strong'));
  });

  it('④ 秘密のキー名そのものが公開ソースに現れない(構造の漏洩)', async (ctx) => {
    if (!harvest) { console.warn(SKIP_MSG); ctx.skip(); return; }
    const hits = scanLiteral(REPO_ROOT, files, harvest.cfgKeys);
    expect(hits, `決済ラダーのキー名が公開ソースにあります:\n${hits.join('\n')}`).toEqual([]);
  });

  it('⑤ 定義の指紋(hex)が公開ソースに現れない', async (ctx) => {
    if (!harvest) { console.warn(SKIP_MSG); ctx.skip(); return; }
    expect(harvest.fingerprints.length, '指紋が1つも見つからない = 収集が空振りしている可能性').toBeGreaterThan(0);
    const hits = scanLiteral(REPO_ROOT, files, harvest.fingerprints);
    expect(hits, `定義の指紋が公開ソースにあります:\n${hits.join('\n')}`).toEqual([]);
  });

  it('⑥ 段のペア(cfg に同居する2値が同一行)が無い ※既知の偽陽性は行ハッシュで登録', async (ctx) => {
    if (!harvest) { console.warn(SKIP_MSG); ctx.skip(); return; }
    const paired = findings.filter((f) => f.paired);
    const allow = new Map(PAIR_ALLOW.map((a) => [a.hash, a.why]));
    assertNoLeak('段のペア', paired.filter((f) => !allow.has(f.hash)));
    // 例外表を腐らせない: 登録したハッシュが1つも当たらなくなったら消すこと。
    const seen = new Set(paired.map((f) => f.hash));
    const stale = PAIR_ALLOW.filter((a) => !seen.has(a.hash));
    expect(stale.map((s) => `${s.hash} (${s.why})`), '例外表に古い行が残っています(該当行が消えた/変わった)').toEqual([]);
  });

  it('⑦ 弱い文脈の一致が baseline を超えない(新しい一致は必ず赤くなる)', async (ctx) => {
    if (!harvest) { console.warn(SKIP_MSG); ctx.skip(); return; }
    const byFile = new Map<string, Finding[]>();
    for (const f of findings) {
      if (f.kind !== 'weak') continue;
      const arr = byFile.get(f.file) ?? [];
      arr.push(f);
      byFile.set(f.file, arr);
    }
    const unexpected: Finding[] = [];
    for (const [file, arr] of byFile) {
      const limit = WEAK_BASELINE[file];
      if (limit === undefined) { unexpected.push(...arr); continue; }
      if (arr.length > limit) unexpected.push(...arr.slice(limit));
    }
    assertNoLeak('弱い文脈(baseline 超過)', unexpected);
    // 例外表を腐らせない: 1件も当たらなくなったファイルは表から消す。
    const stale = Object.keys(WEAK_BASELINE).filter((f) => !byFile.has(f));
    expect(stale, '弱い文脈の例外表に古い項目が残っています(該当が消えた)').toEqual([]);
  });

  it('⑧ 否定対照: わざと漏洩させたファイルを食わせると必ず赤くなる(強/弱の両方)', async (ctx) => {
    if (!harvest) { console.warn(SKIP_MSG); ctx.skip(); return; }
    const h = harvest;
    const secret = [...h.numbers][0]!;
    const pair = [...h.pairs][0]!.split('|').map(Number);
    const key = h.cfgKeys[0]!;
    const safe = nonSecretSample(h, 7_777);

    const dir = process.env.EXIT_LEAK_GUARD_FIXTURE_DIR
      ? (mkdirSync(process.env.EXIT_LEAK_GUARD_FIXTURE_DIR, { recursive: true }), process.env.EXIT_LEAK_GUARD_FIXTURE_DIR)
      : mkdtempSync(join(tmpdir(), 'exit-leak-guard-'));
    try {
      // 実行時に組み立てる = このソースには秘密の数字が残らない。
      writeFileSync(join(dir, 'leak-strong.ts'), `export const cfg = { ${key}: ${secret} };\n`, 'utf-8');
      writeFileSync(join(dir, 'leak-weak.ts'), `// 含み益ピークが ${pair[0]} を超えたら床は ${pair[1]}\n`, 'utf-8');
      writeFileSync(join(dir, 'clean.ts'), `// 含み益ピークが ${safe} を超えたら床は ${safe} (実値ではない)\n`, 'utf-8');

      const strong = scanFiles(dir, ['leak-strong.ts'], h);
      expect(strong.map((f) => f.kind)).toEqual(['strong']);
      expect(() => assertNoLeak('強い文脈', strong)).toThrowError(/漏洩/);
      report('強い文脈', dir, strong);

      const weak = scanFiles(dir, ['leak-weak.ts'], h);
      expect(weak.map((f) => f.kind)).toEqual(['weak']);
      expect(weak.every((f) => f.paired), '段のペアとして検出されること').toBe(true);
      expect(() => assertNoLeak('段のペア', weak)).toThrowError(/漏洩/);
      report('段のペア', dir, weak);

      // 対照: 実値でない数字なら鳴らない(検出器が何でも赤くしているのではない)。
      expect(scanFiles(dir, ['clean.ts'], h)).toEqual([]);
      // キー名の検査も同様に効く。
      expect(scanLiteral(dir, ['leak-strong.ts'], h.cfgKeys).length).toBeGreaterThan(0);
      expect(scanLiteral(dir, ['clean.ts'], h.cfgKeys)).toEqual([]);
    } finally {
      if (!process.env.EXIT_LEAK_GUARD_FIXTURE_DIR) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('⑨ 抽出器の性質(空振り・誤検知の両方を防いでいる)', async (ctx) => {
    if (!harvest) { console.warn(SKIP_MSG); ctx.skip(); return; }
    const ns = nonSecretSample(harvest, 7_777);
    // 単位付き・記号付きでも拾う(★非公開の説明文はこの形。trade2 版の \b\d+\b では取り逃していた)
    expect(extractNumbers(`peak >= ${ns}pt`, [])).toContain(ns);
    expect(extractNumbers(`床=建値±${ns}(実質BE)`, [])).toContain(ns);
    // 識別子の中の数字は拾わない
    expect(extractNumbers(`const c${ns} = f(); sh0${ns};`, [])).toEqual([]);
    // 桁区切りは1つの数として扱う(部分列の偶然一致を防ぐ)
    expect(extractNumbers(`price = ${ns}_000, ${ns},000`, [])).toEqual([Number(`${ns}000`), Number(`${ns}000`)]);
    // 日付・小数・指摘番号は値ではない
    expect(extractNumbers('docs/2026-06-25-phase-exit-design.md', [])).toEqual([]);
    expect(extractNumbers(`v0.${ns}.${ns} / 0.${ns}`, [])).toEqual([]);
    expect(extractNumbers(`Finding #${ns}`, [])).toEqual([]);
    // 文脈トークンに含まれる数字は判定前に除去される
    expect(extractNumbers(`phase${ns}Step`, [`phase${ns}Step`])).toEqual([]);
    // 走査対象は実在し、秘密も実在する(空振りしていない)
    expect(files.length).toBeGreaterThan(0);
    expect(harvest.numbers.size).toBeGreaterThan(0);
    expect(harvest.cfgKeys.length).toBeGreaterThan(0);
    expect(harvest.exportNames.length).toBeGreaterThan(0);
    expect(files).toContain(SELF_REL);   // ★このテスト自身も走査対象
  });

  it('⑩ 自己検査: このテストのソース自身に秘密(数値・キー名・指紋)が入っていない', async (ctx) => {
    if (!harvest) { console.warn(SKIP_MSG); ctx.skip(); return; }
    const self = readFileSync(join(REPO_ROOT, SELF_REL.split('/').join(sep)), 'utf-8');
    // 文脈の有無に関わらず、**裸の一致** すら1つも無いこと(検査そのものが漏洩にならない)。
    const bare = [...new Set(extractNumbers(self, []).filter((n) => harvest!.numbers.has(n)))];
    expect(bare.length, `このテストのソースに秘密の数値が ${bare.length} 個あります(値は出しません)`).toBe(0);
    expect(scanLiteral(REPO_ROOT, [SELF_REL], harvest.cfgKeys)).toEqual([]);
    expect(scanLiteral(REPO_ROOT, [SELF_REL], harvest.fingerprints)).toEqual([]);
    expect(scanText(SELF_REL, self, harvest)).toEqual([]);
  });
});

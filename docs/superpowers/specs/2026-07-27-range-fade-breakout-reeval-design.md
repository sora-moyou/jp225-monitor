# レンジ両指値が平均以上未約定 → AIがブレイク(両逆指値)再評価

日付: 2026-07-27 / 対象: monitor(signal engine + scalp-plan)+ trade2(既存の armed差替え追従) / 前提: シグナル完全一致・doten と同型の armed 再評価

## 1. 目的
レンジ両指値(fade straddle=上下とも limit の逆張り)が「ARM→約定の平均所要時間」を明確に超えても約定しない=**レンジが反発せず抜けそう**な兆候。この時 AI に**両逆指値(breakout straddle=抜け追随)へ切替**を検討させ、適当ならシグナルを差し替える。反発が続きそうなら現状維持、場面が崩れたら見送り。

## 2. トリガー
- 対象 = **ARMED かつ mode='range' かつ両レッグとも limit**(fade)。単一レッグ/directional/既に breakout(stop) の range は対象外。
- 発火条件: `now − armed.at > avgFillMs × REEVAL_FACTOR`(既定 `REEVAL_FACTOR = 1.5`)。
  - `avgFillMs` = 直近 N(=20)件の **ARM→約定所要時間 `position.at − armed.at`** の移動平均。約定ごとに記録・更新(在庫が `MIN_SAMPLES`=5 未満なら **フォールバック既定 `DEFAULT_AVG_FILL_MS`**(例 3分)を使用)。
  - 過大暴走防止に上限 `REEVAL_CAP_MS`(例 12分・ARMED_TIMEOUT 15分より手前)でクランプ。
- ★config トグル `rangeReevalEnabled`(レンジ有効時 既定 ON・個別 OFF 可)。OFF なら本経路は完全に不活性=挙動不変。

## 3. 動作(armed 再評価・doten held-eval と同型の機構)
- `maybeRequestRangeReeval`(engine): ARMED 分岐で条件成立時に AI 要求。
  - **planning 共有**(flat-plan / doten / これが同時に AI を叩かない)、`inPollWindow` ゲート、クールダウン(過度な差替え抑制)。
  - **★async 同一 armed 再チェック**: 要求時に対象 armed の識別(armed.at + signalId + mode)を控え、AI 応答解決時に「まだ同じ未約定 armed」でなければ破棄(約定/取消/差替え済みなら幽霊差替えしない)。
- **プロンプト注入**(scalp-plan): 「現在レンジ両指値を ARM後 {分} 未約定(平均 {分} を超過)。レンジが反発せず抜けそうなら **両逆指値(ブレイク追随)** へ切替えたプランを返してよい(direction:range・両レッグ type:stop)。反発継続が見込めるなら **現状維持**(同じ両指値を返す=差替えない)。場面が崩れたなら **direction:none**(見送り=取消)。」heldPosition ではなく `armedContext?:{mode:'range-fade', ageMs, avgMs}` を注入。
- **反映**: AI 応答をサニティ(`checkSanity`/`checkRangeSanity`)通過確認 → armed ブラケットを**差替え**(新 signalId を1回採番・currentSignal 更新・broadcast)。none → 取消 FLAT。同一(維持)→ 何もしない。
- SSE は既存 armed/currentSignal 契約のまま(mode/range/signalId)。新フィールドは足さない(差替えは通常の armed 更新)。

## 4. trade2 側
- **既存の armed 差替え追従で対応**: monitor が armed を新 signalId で差し替えると、trade2 の `maybeResyncCancelArmed`(v0.1.45)が **stale armed(旧両指値)を取消 → 新 armed(両逆指値)を追従**。fade→breakout はレッグ種別が変わるだけで、trade2 は currentSignal の range.upper/lower(side/type/entry/SL)をそのまま発注する(type=stop で逆指値発注)。
- **要検証(エバリュエーター)**: (a) 旧両指値の未約定注文が確実に取消される(裸/重複なし)、(b) 新両逆指値が正しく逆指値として発注される、(c) 差替えの瞬間に never-naked を侵さない(まだ FLAT=建玉なしなので naked リスクは無い=armed同士の差替え)。

## 5. 段階・検証
- `rangeReevalEnabled` 既定 ON(レンジ有効時)だが、**レンジ自体が既定 OFF**(v0.7.53 実験終了)なので、レンジを使う設定の時だけ効く。レンジ OFF なら完全不活性。
- 記録: 差替え発生を ai_events/meta に残し(旧→新 signalId・age/avg)、後で「切替が妥当だったか(新breakoutの結果)」を突合可能に。
- テスト: avgFill 集計(N/最小サンプル/フォールバック/クランプ)、トリガー純関数(fade限定・factor超過で true・非fade/非range/OFFで false)、async 再チェック(差替え済みで破棄)、AI応答=breakout差替え/維持/none の各分岐、既定OFFでバイト不変。

## 6. 定数(既定)
- `REEVAL_FACTOR = 1.5` / `AVG_FILL_SAMPLES = 20` / `MIN_SAMPLES = 5` / `DEFAULT_AVG_FILL_MS = 180_000`(3分) / `REEVAL_CAP_MS = 720_000`(12分)。いずれも定数化(将来調整可)。

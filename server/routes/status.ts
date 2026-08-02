import type { Request, Response } from 'express';
import { getYahooStatus } from '../loops/priceLoop.js';
import { getProviderStatus } from '../llm/openai.js';
import { generatorGateSnapshot } from '../llm/generatorGate.js';

export function statusHandler(_req: Request, res: Response): void {
  res.json({
    yahoo: getYahooStatus(),
    // ★既存フィールドは不変: llm は従来どおり **default プール**(実弾につながる経路)の状態。
    llm: getProviderStatus(),
    // ★追加(additive): 提案生成器の予算/従属停止/backpressure の状況。
    //   「飛ばしたことを必ず記録する」= ログだけでなく画面/HTTP からも見えるようにする。API キーは含まない。
    generator: generatorGateSnapshot(),
  });
}

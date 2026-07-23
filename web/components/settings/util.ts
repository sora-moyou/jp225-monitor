// 設定モーダル共通の小ヘルパ。settingsModal.ts から純粋に切り出したもの(挙動不変)。

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

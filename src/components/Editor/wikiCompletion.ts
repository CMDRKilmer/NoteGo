import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { ipc } from '../../lib/ipc';

/**
 * `[[wiki]]` 双向链接自动补全源
 *
 * 触发条件：光标前出现 `[[`
 * - 输入即时获取候选（通过 ipc.searchNotes）
 * - 若 query 为空，会由 ipc 层 fallback 到 listNotes 取前 50 条
 * - apply 时自动补齐 `]]`
 */
export const wikiLinkCompletion = (
  context: CompletionContext,
): Promise<CompletionResult | null> => {
  // 找到光标前的 [[
  const before = context.matchBefore(/\[\[/);
  if (!before) return Promise.resolve(null);
  if (before.from === before.to && !context.explicit) {
    return Promise.resolve(null);
  }

  // 提取 [[ 后的查询文本
  const text = context.state.doc.sliceString(before.from, context.pos);
  const query = text.replace(/^\[\[/, '');

  return ipc
    .searchNotes(query || '*')
    .then((hits) => {
      // searchNotes 返回的是 SearchHit[]，含 path/title
      // 空 query 时 listNotes 返回 NoteRecord[]，同样有 path/title
      const options: Completion[] = hits.slice(0, 20).map((hit) => {
        const title = hit.title;
        const path = hit.path;
        return {
          label: title,
          type: 'note',
          detail: path,
          apply: (view, _completion, from, to) => {
            // 从 [[ 之后开始替换（from + 2 跳过 [[）
            const insertFrom = from + 2;
            const titleLen = title.length;
            // 先替换 query 部分为 title
            view.dispatch({
              changes: { from: insertFrom, to, insert: title },
            });
            // 在 title 末尾追加 ]]
            const closeFrom = insertFrom + titleLen;
            view.dispatch({
              changes: { from: closeFrom, insert: ']]' },
              selection: { anchor: closeFrom },
            });
          },
        } as Completion;
      });

      return {
        from: before.from + 2, // 跳过 [[
        options,
        validFor: /^[^\]\n]*$/,
      } as CompletionResult;
    })
    .catch((err) => {
      console.error('[wikiLinkCompletion] search failed:', err);
      return null;
    });
};

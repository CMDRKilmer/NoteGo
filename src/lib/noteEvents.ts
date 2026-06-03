import { useAppStore } from '../store/appStore';

/**
 * 全局笔记事件桥接器
 *
 * 把组件层通过 `window.dispatchEvent(new CustomEvent('notego:open-note', ...))`
 * 派发的自定义事件，映射到全局 store 的 `openNote` action。
 *
 * 在 main.tsx 中调用一次 setupNoteEventBridge() 即可。
 */
export function setupNoteEventBridge(): void {
  window.addEventListener('notego:open-note', (e: Event) => {
    const detail = (e as CustomEvent<{ path?: string }>).detail;
    const path = detail?.path;
    if (path) {
      useAppStore.getState().openNote(path);
    }
  });
}

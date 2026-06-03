import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * 后端推送的 Vault 事件载荷（对应 `src-tauri/src/watcher.rs` 中的 `VaultEvent`）。
 *
 * 使用判别式联合：可通过 `e.type` 区分四类事件。
 */
export type VaultEvent =
  | { type: 'created'; path: string }
  | { type: 'modified'; path: string }
  | { type: 'deleted'; path: string }
  | { type: 'renamed'; oldPath: string; newPath: string };

/** emit 顶层负载：`{ "event": VaultEvent }` */
interface EmitPayload {
  event: VaultEvent;
}

export const vaultEvents = {
  /**
   * 监听后端推送的笔记变更事件。
   * 返回 `UnlistenFn`，组件卸载时记得调用以释放资源。
   */
  onNoteChanged: (handler: (e: VaultEvent) => void): Promise<UnlistenFn> =>
    listen<EmitPayload>('vault://note', (e) => handler(e.payload.event)),
};

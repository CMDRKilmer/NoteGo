import { create } from 'zustand';
import type { NoteRecord, Vault } from '../types/note';

/**
 * 全局应用状态（zustand）
 *
 * 只放**跨组件共享的 UI / 数据状态**；编辑器内部缓冲（未保存内容等）
 * 留在 Editor 自己的 useState 中，避免无谓的全局 re-render。
 */
interface AppState {
  /** 当前打开的 Vault；`null` 表示欢迎页 */
  vault: Vault | null;
  /** Vault 内所有笔记元数据 */
  notes: NoteRecord[];
  /** 当前编辑器中打开的笔记相对路径；`null` 表示未选 */
  activePath: string | null;

  /** 替换 Vault；切换 Vault 时自动清空 activePath */
  setVault: (vault: Vault | null) => void;
  /** 全量替换笔记列表（首次加载 / 整体刷新） */
  setNotes: (notes: NoteRecord[]) => void;
  /** 切换当前编辑笔记 */
  setActivePath: (path: string | null) => void;
  /** 单条 upsert（按 path 匹配） */
  upsertNote: (note: NoteRecord) => void;
  /** 按 path 删除 */
  removeNote: (path: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  vault: null,
  notes: [],
  activePath: null,

  setVault: (vault) => set({ vault, activePath: null }),
  setNotes: (notes) => set({ notes }),
  setActivePath: (activePath) => set({ activePath }),

  upsertNote: (note) =>
    set((s) => {
      const idx = s.notes.findIndex((n) => n.path === note.path);
      if (idx >= 0) {
        const next = s.notes.slice();
        next[idx] = note;
        return { notes: next };
      }
      return { notes: [...s.notes, note] };
    }),

  removeNote: (path) =>
    set((s) => ({ notes: s.notes.filter((n) => n.path !== path) })),
}));

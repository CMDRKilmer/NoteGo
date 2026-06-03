import { useEffect, useState, useRef, useCallback } from 'react';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { MarkdownView } from './MarkdownView';
import { ipc } from '../../lib/ipc';
import { useAppStore } from '../../store/appStore';
import { vaultEvents } from '../../lib/events';

type ViewMode = 'source' | 'split' | 'preview';

/**
 * 编辑器（Task 5 完整版）
 *
 * - CodeMirror 6 源码编辑（含 [[wiki]] 补全）
 * - react-markdown 预览（GFM / Math / Mermaid / Callout / WikiLink）
 * - 三种模式：源码 / 分屏 / 预览
 * - 500ms 防抖自动保存
 * - Ctrl/Cmd+S 手动保存
 * - 主题跟随系统 prefers-color-scheme
 * - 监听外部 modified 事件，给出重载确认
 */
export function Editor(): JSX.Element {
  const activePath = useAppStore((s) => s.activePath);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [mode, setMode] = useState<ViewMode>('split');
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
  );
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);

  // 同步 content 到 ref，避免 effect 依赖 content 导致重订阅
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // 加载笔记
  useEffect(() => {
    if (!activePath) {
      setContent('');
      setSavedContent('');
      return;
    }
    let cancelled = false;
    ipc
      .readNote(activePath)
      .then((c) => {
        if (cancelled) return;
        setContent(c);
        setSavedContent(c);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[Editor] readNote failed:', err);
        setContent(`# 错误\n\n无法读取：${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  // 监听外部修改
  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    vaultEvents
      .onNoteChanged((e) => {
        if (cancelled) return;
        if (
          e.type === 'modified' &&
          'path' in e &&
          e.path === activePath
        ) {
          ipc
            .readNote(activePath)
            .then((c) => {
              if (cancelled) return;
              if (c !== contentRef.current) {
                const ok = window.confirm(
                  '笔记已被外部修改。是否重新加载？\n点击"确定"将丢弃当前未保存的修改。',
                );
                if (ok && !cancelled) {
                  setContent(c);
                  setSavedContent(c);
                }
              }
            })
            .catch((err) => {
              if (cancelled) return;
              console.error('[Editor] external readNote failed:', err);
            });
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[Editor] onNoteChanged subscribe failed:', err);
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [activePath]);

  // 卸载时清理 saveTimer，防止组件卸载后仍尝试写文件
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, []);

  // 防抖保存
  const handleChange = useCallback(
    (value: string) => {
      setContent(value);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (value !== savedContent && activePath) {
          ipc
            .writeNote(activePath, value)
            .then(() => setSavedContent(value))
            .catch((err) => {
              console.error('[Editor] writeNote failed:', err);
            });
        }
      }, 500);
    },
    [activePath, savedContent],
  );

  // 手动保存 (Ctrl/Cmd+S)
  const handleSave = useCallback(() => {
    if (!activePath) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    ipc
      .writeNote(activePath, content)
      .then(() => setSavedContent(content))
      .catch((err) => {
        console.error('[Editor] manual save failed:', err);
      });
  }, [activePath, content]);

  // 主题跟随系统
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) =>
      setTheme(e.matches ? 'dark' : 'light');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  if (!activePath) {
    return <div className="editor-empty">选择一篇笔记开始编辑</div>;
  }

  return (
    <div className="editor" data-theme={theme}>
      <div className="editor-toolbar">
        <div className="editor-toolbar__path" title={activePath}>
          {activePath}
        </div>
        <div className="editor-toolbar__modes">
          <button
            className={mode === 'source' ? 'active' : ''}
            onClick={() => setMode('source')}
          >
            源码
          </button>
          <button
            className={mode === 'split' ? 'active' : ''}
            onClick={() => setMode('split')}
          >
            分屏
          </button>
          <button
            className={mode === 'preview' ? 'active' : ''}
            onClick={() => setMode('preview')}
          >
            预览
          </button>
        </div>
        <div className="editor-toolbar__status">
          <span>
            {content !== savedContent ? '● 未保存' : '✓ 已保存'}
          </span>
          <span className="editor-toolbar__wordcount">
            {content.length} 字符
          </span>
        </div>
      </div>

      <div className="editor-body" data-mode={mode}>
        {mode !== 'preview' && (
          <div className="editor-pane">
            <CodeMirrorEditor
              value={content}
              onChange={handleChange}
              theme={theme}
              onSave={handleSave}
            />
          </div>
        )}
        {mode !== 'source' && (
          <div className="preview-pane">
            <MarkdownView content={content} />
          </div>
        )}
      </div>
    </div>
  );
}

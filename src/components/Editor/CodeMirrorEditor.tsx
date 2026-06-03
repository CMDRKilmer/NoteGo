import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
} from '@codemirror/language';
import {
  autocompletion,
  completionKeymap,
} from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { wikiLinkCompletion } from './wikiCompletion';

interface Props {
  value: string;
  onChange: (value: string) => void;
  theme: 'light' | 'dark';
  onSave: () => void;
}

/**
 * CodeMirror 6 封装组件
 *
 * - 挂载时创建一次 EditorView（避免重复创建导致光标丢失）
 * - `value` prop 变化时通过 dispatch 同步（仅在内容不同时）
 * - 主题切换通过 Compartment.reconfigure 实现热更新
 * - 内置 `[[wiki]]` 自动补全源
 * - Ctrl/Cmd+S 触发 onSave
 */
export function CodeMirrorEditor({
  value,
  onChange,
  theme,
  onSave,
}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const updatingFromProp = useRef(false);
  // 缓存 onChange/onSave 回调，避免 effect 重新触发
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // 挂载：创建 EditorView
  useEffect(() => {
    if (!ref.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        highlightSelectionMatches(),
        autocompletion(),
        markdown({ base: markdownLanguage, codeLanguages: [] }),
        wikiLinkCompletion,
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          indentWithTab,
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
        ]),
        themeCompartment.current.of(theme === 'dark' ? oneDark : []),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !updatingFromProp.current) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: ref.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 仅在挂载时创建一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 变化时同步到 editor（用于加载笔记）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== value) {
      updatingFromProp.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
      updatingFromProp.current = false;
    }
  }, [value]);

  // 主题切换
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        theme === 'dark' ? oneDark : [],
      ),
    });
  }, [theme]);

  return <div className="cm-editor-container" ref={ref} />;
}

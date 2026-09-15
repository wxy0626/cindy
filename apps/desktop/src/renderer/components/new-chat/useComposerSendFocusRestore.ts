import { useCallback, useEffect, useRef } from 'react';

import { isInteractiveFocusedElement } from './composerBlankPointerFocus';

export interface ComposerFocusEditor {
  readonly isDestroyed: boolean;
  readonly isEditable: boolean;
  readonly isFocused: boolean;
  readonly view: { readonly dom: HTMLElement };
  readonly commands: { focus: () => unknown };
}

interface PendingComposerFocusRestore {
  readonly editor: ComposerFocusEditor;
  readonly focusAnchor: Element | null;
}

// tiptap v3 的 editor.view 是惰性 Proxy：editorView 尚未设置（编辑器未挂载 / 已 unmount）时，
// 除 stub 属性（state/composing/dragging/editable/isDestroyed）外的任何属性访问都会直接
// throw（"[tiptap error]: The editor view is not available..."）。React Activity/Offscreen
// 重连（reconnectPassiveEffects）时，本 hook 的 passive effect 可能先于 tiptap 自身的
// remount 执行，此时读 editor.view.dom 会抛错并击穿整个 React 树（表现为错误边界
// 「界面出错了」）。因此所有取 dom 的路径统一走该 helper：拿不到就返回 null，由调用方按
// 「composer 当前不在 DOM 中」处理，绝不在 setup/渲染路径上直接访问 view Proxy。
function tryGetEditorDom(editor: ComposerFocusEditor | null): HTMLElement | null {
  if (!editor || editor.isDestroyed) return null;
  try {
    return editor.view.dom;
  } catch {
    return null;
  }
}

export function hasFocusMovedToInteractiveElement(
  focusAnchor: Element | null,
  editorDom: HTMLElement,
): boolean {
  const activeElement = editorDom.ownerDocument.activeElement;
  if (
    !activeElement ||
    activeElement === editorDom.ownerDocument.body ||
    activeElement === editorDom.ownerDocument.documentElement
  ) {
    return false;
  }
  if (activeElement === focusAnchor) return false;
  if (editorDom.contains(activeElement)) return false;
  return isInteractiveFocusedElement(activeElement);
}

export function hasNonCollapsedSelectionOutsideComposer(editorDom: HTMLElement): boolean {
  const selection = editorDom.ownerDocument.getSelection?.() ?? null;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return false;
  return !editorDom.contains(anchorNode) || !editorDom.contains(focusNode);
}

export function useComposerSendFocusRestore(
  editor: ComposerFocusEditor | null,
  composerTypingLocked: boolean,
): () => void {
  const pendingRestoreRef = useRef<PendingComposerFocusRestore | null>(null);

  useEffect(() => {
    if (!editor) return;
    // 不能在 setup 阶段读 editor.view.dom（背景见 tryGetEditorDom 注释）：Activity 重连时
    // 本 effect 可能先于 tiptap 的 remount 执行。composer 与本监听必然同文档，因此直接挂在
    // document 上，不依赖未挂载阶段拿不到的 ownerDocument。
    const cancelRestoreForOutsidePointer = (event: PointerEvent) => {
      const pendingRestore = pendingRestoreRef.current;
      if (!pendingRestore || pendingRestore.editor !== editor) return;
      const editorDom = tryGetEditorDom(editor);
      const target = event.target;
      if (editorDom && target instanceof Node && editorDom.contains(target)) return;
      // editorDom 为 null（未挂载）时 composer 不可能包含点击目标，视作点击在 composer 外，
      // 与旧语义一致地清空待恢复 intent。
      pendingRestoreRef.current = null;
    };

    document.addEventListener('pointerdown', cancelRestoreForOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', cancelRestoreForOutsidePointer, true);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor || composerTypingLocked) return;

    const pendingRestore = pendingRestoreRef.current;
    if (!pendingRestore) return;
    if (pendingRestore.editor !== editor) {
      pendingRestoreRef.current = null;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (pendingRestoreRef.current !== pendingRestore) return;
      const editorDom = tryGetEditorDom(editor);
      // editor.view 不可用（未挂载 / Activity 重连先于 remount）时保留 pending intent，
      // 直接等下一次解锁后的 effect 重试：既不能 focus，也不能丢弃恢复意图——与下方
      // 「第二次加锁保留 intent」语义一致，编辑器重新挂载后仍应恢复焦点。
      if (!editorDom) return;
      // A second lock can begin before this frame runs. Keep the pending intent
      // so the next unlocked effect can try again instead of dropping it.
      if (!editor.isEditable) return;
      if (editor.isFocused) {
        pendingRestoreRef.current = null;
        return;
      }
      if (
        hasFocusMovedToInteractiveElement(pendingRestore.focusAnchor, editorDom) ||
        hasNonCollapsedSelectionOutsideComposer(editorDom)
      ) {
        pendingRestoreRef.current = null;
        return;
      }

      pendingRestoreRef.current = null;
      editor.commands.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [composerTypingLocked, editor]);

  return useCallback(() => {
    // dispatchSend 会在本地路径与远端路径各捕获一次焦点（第二处在 effort settle 后触发）。
    // 旧实现 restoreFocusAfterDispatchRef 用 || 合并防止互相覆盖；此捕获函数是直接赋值，
    // 本地路径第一处捕获后 setEditable(false) 已打掉焦点，第二处捕获时 editor.isFocused 为 false，
    // 会把第一处记住的 intent 覆盖成 null，解锁后不再恢复光标。
    // 因此同一 editor 已有待恢复 intent 时，后续捕获直接跳过。
    if (pendingRestoreRef.current && pendingRestoreRef.current.editor === editor) {
      return;
    }
    const editorDom = tryGetEditorDom(editor);
    pendingRestoreRef.current =
      editor && editorDom && editor.isFocused
        ? { editor, focusAnchor: editorDom.ownerDocument.activeElement }
        : null;
  }, [editor]);
}

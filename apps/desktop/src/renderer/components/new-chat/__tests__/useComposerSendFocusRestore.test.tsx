// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, fireEvent, renderHook } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useComposerSendFocusRestore } from '../useComposerSendFocusRestore';

interface HarnessProps {
  sendDispatchInFlight: boolean;
  allowTypeDuringSend: boolean;
  voiceLocked: boolean;
}

let createdEditors: Editor[] = [];

function createEditor(): Editor {
  const mount = document.createElement('div');
  document.body.append(mount);
  const editor = new Editor({
    element: mount,
    extensions: [Document, Paragraph, Text],
    content: '<p>next message</p>',
    editorProps: { handleScrollToSelection: () => true },
  });
  createdEditors.push(editor);
  return editor;
}

describe('useComposerSendFocusRestore', () => {
  let nextFrameId = 1;
  let frames = new Map<number, FrameRequestCallback>();

  beforeEach(() => {
    createdEditors = [];
    frames = new Map();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
  });

  afterEach(() => {
    for (const editor of createdEditors) editor.destroy();
    document.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const flushAnimationFrames = () => {
    act(() => {
      for (let round = 0; frames.size > 0 && round < 10; round += 1) {
        const pendingFrames = [...frames.values()];
        frames.clear();
        for (const callback of pendingFrames) callback(0);
      }
    });
  };

  const typingLocked = ({
    sendDispatchInFlight,
    allowTypeDuringSend,
    voiceLocked,
  }: HarnessProps) => voiceLocked || (sendDispatchInFlight && !allowTypeDuringSend);

  const renderRestoreHook = (editor: Editor) =>
    renderHook(
      (props: HarnessProps) => {
        const composerTypingLocked = typingLocked(props);
        useEffect(() => {
          editor.setEditable(!composerTypingLocked);
        }, [composerTypingLocked, editor]);
        return useComposerSendFocusRestore(editor, composerTypingLocked);
      },
      {
        initialProps: {
          sendDispatchInFlight: false,
          allowTypeDuringSend: false,
          voiceLocked: false,
        },
      },
    );

  const focusComposerSelection = (editor: Editor) => {
    act(() => {
      editor.commands.setTextSelection({ from: 2, to: 6 });
      editor.view.focus();
    });
    expect(document.activeElement).toBe(editor.view.dom);
  };

  it('restores the focused composer after the temporary send lock', () => {
    const editor = createEditor();
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({
      sendDispatchInFlight: true,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    act(() => editor.view.dom.blur());
    expect(document.activeElement).toBe(document.body);

    hook.rerender({
      sendDispatchInFlight: false,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    flushAnimationFrames();

    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.selection.to).toBe(6);
  });

  it('keeps the intent captured before the first lock when a later capture observes blurred state', () => {
    const editor = createEditor();
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({
      sendDispatchInFlight: true,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    act(() => editor.view.dom.blur());
    // dispatchSend captures a second time after the lock stole focus; this must
    // not overwrite the intent captured while the composer was still focused.
    act(() => {
      hook.result.current();
    });
    hook.rerender({
      sendDispatchInFlight: false,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    flushAnimationFrames();

    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('keeps the restore intent until every composer lock is released', () => {
    const editor = createEditor();
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({
      sendDispatchInFlight: true,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    act(() => editor.view.dom.blur());

    // The send lock has settled, but voice input still owns the typing lock.
    hook.rerender({
      sendDispatchInFlight: false,
      allowTypeDuringSend: false,
      voiceLocked: true,
    });
    flushAnimationFrames();
    expect(document.activeElement).toBe(document.body);

    hook.rerender({
      sendDispatchInFlight: false,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    flushAnimationFrames();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('does not steal focus from another interactive control', () => {
    const editor = createEditor();
    const button = document.createElement('button');
    document.body.append(button);
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({
      sendDispatchInFlight: true,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    act(() => button.focus());
    hook.rerender({
      sendDispatchInFlight: false,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    flushAnimationFrames();

    expect(document.activeElement).toBe(button);
  });

  it('preserves a non-collapsed message selection created during the send lock', () => {
    const editor = createEditor();
    const message = document.createElement('p');
    const messageText = document.createTextNode('select this message');
    message.append(messageText);
    document.body.prepend(message);
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({
      sendDispatchInFlight: true,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    act(() => {
      editor.view.dom.blur();
      const range = document.createRange();
      range.setStart(messageText, 0);
      range.setEnd(messageText, 6);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

    hook.rerender({
      sendDispatchInFlight: false,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    flushAnimationFrames();

    expect(document.activeElement).toBe(document.body);
    expect(document.getSelection()?.toString()).toBe('select');
  });

  it('does not interrupt a message selection drag before the range expands', () => {
    const editor = createEditor();
    const message = document.createElement('p');
    const messageText = document.createTextNode('start selecting here');
    message.append(messageText);
    document.body.prepend(message);
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({
      sendDispatchInFlight: true,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    act(() => {
      editor.view.dom.blur();
      const range = document.createRange();
      range.setStart(messageText, 0);
      range.collapse(true);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    fireEvent.pointerDown(message);

    hook.rerender({
      sendDispatchInFlight: false,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    flushAnimationFrames();

    expect(document.activeElement).toBe(document.body);
    expect(document.getSelection()?.isCollapsed).toBe(true);
    expect(document.getSelection()?.anchorNode).toBe(messageText);
  });

  it('restores focus when typing is allowed during an in-flight send', () => {
    const editor = createEditor();
    const hook = renderRestoreHook(editor);

    focusComposerSelection(editor);
    act(() => {
      hook.result.current();
    });
    hook.rerender({
      sendDispatchInFlight: true,
      allowTypeDuringSend: false,
      voiceLocked: false,
    });
    act(() => editor.view.dom.blur());
    expect(document.activeElement).toBe(document.body);

    hook.rerender({
      sendDispatchInFlight: true,
      allowTypeDuringSend: true,
      voiceLocked: false,
    });
    flushAnimationFrames();

    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.selection.to).toBe(6);
  });

  // 回归：React Activity 重连（reconnectPassiveEffects）时，本 hook 的 passive effect 可能
  // 先于 tiptap 自身的 remount 执行，此时 editor.view 是惰性 Proxy，读 .dom 会直接 throw。
  // 未挂载的 editor 上 editor.isEditable/setEditable 均安全（tiptap setOptions 有
  // !editorView 守卫），故无需为 harness 加额外保护。
  describe('while the editor view is unmounted (Activity reconnect window)', () => {
    const remountEditor = (editor: Editor) => {
      const remount = document.createElement('div');
      document.body.append(remount);
      act(() => {
        editor.mount(remount);
        // jsdom 不会像真实浏览器那样在节点移除时自动收起选区；旧 view 的选区会继续挂在
        // document 上并被误判为「composer 外的非折叠选区」。清空以模拟浏览器行为。
        document.getSelection()?.removeAllRanges();
      });
    };

    it('renders without touching the lazy view proxy while the editor is unmounted', () => {
      const editor = createEditor();
      editor.unmount();

      expect(() => renderRestoreHook(editor)).not.toThrow();
    });

    it('clears the pending intent when a document pointerdown lands outside the unmounted composer', () => {
      const editor = createEditor();
      const hook = renderRestoreHook(editor);

      focusComposerSelection(editor);
      act(() => {
        hook.result.current();
      });
      hook.rerender({
        sendDispatchInFlight: true,
        allowTypeDuringSend: false,
        voiceLocked: false,
      });
      editor.unmount();

      const outside = document.createElement('button');
      document.body.append(outside);
      fireEvent.pointerDown(outside);

      remountEditor(editor);
      hook.rerender({
        sendDispatchInFlight: false,
        allowTypeDuringSend: false,
        voiceLocked: false,
      });
      flushAnimationFrames();

      // intent 已被 document 级 pointerdown 清空：解锁后不得恢复焦点。
      // （editor.commands 每次访问都是新对象，无法用 spyOn 计数，统一以焦点结果断言。）
      expect(document.activeElement).not.toBe(editor.view.dom);
    });

    it('keeps the pending intent when the restore frame fires before tiptap remounts', () => {
      const editor = createEditor();
      const hook = renderRestoreHook(editor);

      focusComposerSelection(editor);
      act(() => {
        hook.result.current();
      });
      hook.rerender({
        sendDispatchInFlight: true,
        allowTypeDuringSend: false,
        voiceLocked: false,
      });
      // 真实浏览器在 view DOM 被移除时会派发 blur 把 editor.isFocused 置回 false；
      // jsdom 不派发该事件，需像上方既有用例一样显式 blur 模拟。
      act(() => editor.view.dom.blur());
      editor.unmount();
      hook.rerender({
        sendDispatchInFlight: false,
        allowTypeDuringSend: false,
        voiceLocked: false,
      });
      flushAnimationFrames();

      // 未挂载窗口内 rAF 不得 focus（若触碰 view Proxy 会直接 throw 使本用例失败），
      // 也不得丢弃 intent——intent 是否保留由下方 remount 后的恢复结果证明。
      // 注意此时编辑器仍是未挂载态，断言里不能碰 editor.view.dom。
      expect(document.activeElement).toBe(document.body);

      remountEditor(editor);
      // 再走一次加锁→解锁，让 rAF 在 view 可用后消费保留的 intent。
      hook.rerender({
        sendDispatchInFlight: true,
        allowTypeDuringSend: false,
        voiceLocked: false,
      });
      hook.rerender({
        sendDispatchInFlight: false,
        allowTypeDuringSend: false,
        voiceLocked: false,
      });
      flushAnimationFrames();

      expect(document.activeElement).toBe(editor.view.dom);
      expect(editor.state.selection.from).toBe(2);
      expect(editor.state.selection.to).toBe(6);
    });

    it('restores the preserved selection after the editor remounts mid-send', () => {
      const editor = createEditor();
      const hook = renderRestoreHook(editor);

      focusComposerSelection(editor);
      act(() => {
        hook.result.current();
      });
      hook.rerender({
        sendDispatchInFlight: true,
        allowTypeDuringSend: false,
        voiceLocked: false,
      });
      // 同上：显式 blur 模拟浏览器在 view DOM 移除时派发的 blur。
      act(() => editor.view.dom.blur());
      editor.unmount();

      remountEditor(editor);
      hook.rerender({
        sendDispatchInFlight: false,
        allowTypeDuringSend: false,
        voiceLocked: false,
      });
      flushAnimationFrames();

      expect(document.activeElement).toBe(editor.view.dom);
      expect(editor.state.selection.from).toBe(2);
      expect(editor.state.selection.to).toBe(6);
    });
  });
});

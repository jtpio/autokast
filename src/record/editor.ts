/**
 * In-page: the text between the start of the caret's line and the caret, in the focused
 * editable element. Works for text inputs, textareas and contenteditable editors such as
 * CodeMirror (`.cm-line`). Null when no editable element has the focus.
 * Playwright serializes this function into the page: it must be self-contained.
 */
export function caretLinePrefix(): string | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    const end = active.selectionStart;
    if (end === null) {
      return null;
    }
    return active.value.slice(active.value.lastIndexOf('\n', end - 1) + 1, end);
  }
  if (!(active instanceof HTMLElement) || !active.isContentEditable) {
    return null;
  }
  const root = active.getRootNode() as Document | ShadowRoot;
  const selection =
    ('getSelection' in root && typeof root.getSelection === 'function'
      ? (root.getSelection() as Selection | null)
      : null) ?? document.getSelection();
  const caret = selection?.focusNode;
  if (!selection || !caret || !active.contains(caret)) {
    return null;
  }
  let line: Element | null = caret instanceof Element ? caret : caret.parentElement;
  while (line && line !== active) {
    if (line.classList.contains('cm-line') || !/^inline/.test(getComputedStyle(line).display)) {
      break;
    }
    line = line.parentElement;
  }
  const range = document.createRange();
  range.setStart(line ?? active, 0);
  range.setEnd(caret, selection.focusOffset);
  const text = range.toString().replace(/ /g, ' ');
  return text.slice(text.lastIndexOf('\n') + 1);
}

/**
 * The spaces and tabs at the start of a line.
 */
export function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

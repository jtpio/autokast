/**
 * In-page: blurs the elements that match `selectors`, and returns the invalid selectors.
 * The document adopts the style sheet: the blur is active before the first paint and stays
 * when the page replaces its `<head>`. The radius follows the font size, so that large
 * text is not readable. Playwright serializes this function: it must be self-contained.
 */
export function blurElements(selectors: string[]): string[] {
  const sheet = new CSSStyleSheet();
  const invalid = selectors.filter((selector) => {
    try {
      const css = `${selector} { filter: blur(max(6px, 0.4em)) !important; }`;
      // A selector with a brace can give a valid rule that has no blur.
      return !(sheet.cssRules[sheet.insertRule(css)] as CSSStyleRule).style.filter;
    } catch {
      return true;
    }
  });
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  return invalid;
}

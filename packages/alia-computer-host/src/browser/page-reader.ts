/**
 * The one piece of JavaScript the worker ever runs in a page, fixed here.
 *
 * Callers cannot send code: `browser_read` returns what this function returns,
 * nothing more. It is a STRING rather than a function so that the worker's
 * TypeScript program does not need the DOM library, and so that what runs in
 * the page is exactly what is reviewed here — not a transpiled copy.
 *
 * It returns the page's visible text and the interactive elements currently in
 * the viewport with their centre points, so a model that cannot see the
 * screenshot can still click: "button 'Sign in' at 640,412". It never returns
 * what is typed in a field (a password included); a password field is flagged
 * as one so the model knows to hand over to the person.
 */
export const MAX_PAGE_TEXT = 40_000;
export const MAX_ELEMENTS = 120;

export const READ_PAGE_SCRIPT = `(() => {
  const MAX_TEXT = ${MAX_PAGE_TEXT};
  const MAX_ELEMENTS = ${MAX_ELEMENTS};
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const body = document.body ? document.body.innerText || '' : '';
  const selector = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]',
    '[contenteditable=""]', '[contenteditable=true]',
  ].join(',');
  const elements = [];
  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= MAX_ELEMENTS) break;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const x = Math.round(Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2)));
    const y = Math.round(Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2)));
    const top = document.elementFromPoint(x, y);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const field = tag === 'input' || tag === 'textarea' || tag === 'select';
    const labelled = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    const label = clean(
      el.getAttribute('aria-label') ||
      (field
        ? labelled || el.getAttribute('placeholder') || el.getAttribute('name') ||
          ((type === 'submit' || type === 'button') ? el.value : '')
        : el.innerText || el.getAttribute('title') || el.getAttribute('alt') || ''),
    );
    const entry = { tag, label, x, y };
    if (type) entry.type = type;
    const role = el.getAttribute('role');
    if (role) entry.role = role;
    if (tag === 'a' && el.href) entry.href = String(el.href).slice(0, 200);
    if (type === 'password') entry.password = true;
    if (document.activeElement === el) entry.focused = true;
    elements.push(entry);
  }
  return {
    url: location.href,
    title: String(document.title || '').slice(0, 300),
    text: body.slice(0, MAX_TEXT),
    truncated: body.length > MAX_TEXT,
    elements,
  };
})()`;

export interface PageElement {
  tag: string;
  label: string;
  x: number;
  y: number;
  type?: string;
  role?: string;
  href?: string;
  password?: boolean;
  focused?: boolean;
}

export interface PageReading {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  elements: PageElement[];
}

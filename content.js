/**
 * LensDNA Sovereign Agent — Content Script (v1.1)
 * Native DOM RPA, React/Vue/Draft.js typing, focus memory, mutation tracking,
 * and a unified postMessage bridge so overlays / embeds share the same hands.
 */

// ---------------------------------------------------------------------------
// Focus memory — last editable before side panel / overlay stole focus
// ---------------------------------------------------------------------------
let lastFocusedElement = null;

document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (
    el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(el.type)) ||
    el.isContentEditable
  ) {
    lastFocusedElement = el;
  }
});

document.addEventListener('click', (e) => {
  const el = e.target;
  const editableParent = el.closest('[contenteditable="true"]');
  if (el.isContentEditable) lastFocusedElement = el;
  else if (editableParent) lastFocusedElement = editableParent;
});

// ---------------------------------------------------------------------------
// Mutation observer — passive form-update signal
// ---------------------------------------------------------------------------
let mutationCount = 0;
let mutationTimer = null;

const observer = new MutationObserver((mutations) => {
  mutationCount++;
  const isFormMutation = mutations.some((m) => {
    const tag = (m.target && m.target.tagName) || '';
    return tag === 'FORM' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  });
  if (isFormMutation) {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      if (document.visibilityState === 'hidden') return;
      try {
        chrome.runtime.sendMessage({
          action: 'PASSIVE_FORM_UPDATE',
          data: { url: window.location.href, title: document.title },
        }).catch(() => {});
      } catch (_) {}
    }, 2000);
  }
});

function startObserver() {
  if (!document.body) return;
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false,
  });
}

if (document.body) startObserver();
else document.addEventListener('DOMContentLoaded', startObserver);

// ---------------------------------------------------------------------------
// Fuzzy element search (labels, placeholders, aria, data-lensdna-target)
// ---------------------------------------------------------------------------
function findBestMatchingInput(hint) {
  const allInputs = Array.from(
    document.querySelectorAll(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, select, [contenteditable="true"]'
    )
  );
  if (!hint || allInputs.length === 0) return null;

  try {
    const exact = document.querySelector(hint);
    if (exact && allInputs.includes(exact)) return exact;
  } catch (_) {}

  const stopWords = new Set([
    'field', 'input', 'box', 'type', 'the', 'and', 'for', 'a', 'of', 'in', 'to', 'from', 'instead',
  ]);
  const hintWords = String(hint)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));

  let bestScore = 0;
  let bestInput = null;

  allInputs.forEach((inp) => {
    const id = (inp.id || '').toLowerCase();
    const name = (inp.name || '').toLowerCase();
    const ph = (inp.placeholder || '').toLowerCase();
    const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
    const lensTag = (inp.getAttribute('data-lensdna-target') || '').toLowerCase();

    let labelText = '';
    if (inp.id) {
      const lbl = document.querySelector(`label[for="${inp.id}"]`);
      if (lbl) labelText = lbl.textContent.toLowerCase();
    }
    if (!labelText) {
      const parent = inp.closest('label') || inp.closest('.form-group, .field, .form-control, div');
      if (parent) labelText = parent.textContent.toLowerCase();
    }

    const combined = `${id} ${name} ${ph} ${aria} ${lensTag} ${labelText}`.replace(/[^a-z0-9\s]/g, ' ');
    let score = 0;
    hintWords.forEach((word) => {
      if (combined.includes(word)) score += 1;
    });
    if (score > bestScore) {
      bestScore = score;
      bestInput = inp;
    }
  });

  return bestScore > 0 ? bestInput : null;
}

function resolveEditableTarget(hint) {
  let target = null;
  if (hint) target = findBestMatchingInput(hint);
  if (!target && document.activeElement && document.activeElement !== document.body) {
    const ae = document.activeElement;
    if (
      ae.tagName === 'TEXTAREA' ||
      ae.tagName === 'INPUT' ||
      ae.isContentEditable ||
      ae.tagName === 'SELECT'
    ) {
      target = ae;
    }
  }
  if (!target && lastFocusedElement && document.body.contains(lastFocusedElement)) {
    target = lastFocusedElement;
  }
  if (!target) {
    target = document.querySelector(
      'textarea:not([disabled]), [contenteditable="true"], input[type="text"]:not([disabled]), input:not([type]):not([disabled])'
    );
  }
  return target;
}

function glow(el, color) {
  if (!el || !el.style) return;
  el.style.transition = 'box-shadow 0.3s, border-color 0.3s';
  el.style.borderColor = color;
  el.style.boxShadow = `0 0 20px ${color}`;
  setTimeout(() => {
    try {
      el.style.boxShadow = '';
    } catch (_) {}
  }, 1500);
}

// ---------------------------------------------------------------------------
// Core RPA actions (shared by chrome.runtime + window.postMessage bridges)
// ---------------------------------------------------------------------------
function getDomState() {
  return {
    url: window.location.href,
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content || 'None',
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 8000),
    mutationCount,
  };
}

function scrapePage(maxChars = 15000) {
  return { text: (document.body?.innerText || '').substring(0, maxChars) };
}

function typeText({ text, field_hint, selector, label }) {
  const textToType = text || '';
  const hint = field_hint || selector || label || '';
  const target = resolveEditableTarget(hint);

  if (!target) {
    return { status: 'ERROR: No text field found on the page.', ok: false };
  }

  target.focus();

  if (target.tagName === 'SELECT') {
    const opt = Array.from(target.options || []).find(
      (o) =>
        o.value.toLowerCase().includes(textToType.toLowerCase()) ||
        o.text.toLowerCase().includes(textToType.toLowerCase())
    );
    target.value = opt ? opt.value : textToType;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    glow(target, '#00e5ff');
    return { status: 'TEXT_TYPED_SUCCESSFULLY', target: 'SELECT', ok: true };
  }

  if (target.isContentEditable) {
    try {
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}

    let inserted = false;
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', textToType);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
      });
      inserted = target.dispatchEvent(pasteEvent);
    } catch (_) {}

    if (!inserted || !(target.textContent || '').includes(textToType)) {
      try {
        document.execCommand('insertText', false, textToType);
      } catch (_) {
        target.textContent = (target.textContent || '') + textToType;
      }
    }

    glow(target, '#00e5ff');
    return { status: 'TEXT_TYPED_SUCCESSFULLY', target: target.tagName, ok: true };
  }

  // Native value setter for React/Vue controlled inputs
  const proto =
    target.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) nativeSetter.call(target, textToType);
  else target.value = textToType;

  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  glow(target, '#00e5ff');
  return { status: 'TEXT_TYPED_SUCCESSFULLY', target: target.tagName, ok: true };
}

function clickElement({ selector, text_content }) {
  let target = null;

  if (selector) {
    try {
      target = document.querySelector(selector);
    } catch (_) {}
  }

  if (!target && text_content) {
    const searchText = String(text_content).toLowerCase().trim();
    // X / Twitter post & reply buttons
    if (searchText.includes('reply') || searchText.includes('post') || searchText.includes('tweet')) {
      target = document.querySelector(
        '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]'
      );
    }
    if (!target) {
      const elements = Array.from(
        document.querySelectorAll(
          'button, a, [role="button"], input[type="submit"], input[type="button"], .btn'
        )
      );
      target = elements.find((el) =>
        (el.innerText || el.textContent || el.value || '').trim().toLowerCase().includes(searchText)
      );
    }
  }

  if (!target) {
    return { status: 'ERROR: Could not find element to click.', ok: false };
  }

  glow(target, '#00ff41');
  target.click();
  return { status: 'ELEMENT_CLICKED_SUCCESSFULLY', ok: true };
}

function scrollPage({ amount = 800, direction = 'down' } = {}) {
  const scrollBy = direction === 'up' ? -amount : amount;
  window.scrollBy({ top: scrollBy, behavior: 'smooth' });
  return { status: 'SCROLLED_SUCCESSFULLY', ok: true };
}

function updateDomForm({ selector, lead_name, name, field_hint, summary }) {
  const target = selector
    ? document.querySelector(selector)
    : findBestMatchingInput(lead_name || name || field_hint);
  if (target && summary != null) {
    target.focus();
    const proto =
      target.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) nativeSetter.call(target, summary);
    else target.value = summary;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    glow(target, '#00e5ff');
    return { status: 'DOM_UPDATED_SUCCESSFULLY', ok: true };
  }
  return { status: 'ERROR: No matching field', ok: false };
}

// ---------------------------------------------------------------------------
// Chrome extension message dispatcher
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request.action || request.type;
  const data = request.data || request.payload || request;

  try {
    switch (action) {
      case 'GET_DOM_STATE':
      case 'read_active_tab_data':
        sendResponse(getDomState());
        break;

      case 'SCRAPE_PAGE':
        sendResponse(scrapePage(data.maxChars || 15000));
        break;

      case 'TYPE_TEXT':
      case 'type_text_in_active_page':
        sendResponse(
          typeText({
            text: data.text,
            field_hint: data.field_hint || data.label,
            selector: data.selector,
            label: data.label,
          })
        );
        break;

      case 'CLICK_ELEMENT':
      case 'click_element_in_active_page':
        sendResponse(
          clickElement({
            selector: data.selector,
            text_content: data.text_content || data.text,
          })
        );
        break;

      case 'SCROLL_PAGE':
        sendResponse(
          scrollPage({
            amount: data.amount,
            direction: data.direction,
          })
        );
        break;

      case 'UPDATE_DOM_FORM':
        sendResponse(updateDomForm(data));
        break;

      case 'PING':
        sendResponse({
          ok: true,
          version: '1.1',
          url: location.href,
          mutationCount,
        });
        break;

      default:
        sendResponse({ status: 'UNKNOWN_ACTION', action, ok: false });
    }
  } catch (err) {
    sendResponse({ status: 'ERROR', error: String(err && err.message), ok: false });
  }

  return true; // async-safe
});

// ---------------------------------------------------------------------------
// postMessage bridge — overlays / embeds / parent pages can drive the same hands
// Accepts: lensdna-parent-action | lastmile-extension | lensdna-extension
// ---------------------------------------------------------------------------
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  const type = msg.type || '';
  if (
    type !== 'lensdna-parent-action' &&
    type !== 'lastmile-extension' &&
    type !== 'lensdna-extension'
  ) {
    return;
  }

  const action = msg.action || msg.name;
  const data = msg.payload || msg.data || msg;

  let result = { ok: false, status: 'UNKNOWN_ACTION' };

  try {
    switch (action) {
      case 'GET_DOM_STATE':
      case 'read_active_tab_data':
      case 'request_dom':
      case 'read_dom':
        result = { ok: true, ...getDomState() };
        window.postMessage(
          { type: 'lensdna-dom', text: result.text, url: result.url, title: result.title },
          '*'
        );
        break;

      case 'SCRAPE_PAGE':
        result = { ok: true, ...scrapePage() };
        break;

      case 'TYPE_TEXT':
      case 'type_text':
      case 'type_text_in_active_page':
        result = typeText({
          text: data.text,
          field_hint: data.field_hint || data.label,
          selector: data.selector,
        });
        break;

      case 'CLICK_ELEMENT':
      case 'CLICK':
      case 'click':
      case 'click_element_in_active_page':
        result = clickElement({
          selector: data.selector,
          text_content: data.text_content || data.text,
        });
        break;

      case 'SCROLL_PAGE':
      case 'scroll':
        result = scrollPage(data);
        break;

      case 'UPDATE_DOM_FORM':
      case 'update_form':
        result = updateDomForm(data);
        break;

      case 'PING':
        result = { ok: true, version: '1.1', url: location.href };
        break;

      default:
        result = { ok: false, status: 'UNKNOWN_ACTION', action };
    }
  } catch (err) {
    result = { ok: false, status: 'ERROR', error: String(err && err.message) };
  }

  try {
    if (event.source && event.source !== window) {
      event.source.postMessage(
        { type: 'lensdna-action-result', action, result },
        event.origin === 'null' ? '*' : event.origin
      );
    }
  } catch (_) {}
});

try {
  window.postMessage({ type: 'lensdna-content-ready', version: '1.1' }, '*');
} catch (_) {}

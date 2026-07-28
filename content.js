/**
 * LensDNA Sovereign Agent - Content Script
 * Handles native DOM manipulation, typing into React/Vue forms, page scraping, and focus tracking.
 */

// Memory bank to remember the last focused element before side panel opened
let lastFocusedElement = null;

document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(el.type)) || el.isContentEditable) {
        lastFocusedElement = el;
    }
});

document.addEventListener('click', (e) => {
    const el = e.target;
    const editableParent = el.closest('[contenteditable="true"]');
    if (el.isContentEditable) {
        lastFocusedElement = el;
    } else if (editableParent) {
        lastFocusedElement = editableParent;
    }
});

// --- MUTATION OBSERVER TRACKER ---
let mutationCount = 0;
let mutationTimer = null;

const observer = new MutationObserver((mutations) => {
    mutationCount++;
    
    const isFormMutation = mutations.some(m => {
        const tag = m.target.tagName;
        return tag === 'FORM' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    });
    
    if (isFormMutation) {
        clearTimeout(mutationTimer);
        mutationTimer = setTimeout(() => {
            if (document.visibilityState === 'hidden') return;
            chrome.runtime.sendMessage({
                action: 'PASSIVE_FORM_UPDATE',
                data: { url: window.location.href, title: document.title }
            }).catch(() => {});
        }, 2000);
    }
});

if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true, attributes: false, characterData: false });
} else {
    document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true, attributes: false, characterData: false });
    });
}

// --- FUZZY ELEMENT SEARCH ENGINE ---
function findBestMatchingInput(hint) {
    const allInputs = Array.from(document.querySelectorAll(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]), textarea, select, [contenteditable="true"]'
    ));

    if (!hint || allInputs.length === 0) return null;

    // Direct CSS Selector Attempt
    try {
        const exactMatch = document.querySelector(hint);
        if (exactMatch && allInputs.includes(exactMatch)) return exactMatch;
    } catch (e) {}

    const stopWords = new Set(['field', 'input', 'box', 'type', 'the', 'and', 'for', 'a', 'of', 'in', 'to', 'from', 'instead']);
    const hintWords = hint.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1 && !stopWords.has(w));

    let bestScore = 0;
    let bestInput = null;

    allInputs.forEach(inp => {
        const id = (inp.id || '').toLowerCase();
        const name = (inp.name || '').toLowerCase();
        const ph = (inp.placeholder || '').toLowerCase();
        const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
        const lensdnaTag = (inp.getAttribute('data-lensdna-target') || '').toLowerCase();
        
        let labelText = '';
        if (inp.id) {
            const lbl = document.querySelector(`label[for="${inp.id}"]`);
            if (lbl) labelText = lbl.textContent.toLowerCase();
        }
        if (!labelText) {
            const parentContainer = inp.closest('label') || inp.closest('.form-group, .field, .form-control, div');
            if (parentContainer) labelText = parentContainer.textContent.toLowerCase();
        }

        const combinedText = `${id} ${name} ${ph} ${aria} ${lensdnaTag} ${labelText}`.replace(/[^a-z0-9\s]/g, ' ');

        let score = 0;
        hintWords.forEach(word => {
            if (combinedText.includes(word)) score += 1;
        });

        if (score > bestScore) {
            bestScore = score;
            bestInput = inp;
        }
    });

    return bestScore > 0 ? bestInput : null;
}

// --- CHROME MESSAGE DISPATCHER ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    
    // A. DOM State Retrieval
    if (request.action === 'GET_DOM_STATE') {
        sendResponse({
            url: window.location.href,
            title: document.title,
            description: document.querySelector('meta[name="description"]')?.content || "None",
            text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 8000),
            mutationCount: mutationCount
        });
        return true;
    }

    // B. Legacy Form Injection
    if (request.action === 'UPDATE_DOM_FORM') {
        const data = request.data || {};
        const target = data.selector ? document.querySelector(data.selector) : findBestMatchingInput(data.lead_name || data.name || data.field_hint);
        
        if (target && data.summary) {
            target.focus();
            target.value = data.summary;
            target.dispatchEvent(new Event("input", { bubbles: true }));
            target.dispatchEvent(new Event("change", { bubbles: true }));
            target.style.boxShadow = "0 0 15px #00e5ff";
            setTimeout(() => target.style.boxShadow = "", 1500);
        }
        sendResponse({ status: "DOM_UPDATED_SUCCESSFULLY" });
        return true;
    }
    
    // C. Scrape Page
    if (request.action === 'SCRAPE_PAGE') {
        sendResponse({ text: document.body.innerText.substring(0, 15000) });
        return true;
    }

    // D. Active-Tab Typing Tool with React/Vue Synthetic Setter & Draft.js Sync
    if (request.action === 'TYPE_TEXT') {
        const textToType = request.data?.text || '';
        const hint = request.data?.field_hint || request.data?.selector || request.data?.label || '';
        let target = null;

        if (hint) {
            target = findBestMatchingInput(hint);
        }

        if (!target && document.activeElement && document.activeElement !== document.body) {
            target = document.activeElement;
        }

        if (!target && lastFocusedElement && document.body.contains(lastFocusedElement)) {
            target = lastFocusedElement;
        }

        if (!target) {
            target = document.querySelector('textarea:not([disabled]), [contenteditable="true"], input[type="text"]:not([disabled])');
        }

        if (target) {
            target.focus();

            if (target.tagName === 'SELECT') {
                const opt = Array.from(target.options).find(o => 
                    o.value.toLowerCase().includes(textToType.toLowerCase()) || 
                    o.text.toLowerCase().includes(textToType.toLowerCase())
                );
                if (opt) target.value = opt.value;
                else target.value = textToType;

                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (target.isContentEditable) {
                // Draft.js / Lexical Editor for X (Twitter) & Rich Text Editors
                target.focus();

                // 1. Position cursor at the end of existing text (or existing @mentions)
                try {
                    const range = document.createRange();
                    range.selectNodeContents(target);
                    range.collapse(false);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                } catch(e) {}

                // 2. Try native Clipboard Paste Event (100% clean for Draft.js / Lexical)
                let inserted = false;
                try {
                    const dataTransfer = new DataTransfer();
                    dataTransfer.setData('text/plain', textToType);
                    const pasteEvent = new ClipboardEvent('paste', {
                        clipboardData: dataTransfer,
                        bubbles: true,
                        cancelable: true
                    });
                    inserted = target.dispatchEvent(pasteEvent);
                } catch(e) {}

                // 3. Fallback to execCommand if Paste Event wasn't handled
                if (!inserted || !target.textContent.includes(textToType)) {
                    document.execCommand('insertText', false, textToType);
                }

                // Visual Glow Feedback
                target.style.transition = "box-shadow 0.3s, border-color 0.3s";
                target.style.borderColor = "#00e5ff";
                target.style.boxShadow = "0 0 20px #00e5ff"; 
                setTimeout(() => target.style.boxShadow = "", 1500);

                sendResponse({ status: "TEXT_TYPED_SUCCESSFULLY", target: target.tagName });
                return true; // EARLY RETURN: Bypasses extra trailing KeyboardEvents that cause duplicate typing
            } else {
                // Native Value Setter for standard React/Vue inputs
                const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (nativeSetter) {
                    nativeSetter.call(target, textToType);
                } else {
                    target.value = textToType;
                }

                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
            }

            target.style.transition = "box-shadow 0.3s, border-color 0.3s";
            target.style.borderColor = "#00e5ff";
            target.style.boxShadow = "0 0 20px #00e5ff"; 
            setTimeout(() => target.style.boxShadow = "", 1500);

            sendResponse({ status: "TEXT_TYPED_SUCCESSFULLY", target: target.tagName });
        } else {
            sendResponse({ status: "ERROR: No text field found on the page." });
        }
        return true;
    }

    // E. RPA Click Element Tool (With Native X / Twitter Selector Targeting)
    if (request.action === 'CLICK_ELEMENT') {
        let target = null;
        
        if (request.data.selector) {
            try { target = document.querySelector(request.data.selector); } catch(e){}
        }
        
        if (!target && request.data.text_content) {
            const searchText = request.data.text_content.toLowerCase().trim();
            // Direct selector match for X (Twitter) Post/Reply buttons
            if (searchText.includes('reply') || searchText.includes('post') || searchText.includes('tweet')) {
                target = document.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
            }
            if (!target) {
                const elements = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], .btn'));
                target = elements.find(el => el.innerText.trim().toLowerCase().includes(searchText));
            }
        }

        if (target) {
            target.style.transition = "box-shadow 0.3s";
            target.style.boxShadow = "0 0 20px #00ff41"; 
            setTimeout(() => target.style.boxShadow = "", 1500);
            
            target.click();
            sendResponse({ status: "ELEMENT_CLICKED_SUCCESSFULLY" });
        } else {
            sendResponse({ status: "ERROR: Could not find element to click." });
        }
        return true;
    }

    // F. RPA Scroll Page Tool
    if (request.action === 'SCROLL_PAGE') {
        const amount = request.data.amount || 800;
        const scrollBy = request.data.direction === 'up' ? -amount : amount;
        
        window.scrollBy({ top: scrollBy, behavior: 'smooth' });
        sendResponse({ status: "SCROLLED_SUCCESSFULLY" });
        return true;
    }
});
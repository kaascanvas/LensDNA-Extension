// Memory bank to remember the last thing the user clicked before opening the Side Panel
let lastFocusedElement = null;

// Silently watch every click or focus on the page
document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text') || el.isContentEditable) {
        lastFocusedElement = el;
    }
});

document.addEventListener('click', (e) => {
    const el = e.target;
    // Special handling for rich-text editors like X (Twitter) and LinkedIn
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
    
    // --- 2. Passive DOM Mutation Listener (Form Auto-Reaction) ---
    const isFormMutation = mutations.some(m => {
        const tag = m.target.tagName;
        return tag === 'FORM' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    });
    
    if (isFormMutation) {
        clearTimeout(mutationTimer);
        // Debounce to prevent flooding the agent during active typing
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

// Listens for tool calls sent from your AI in the Side Panel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    
    // A. Combined state retrieval action to allow parallel visual/text processing
    if (request.action === 'GET_DOM_STATE') {
        sendResponse({
            url: window.location.href,
            title: document.title,
            description: document.querySelector('meta[name="description"]')?.content || "None",
            text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 5000),
            mutationCount: mutationCount
        });
        return true;
    }

    // 1. DOM Form Filling Tool
    if (request.action === 'UPDATE_DOM_FORM') {
        console.log("LensDNA AI is manipulating the DOM...", request.data);
        const data = request.data || {};
        const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="search"], textarea');
        
        if (inputs.length > 0 && data.value != null) {
            const target = data.selector ? document.querySelector(data.selector) : inputs[0];
            if (target) {
                target.focus();
                target.value = data.value;
                target.dispatchEvent(new Event("input", { bubbles: true }));
                target.dispatchEvent(new Event("change", { bubbles: true }));
                target.style.boxShadow = "0 0 10px #00ff41"; 
                setTimeout(() => target.style.boxShadow = "", 1500);
            }
        }
        sendResponse({status: "DOM_UPDATED_SUCCESSFULLY"});
    }
    
    // 2. Webpage Scraper Tool
    if (request.action === 'SCRAPE_PAGE') {
        sendResponse({text: document.body.innerText.substring(0, 10000)});
    }

    // 3. Active-Tab Typing Tool (WITH FOCUS MEMORY)
    if (request.action === 'TYPE_TEXT') {
        console.log("LensDNA AI typing text...", request.data);
        let target = null;
        
        // Priority 1: AI provided a specific CSS selector
        if (request.data.selector) {
            target = document.querySelector(request.data.selector);
        }
        
        // Priority 2: Whatever is actively focused right now
        if (!target || target === document.body) {
            if (document.activeElement && document.activeElement !== document.body) {
                target = document.activeElement;
            }
        }

        // Priority 3: FOCUS MEMORY (The user clicked the side-panel and the page lost focus)
        if ((!target || target === document.body) && lastFocusedElement && document.body.contains(lastFocusedElement)) {
            target = lastFocusedElement;
        }

        // Priority 4: Final Auto-Hunt Fallback
        if (!target || target === document.body) {
            target = document.querySelector('textarea:not([disabled]), [contenteditable="true"], input[type="text"]:not([disabled])');
        }
        
        // If we found a target, inject the text
        if (target) {
            target.focus();

            const textToType = request.data.text;

            // 'execCommand' perfectly simulates a human pasting text.
            // This is the absolute requirement for X (Twitter), LinkedIn, and Angular apps.
            let success = document.execCommand('insertText', false, textToType);
            
            // Fallback for older/strict sites
            if (!success) {
                if (target.isContentEditable) {
                    target.innerText += textToType;
                } else {
                    target.value += textToType;
                }
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
            }
            
            // Visual confirmation
            target.style.transition = "box-shadow 0.3s";
            target.style.boxShadow = "0 0 20px #00e5ff"; 
            setTimeout(() => target.style.boxShadow = "", 1500);

            sendResponse({ status: "TEXT_TYPED_SUCCESSFULLY" });
        } else {
            sendResponse({ status: "ERROR: No text field found on the page." });
        }
    }

    // 4. RPA Click Element Tool
    if (request.action === 'CLICK_ELEMENT') {
        console.log("LensDNA RPA clicking element...", request.data);
        let target = null;
        
        if (request.data.selector) {
            target = document.querySelector(request.data.selector);
        } else if (request.data.text_content) {
            // Find buttons, links, or div wrappers mapped as buttons
            const elements = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'));
            target = elements.find(el => el.innerText.trim().toLowerCase() === request.data.text_content.toLowerCase());
        }

        if (target) {
            target.style.transition = "box-shadow 0.3s";
            target.style.boxShadow = "0 0 20px #ff00ea"; 
            setTimeout(() => target.style.boxShadow = "", 1500);
            
            target.click();
            sendResponse({ status: "ELEMENT_CLICKED_SUCCESSFULLY" });
        } else {
            sendResponse({ status: "ERROR: Could not find the specified element to click." });
        }
    }

    // 5. RPA Scroll Page Tool
    if (request.action === 'SCROLL_PAGE') {
        console.log("LensDNA RPA scrolling page...", request.data);
        const amount = request.data.amount || 800;
        const scrollBy = request.data.direction === 'up' ? -amount : amount;
        
        window.scrollBy({
            top: scrollBy,
            behavior: 'smooth'
        });
        
        sendResponse({ status: "SCROLLED_SUCCESSFULLY" });
    }
});
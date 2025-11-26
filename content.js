// Content Script for Premium Translator

// Helper to check if text contains English
function isEnglish(text) {
    return /[a-zA-Z]{2,}/.test(text);
}

// Helper to call translation API via Background Script
function translateText(text) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'TRANSLATE_TEXT', text }, (response) => {
            resolve(response ? response.translation : null);
        });
    });
}

// Helper to play audio via Background Script
function playAudio(text) {
    chrome.runtime.sendMessage({ action: 'SPEAK_TEXT', text }, (response) => {
        if (response && response.audioData) {
            const audio = new Audio(response.audioData);
            audio.play().catch(e => console.error('Audio play error', e));
        }
    });
}

// State
let isTranslating = false;
let shouldStop = false;
const translationCache = new Map(); // In-memory cache

// Floating Widget Logic
let floatingWidget = null;
let floatingMode = false;

function createFloatingWidget() {
    if (floatingWidget) return;

    const widget = document.createElement('div');
    widget.className = 'pt-floating-widget';

    const dock = document.createElement('div');
    dock.className = 'pt-floating-dock';

    const content = document.createElement('div');
    content.className = 'pt-floating-content';

    const startBtn = document.createElement('button');
    startBtn.className = 'pt-control-btn pt-btn-start';
    startBtn.textContent = 'Translate';
    startBtn.onclick = () => {
        // Auto-show if hidden
        if (document.body.classList.contains('pt-hide-translations')) {
            toggleTranslationVisibility(true);
        }
        startTranslation();
    };

    const stopBtn = document.createElement('button');
    stopBtn.className = 'pt-control-btn pt-btn-stop pt-hidden';
    stopBtn.textContent = 'Stop';
    stopBtn.onclick = () => {
        shouldStop = true;
        updateWidgetState('idle');
    };

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'pt-control-btn pt-btn-cancel';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.onclick = () => {
        const isHidden = document.body.classList.contains('pt-hide-translations');

        // If we are currently showing (isHidden is false), we are about to Hide (Dismiss).
        // In this case, we should also stop translation if it's running.
        if (!isHidden && isTranslating) {
            shouldStop = true;
            updateWidgetState('idle');
        }

        toggleTranslationVisibility(isHidden);
    };

    content.appendChild(startBtn);
    content.appendChild(stopBtn);
    content.appendChild(dismissBtn);

    widget.appendChild(dock);
    widget.appendChild(content);

    document.body.appendChild(widget);
    floatingWidget = widget;
}

function toggleTranslationVisibility(show) {
    const dismissBtn = document.querySelector('.pt-btn-cancel, .pt-btn-show');
    if (show) {
        document.body.classList.remove('pt-hide-translations');
        if (dismissBtn) {
            dismissBtn.textContent = 'Dismiss';
            dismissBtn.classList.remove('pt-btn-show');
            dismissBtn.classList.add('pt-btn-cancel');
        }
    } else {
        document.body.classList.add('pt-hide-translations');
        if (dismissBtn) {
            dismissBtn.textContent = 'Show';
            dismissBtn.classList.remove('pt-btn-cancel');
            dismissBtn.classList.add('pt-btn-show');
        }
    }
}

function updateWidgetState(state) {
    if (!floatingWidget) return;
    const startBtn = floatingWidget.querySelector('.pt-btn-start');
    const stopBtn = floatingWidget.querySelector('.pt-btn-stop');

    if (state === 'translating') {
        startBtn.classList.add('pt-hidden');
        stopBtn.classList.remove('pt-hidden');
    } else {
        startBtn.classList.remove('pt-hidden');
        stopBtn.classList.add('pt-hidden');

        if (state === 'translated') {
            startBtn.textContent = 'Translated';
            startBtn.classList.remove('pt-btn-start');
            startBtn.classList.add('pt-btn-translated');
        } else {
            startBtn.textContent = 'Translate';
            startBtn.classList.add('pt-btn-start');
            startBtn.classList.remove('pt-btn-translated');
        }
    }
}

function removeFloatingWidget() {
    if (floatingWidget) {
        floatingWidget.remove();
        floatingWidget = null;
    }
}

function toggleFloatingWidget(show) {
    if (show) {
        createFloatingWidget();
    } else {
        removeFloatingWidget();
    }
}

// Full Page Translation Logic
async function startTranslation() {
    if (isTranslating) return;

    // Set state to translating immediately
    updateWidgetState('translating');
    isTranslating = true;
    shouldStop = false;

    try {
        // Expanded selector to include inline elements that might be standalone items (like sidebar links)
        const selectorTags = [
            'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'DIV', 'BLOCKQUOTE', 'PRE',
            'A', 'SPAN', 'B', 'I', 'STRONG', 'EM', 'SMALL', 'BIG', 'BUTTON', 'LABEL'
        ];
        const elements = document.querySelectorAll(selectorTags.join(','));

        for (const element of elements) {
            if (shouldStop) break;

            // 0. Exclude floating widget and its children
            if (element.closest('.pt-floating-widget')) continue;

            // 1. Check if already translated
            if (element.dataset.translated === 'true' || element.classList.contains('pt-translation-line')) continue;

            // 2. Check if ancestor is already translated (prevent double translation)
            if (element.closest('[data-translated="true"]')) continue;

            // 3. Container Detection: Check if element has significant direct text nodes
            // If it has NO direct text (only child elements), skip it (treat as container)
            // Exception: <pre> tags usually should be translated as a whole even if structured
            let hasDirectText = false;
            if (element.tagName === 'PRE') {
                hasDirectText = true;
            } else {
                for (const node of element.childNodes) {
                    if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim().length > 0) {
                        hasDirectText = true;
                        break;
                    }
                }
            }

            if (!hasDirectText) continue; // Skip container, let children be processed

            // 4. Check content validity
            const text = element.innerText.trim();
            if (!text || text.length < 2 || !isEnglish(text)) continue;

            // 5. Mark as translated
            element.dataset.translated = 'true';

            // 6. Check Cache
            let translation = translationCache.get(text);

            // 7. Fetch if not in cache
            if (!translation) {
                try {
                    translation = await translateText(text);
                    if (translation) {
                        translationCache.set(text, translation);
                    }
                } catch (err) {
                    console.error('Translation failed for block:', err);
                    continue;
                }
            }

            // 8. Render
            if (translation) {
                const translationLine = document.createElement('div');
                translationLine.className = 'pt-translation-line';
                translationLine.textContent = translation;

                // For inline elements (A, SPAN), we still want the translation to break to a new line
                // appending to the element usually works because pt-translation-line is block
                element.appendChild(translationLine);
            }
        }
    } catch (error) {
        console.error('Translation process error:', error);
    } finally {
        isTranslating = false;
        if (shouldStop) {
            updateWidgetState('idle');
        } else {
            updateWidgetState('translated');
        }
    }
}

// Message Listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'TOGGLE_FLOATING') {
        toggleFloatingWidget(request.value);
    }
});

// Initialize
chrome.storage.local.get(['floatingMode'], (result) => {
    if (result.floatingMode) {
        toggleFloatingWidget(true);
    }
});

// Selection Translation Logic
let selectionMode = false;
let activePopup = null;
let activeBubble = null;

// Icons (SVG)
const ICON_TRANSLATE = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l6 6"></path><path d="M4 14l6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="M22 22l-5-10-5 10"></path><path d="M14 18h6"></path></svg>'; // Simplified icon
const ICON_SPEAK = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';

// Load initial state
chrome.storage.local.get(['selectionMode'], (result) => {
    selectionMode = result.selectionMode || false;
});

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.selectionMode) {
        selectionMode = changes.selectionMode.newValue;
    }
});

function removePopup() {
    if (activePopup) {
        activePopup.remove();
        activePopup = null;
    }
}

function removeBubble() {
    if (activeBubble) {
        activeBubble.remove();
        activeBubble = null;
    }
}

function createPopup(x, y, text) {
    removePopup();
    removeBubble(); // Clear any existing bubble when new selection is made

    const popup = document.createElement('div');
    popup.className = 'pt-selection-popup';
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;

    const translateBtn = document.createElement('button');
    translateBtn.className = 'pt-icon-btn';
    translateBtn.innerHTML = ICON_TRANSLATE;
    translateBtn.title = 'Translate';
    translateBtn.onclick = async (e) => {
        e.stopPropagation();
        e.preventDefault(); // Prevent default click actions
        // Keep the popup, show translation bubble
        await showTranslationBubble(x, y + 40, text);
    };

    const speakBtn = document.createElement('button');
    speakBtn.className = 'pt-icon-btn';
    speakBtn.innerHTML = ICON_SPEAK;
    speakBtn.title = 'Listen';
    speakBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        playAudio(text);
    };

    popup.appendChild(translateBtn);
    popup.appendChild(speakBtn);
    document.body.appendChild(popup);
    activePopup = popup;
}

async function showTranslationBubble(x, y, text) {
    removeBubble();

    const bubble = document.createElement('div');
    bubble.className = 'pt-translation-bubble';
    bubble.style.left = `${x}px`;
    bubble.style.top = `${y}px`;
    bubble.textContent = 'Translating...';
    document.body.appendChild(bubble);
    activeBubble = bubble;

    const translation = await translateText(text);
    if (activeBubble) { // Check if still active
        if (translation) {
            activeBubble.textContent = translation;
        } else {
            activeBubble.textContent = 'Error translating.';
        }
    }
}

document.addEventListener('mouseup', (e) => {
    if (!selectionMode) return;

    // Check if clicking inside popup or bubble
    if (activePopup && activePopup.contains(e.target)) return;
    if (activeBubble && activeBubble.contains(e.target)) return;

    // Wait slightly for selection to settle
    setTimeout(() => {
        const selection = window.getSelection();
        const text = selection.toString().trim();

        if (text && isEnglish(text)) {
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();

            // Calculate position (bottom right of selection)
            const x = rect.right + window.scrollX;
            const y = rect.bottom + window.scrollY + 5;

            createPopup(x, y, text);
        }
    }, 10);
});

document.addEventListener('mousedown', (e) => {
    // If clicking inside popup or bubble, do nothing
    if (activePopup && activePopup.contains(e.target)) return;
    if (activeBubble && activeBubble.contains(e.target)) return;

    // Otherwise remove them
    removePopup();
    removeBubble();
});

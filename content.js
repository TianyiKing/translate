// Content Script for Premium Translator

// Helper to check if text contains English
function isEnglish(text) {
    return /[a-zA-Z]{2,}/.test(text);
}

// Helper to call translation API via Background Script
// Helper to call translation API via Background Script
function translateText(text) {
    return new Promise((resolve) => {
        let isResolved = false;
        const timeoutId = setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                resolve('ERROR:TIMEOUT');
            }
            if (!isResolved) {
                isResolved = true;
                resolve('ERROR:TIMEOUT');
            }
        }, 5000); // 5 second timeout

        chrome.runtime.sendMessage({ action: 'TRANSLATE_TEXT', text }, (response) => {
            if (!isResolved) {
                isResolved = true;
                clearTimeout(timeoutId);
                resolve(response ? response.translation : null);
            }
        });
    });
}

// Helper to play audio via Background Script (uses offscreen document to bypass CSP)
function playAudio(text) {
    chrome.runtime.sendMessage({ action: 'SPEAK_TEXT', text }, (response) => {
        if (chrome.runtime.lastError) {
            console.error('TTS Error:', chrome.runtime.lastError);
            alert('Audio playback failed. Please try again.');
            return;
        }
        if (!response || !response.success) {
            const errorMsg = response?.error || 'Unknown error';
            console.error('TTS playback failed:', errorMsg);
            alert('Audio playback failed: ' + errorMsg);
        }
    });
}

// State
let isTranslating = false;
let shouldStop = false;
const translationCache = new Map(); // In-memory cache

const BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'DIV', 'BLOCKQUOTE', 'PRE', 'ADDRESS',
    'ARTICLE', 'ASIDE', 'CANVAS', 'DD', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER',
    'FORM', 'HEADER', 'HR', 'MAIN', 'NAV', 'NOSCRIPT', 'OL', 'SECTION', 'TABLE', 'TFOOT', 'UL', 'VIDEO'
]);

function isBlock(node) {
    return node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(node.tagName);
}

function isBreak(node) {
    return node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR';
}

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
    startBtn.className = 'pt-control-btn pt-btn-start pt-btn-main';
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
    content.appendChild(startBtn);
    content.appendChild(stopBtn);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'pt-control-btn pt-btn-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.onclick = () => {
        clearTranslations();
    };
    content.appendChild(clearBtn);

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
    const startBtn = floatingWidget.querySelector('.pt-btn-main');
    const stopBtn = floatingWidget.querySelector('.pt-btn-stop');
    // Clear button is always visible, no need to toggle

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

function clearTranslations() {
    // 1. Remove all translation lines
    const lines = document.querySelectorAll('.pt-translation-line');
    lines.forEach(line => line.remove());

    // 2. Reset data-translated attribute
    const translatedElements = document.querySelectorAll('[data-translated="true"]');
    translatedElements.forEach(el => {
        delete el.dataset.translated;
    });

    // 3. Clear cache
    translationCache.clear();

    // 4. Reset state
    isTranslating = false;
    shouldStop = false;
    updateWidgetState('idle');
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
            // Only skip if this is an INLINE element and its ancestor is translated.
            // Block elements (like P inside DIV) should be processed independently because
            // the parent DIV's segment logic would have skipped the P.
            if (!isBlock(element) && element.closest('[data-translated="true"]')) continue;

            // 3. Mark as translated immediately to prevent re-processing
            element.dataset.translated = 'true';

            // 4. Segment Processing Logic
            // We iterate over childNodes and group text/inline nodes into segments.
            // We break segments on Block elements or BR tags.

            let currentSegmentNodes = [];
            let currentSegmentText = "";

            const processSegment = async () => {
                const text = currentSegmentText.trim();
                if (!text || text.length < 2 || !isEnglish(text)) return;

                // Check Cache
                let translation = translationCache.get(text);

                // Fetch if not in cache
                if (!translation) {
                    translation = await translateText(text);
                    if (!translation) {
                        translation = '翻译错误';
                    } else if (translation === 'ERROR:TIMEOUT') {
                        translation = '翻译超时';
                    } else if (translation === 'ERROR:FAILED') {
                        translation = '翻译错误';
                    } else {
                        translationCache.set(text, translation);
                    }
                }

                // Render
                const translationLine = document.createElement('div');
                translationLine.className = 'pt-translation-line';
                translationLine.textContent = translation;

                // Insert after the last node of the segment
                const lastNode = currentSegmentNodes[currentSegmentNodes.length - 1];
                if (lastNode && lastNode.parentNode) {
                    lastNode.parentNode.insertBefore(translationLine, lastNode.nextSibling);
                }
            };

            for (const node of element.childNodes) {
                if (shouldStop) break;

                if (isBlock(node)) {
                    await processSegment();
                    currentSegmentNodes = [];
                    currentSegmentText = "";
                    continue;
                }

                if (isBreak(node)) {
                    await processSegment();
                    currentSegmentNodes = [];
                    currentSegmentText = "";
                    continue;
                }

                // Text or Inline Element
                // For elements, we use innerText to respect hidden/visible state
                // For text nodes, we use nodeValue
                let nodeText = "";
                if (node.nodeType === Node.TEXT_NODE) {
                    nodeText = node.nodeValue;
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    nodeText = node.innerText;
                }

                if (nodeText) {
                    currentSegmentNodes.push(node);
                    currentSegmentText += nodeText;
                }
            }
            // Process final segment
            if (!shouldStop) {
                await processSegment();
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
    } else if (request.action === 'TOGGLE_SHORTCUTS') {
        shortcutsEnabled = request.value;
    }
});

// Initialize
chrome.storage.local.get(['floatingMode', 'shortcutsEnabled'], (result) => {
    if (result.floatingMode) {
        toggleFloatingWidget(true);
    }
    shortcutsEnabled = result.shortcutsEnabled || false;
});

// Shortcuts Logic
let shortcutsEnabled = false;
let mouseX = 0;
let mouseY = 0;

document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
});

document.addEventListener('keydown', async (e) => {
    if (!shortcutsEnabled) return;

    // Option + A: Translate
    if (e.altKey && (e.key === 'a' || e.key === 'A' || e.code === 'KeyA')) {
        const selection = window.getSelection();
        const text = selection.toString().trim();
        if (text && isEnglish(text)) {
            // Calculate position: centered above text box, slightly below mouse
            // User request: "mouse position should be in the middle of the text box's top edge"
            // "if no space below, show above"
            // "if mouse too far right, shift text box left"

            await showTranslationBubbleAtMouse(text);
        }
    }

    // Option + S: Speak
    if (e.altKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
        const selection = window.getSelection();
        const text = selection.toString().trim();
        if (text) {
            playAudio(text);
        }
    }
});

async function showTranslationBubbleAtMouse(text) {
    removeBubble();
    removePopup(); // Also remove selection popup if present

    const bubble = document.createElement('div');
    bubble.className = 'pt-translation-bubble';
    bubble.textContent = 'Translating...';

    // Initial style to get dimensions (hidden but rendered)
    bubble.style.visibility = 'hidden';
    document.body.appendChild(bubble);
    activeBubble = bubble;

    // Helper to update position
    const updatePosition = () => {
        if (!activeBubble) return;

        // Get dimensions
        const rect = bubble.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;
        const gap = 15; // Increased gap

        // Calculate Position
        // Default: Mouse is at top-center of bubble (so bubble is below mouse)
        // Bubble Top = MouseY + gap
        // Bubble Left = MouseX - (Width / 2)

        let top = mouseY + gap;
        let left = mouseX - (width / 2);

        // Viewport dimensions
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // 1. Vertical Adjustment
        // Only flip to above if it strictly overflows bottom AND there is space above
        if (top + height > viewportHeight) {
            // Check if there is enough space above
            if (mouseY - gap - height > 0) {
                // Show above: Bubble Bottom = MouseY - gap
                top = mouseY - gap - height;
            } else {
                // Not enough space above either, or just slightly overflowing bottom.
                // If it overflows bottom, we might just have to clamp it to bottom edge?
                // But user prefers "below".
                // Let's try to keep it below but shift it up slightly if needed, 
                // OR if it really doesn't fit, put it above.
                // User said: "If below space is not enough, then place above."
                // So the flip logic is correct, but maybe we should ensure we don't flip prematurely.

                // Let's stick to the flip, but maybe clamp 'top' if it's above?
                // Actually, the previous logic was fine for "if not enough space below".
                // Maybe the issue was the gap was too small so it felt "on top".
                // With gap=15, it should be better.

                // Let's also ensure we don't go off the top if we flip.
                top = Math.max(10, mouseY - gap - height);
            }
        }

        // 2. Horizontal Adjustment
        // If left < 0, shift right
        if (left < 10) {
            left = 10;
        }
        // If right > viewportWidth, shift left
        if (left + width > viewportWidth - 10) {
            left = viewportWidth - width - 10;
        }

        // Apply styles
        bubble.style.top = `${top}px`;
        bubble.style.left = `${left}px`;
        bubble.style.visibility = 'visible';
    };

    // Initial Position
    updatePosition();

    const translation = await translateText(text);
    if (activeBubble) { // Check if still active
        if (translation && !translation.startsWith('ERROR:')) {
            activeBubble.textContent = translation;
        } else {
            const errorMap = {
                'ERROR:BAIDU_54003': 'Baidu Error: Access Frequency Too High',
                'ERROR:BAIDU_54004': 'Baidu Error: Insufficient Balance',
                'ERROR:BAIDU_54005': 'Baidu Error: Long Query Frequency Too High',
                'ERROR:BAIDU_52003': 'Baidu Error: Unauthorized User',
                'ERROR:BAIDU_58002': 'Baidu Error: Service Timeout',
                'ERROR:TIMEOUT': 'Translation Timed Out',
                'ERROR:FAILED': 'Translation Failed'
            };
            activeBubble.textContent = errorMap[translation] || 'Translation failed.';
        }

        // Re-calculate position after content update
        updatePosition();
    }
}

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
        if (translation && !translation.startsWith('ERROR:')) {
            activeBubble.textContent = translation;
        } else {
            const errorMap = {
                'ERROR:BAIDU_54003': 'Baidu Error: Access Frequency Too High',
                'ERROR:BAIDU_54004': 'Baidu Error: Insufficient Balance',
                'ERROR:BAIDU_54005': 'Baidu Error: Long Query Frequency Too High',
                'ERROR:BAIDU_52003': 'Baidu Error: Unauthorized User',
                'ERROR:BAIDU_58002': 'Baidu Error: Service Timeout',
                'ERROR:TIMEOUT': 'Translation Timed Out',
                'ERROR:FAILED': 'Translation Failed'
            };
            activeBubble.textContent = errorMap[translation] || 'Translation failed.';
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

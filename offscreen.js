// Offscreen document for audio playback
// This runs in the extension context, bypassing webpage CSP restrictions

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'PLAY_AUDIO' && request.audioData) {
        const audio = new Audio(request.audioData);
        audio.play()
            .then(() => sendResponse({ success: true }))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true; // Keep channel open for async response
    }
});

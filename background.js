// Background Script for Premium Translator

// Helper to fetch translation
async function fetchTranslation(text) {
    try {
        const url = `https://translate.google.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();
        if (data && data[0]) {
            return data[0].map(part => part[0]).join('');
        }
    } catch (error) {
        console.error('Translation Error:', error);
        return null;
    }
}

// Helper to fetch TTS audio
async function fetchTTS(text) {
    try {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('Network response was not ok');
        const blob = await response.blob();
        return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('TTS Error:', error);
        return null;
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'TRANSLATE_TEXT') {
        fetchTranslation(request.text).then(translation => {
            sendResponse({ translation });
        });
        return true; // Will respond asynchronously
    }

    if (request.action === 'SPEAK_TEXT') {
        fetchTTS(request.text).then(audioData => {
            sendResponse({ audioData });
        });
        return true; // Will respond asynchronously
    }
});

document.addEventListener('DOMContentLoaded', () => {
  const inputText = document.getElementById('inputText');
  const listenBtn = document.getElementById('listenBtn');
  const selectionToggle = document.getElementById('selectionToggle');
  const floatingToggle = document.getElementById('floatingToggle');

  // Load states
  chrome.storage.local.get(['selectionMode', 'floatingMode'], (result) => {
    selectionToggle.checked = result.selectionMode || false;
    floatingToggle.checked = result.floatingMode || false;
  });

  // Toggle selection mode
  selectionToggle.addEventListener('change', () => {
    const isChecked = selectionToggle.checked;
    chrome.storage.local.set({ selectionMode: isChecked });
  });

  // Toggle floating mode
  floatingToggle.addEventListener('change', async () => {
    const isChecked = floatingToggle.checked;
    chrome.storage.local.set({ floatingMode: isChecked });

    // Notify active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_FLOATING', value: isChecked })
        .catch(err => {
          // Ignore connection errors (e.g. on chrome:// pages or if content script not loaded)
          console.log('Could not send message to tab:', err);
        });
    }
  });

  // Translation API Endpoint
  // https://translate.google.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=TEXT

  // TTS API Endpoint
  // https://translate.google.com/translate_tts?ie=UTF-8&q=TEXT&tl=en&client=tw-ob

  translateBtn.addEventListener('click', async () => {
    const text = inputText.value.trim();
    if (!text) return;

    outputText.textContent = 'Translating...';

    try {
      const url = `https://translate.google.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error('Network response was not ok');
      }

      const data = await response.json();
      // Data structure: [[["Translated Text", "Original Text", ...], ...], ...]
      // We need to join all parts if it's a long text
      if (data && data[0]) {
        const translatedText = data[0].map(part => part[0]).join('');
        outputText.textContent = translatedText;
      } else {
        outputText.textContent = 'Translation failed.';
      }
    } catch (error) {
      console.error('Translation Error:', error);
      outputText.textContent = 'Error: ' + error.message;
    }
  });

  listenBtn.addEventListener('click', () => {
    const text = inputText.value.trim();
    if (!text) return;

    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`;

    const audio = new Audio(url);
    audio.play().catch(error => {
      console.error('Audio Playback Error:', error);
      alert('Could not play audio. Check console for details.');
    });
  });
});

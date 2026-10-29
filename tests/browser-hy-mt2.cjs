const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer');

const extensionPath = resolve(__dirname, '..');
const artifacts = mkdtempSync(join(tmpdir(), 'translate-hymt2-browser-'));
const requests = [];
const timers = new Set();
const errors = [];
const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body style="padding:30px;min-height:900px">' +
            '<p id="first">Hello world.</p><p id="second">Good morning.</p></body></html>');
        return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const entry = { body, completed: false, aborted: false };
    requests.push(entry);
    res.on('close', () => { entry.aborted = !res.writableFinished; });
    const delay = {
        'Slow success': 31000, 'Default timeout': 34000,
        'Custom timeout': 3000, 'Body timeout': 3000,
        'First request': 1200, 'Second request': 100, 'Close request': 800
    }[body.text] || 30;
    if (body.text === 'Body timeout') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.flushHeaders();
    }
    const timer = setTimeout(() => {
        timers.delete(timer);
        if (res.destroyed) return;
        const failed = body.text === 'Page error' &&
            requests.filter(item => item.body.text === body.text).length === 1;
        if (!res.headersSent) res.writeHead(failed ? 503 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ translated_text: `Result: ${body.text}` }));
        entry.completed = true;
    }, delay);
    timers.add(timer);
});

let browser;
let cdp;
let popup;
let page;
let extensionId;

async function waitFor(check, timeout = 5000) {
    const end = Date.now() + timeout;
    while (!check()) {
        if (Date.now() >= end) throw new Error('Condition did not complete');
        await new Promise(resolve => setTimeout(resolve, 30));
    }
}

async function step(name, fn) {
    if (process.env.HY_MT2_SKIP_SLOW === '1' &&
        /31 seconds|32 second timeout/.test(name)) return;
    const start = Date.now();
    await fn();
    console.log(`PASS ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
}

async function settings(values) {
    await popup.evaluate(values => chrome.storage.local.set(values), values);
}

async function unattachedWorker() {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const worker = targetInfos.find(target => target.type === 'service_worker' &&
        target.url.includes(extensionId));
    assert.ok(worker, 'extension worker is running');
    assert.equal(worker.attached, false, 'worker must not have a debugger attached');
}

async function select(text) {
    await page.bringToFront();
    await page.evaluate(text => {
        document.querySelector('#first').textContent = text;
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#first'));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.querySelector('#first').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, text);
    // Content waits 10ms after mouseup; finish that callback before sending a shortcut.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)));
    await page.waitForSelector('.pt-selection-popup');
}

async function selectionTranslate(text) {
    await select(text);
    await page.click('.pt-selection-popup button[title="Translate"]');
    await page.waitForSelector('.pt-translation-bubble');
}

async function bubbleResult(text, timeout = 5000) {
    await page.waitForFunction(expected =>
        document.querySelector('.pt-translation-bubble')?.textContent === expected,
    { timeout }, text);
}

async function dismiss() {
    await page.bringToFront();
    await page.mouse.click(900, 500);
    await page.waitForSelector('.pt-translation-bubble', { hidden: true });
}

async function manual(text, timeout = 5000) {
    await popup.bringToFront();
    await popup.evaluate(text => { document.querySelector('#inputText').value = text; }, text);
    await popup.click('#translateBtn');
    await popup.waitForFunction(() => {
        const text = document.querySelector('#outputText').textContent;
        return text && text !== 'Translating...';
    }, { timeout });
    return await popup.$eval('#outputText', node => node.textContent);
}

async function fullPageTranslate() {
    await page.bringToFront();
    await page.hover('.pt-floating-dock');
    await page.waitForFunction(() =>
        document.querySelector('.pt-floating-widget').getBoundingClientRect().right <= innerWidth + 0.5);
    await page.click('.pt-btn-start');
}

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    browser = await puppeteer.launch({
        ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
        headless: true,
        protocolTimeout: 45000,
        args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            '--autoplay-policy=no-user-gesture-required'
        ]
    });
    console.log(await browser.version());
    const worker = await browser.waitForTarget(target => target.type() === 'service_worker' &&
        target.url().endsWith('/background.js'));
    extensionId = new URL(worker.url()).hostname;
    // Do not call worker.worker() or attach a CDP session to the worker.
    cdp = await browser.target().createCDPSession();
    popup = await browser.newPage();
    popup.on('pageerror', error => errors.push(error.message));
    await popup.setViewport({ width: 360, height: 600 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForFunction(() => document.querySelector('input[name="provider"]:checked'));
    await step('defaults, source selection, settings validation and persistence', async () => {
        await popup.click('input[name="provider"][value="hy_mt2"]');
        await popup.waitForSelector('#hyMt2Settings:not(.hidden)');
        await popup.click('#saveHyMt2');
        assert.equal(await popup.$eval('#hyMt2Port', node => node.value), '8096');
        assert.equal(await popup.$eval('#hyMt2TimeoutSeconds', node => node.value), '32');
        const dialogs = [];
        popup.on('dialog', async dialog => {
            dialogs.push(dialog.message());
            await dialog.dismiss();
        });
        for (const [id, value] of [['hyMt2Port', '65536'], ['hyMt2TimeoutSeconds', '0']]) {
            await popup.evaluate(({ id, value, port }) => {
                document.querySelector('#hyMt2Port').value = port;
                document.querySelector('#hyMt2TimeoutSeconds').value = 32;
                document.getElementById(id).value = value;
            }, { id, value, port });
            await popup.click('#saveHyMt2');
            await waitFor(() => dialogs.length === (id === 'hyMt2Port' ? 1 : 2));
        }
        await popup.evaluate(port => {
            document.querySelector('#hyMt2Port').value = port;
            document.querySelector('#hyMt2TimeoutSeconds').value = 32;
        }, port);
        await popup.click('#saveHyMt2');
        await popup.waitForSelector('#hyMt2Inputs.hidden');
        const saved = await popup.evaluate(() => chrome.storage.local.get([
            'provider', 'ttsProvider', 'hyMt2Port', 'hyMt2TimeoutSeconds'
        ]));
        assert.deepEqual(saved, { provider: 'hy_mt2', ttsProvider: 'google', hyMt2Port: port, hyMt2TimeoutSeconds: 32 });
        await popup.reload();
        await popup.waitForSelector('#hyMt2Settings:not(.hidden)');
        await popup.click('#saveHyMt2');
        await popup.screenshot({ path: join(artifacts, 'settings.png'), fullPage: true });
        assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });

    await settings({ selectionMode: true, floatingMode: true, shortcutsEnabled: true });
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('.pt-floating-widget');
    await step('manual translation request shape', async () => {
        assert.equal(await manual('Manual translation'), 'Result: Manual translation');
        assert.deepEqual(requests.at(-1).body, {
            text: 'Manual translation', source_lang: 'en', target_lang: 'zh'
        });
    });
    await step('selection request succeeds after 31 seconds without worker debugger', async () => {
        await selectionTranslate('Slow success');
        await unattachedWorker();
        await bubbleResult('Result: Slow success', 35000);
        await unattachedWorker();
        await dismiss();
    });
    await step('default 32 second timeout aborts the HTTP request', async () => {
        const started = Date.now();
        assert.equal(await manual('Default timeout', 36000), 'Translation Timed Out');
        assert.ok(Date.now() - started >= 31500);
        await waitFor(() => requests.at(-1).aborted);
        await unattachedWorker();
    });
    await step('custom timeout includes receiving response body', async () => {
        await settings({ hyMt2TimeoutSeconds: 1 });
        assert.equal(await manual('Custom timeout'), 'Translation Timed Out');
        assert.equal(await manual('Body timeout'), 'Translation Timed Out');
        await settings({ hyMt2TimeoutSeconds: 32 });
    });
    await step('dismissed request completes and old result cannot replace new bubble', async () => {
        await selectionTranslate('Close request');
        await dismiss();
        await waitFor(() => requests.some(item => item.body.text === 'Close request' && item.completed));
        assert.equal(await page.$('.pt-translation-bubble'), null);
        await selectionTranslate('First request');
        await dismiss();
        await selectionTranslate('Second request');
        await bubbleResult('Result: Second request');
        await waitFor(() => requests.some(item => item.body.text === 'First request' && item.completed));
        await bubbleResult('Result: Second request');
        await dismiss();
    });
    await step('shortcut and full page translation; errors are not cached', async () => {
        await select('Keyboard translation');
        await page.keyboard.down('Alt');
        await page.keyboard.press('a');
        await page.keyboard.up('Alt');
        await bubbleResult('Result: Keyboard translation');
        await dismiss();
        await page.evaluate(() => {
            document.querySelector('#first').textContent = 'Page error';
            document.querySelector('#second').textContent = 'Page error';
        });
        await fullPageTranslate();
        await page.waitForFunction(() => document.querySelectorAll('.pt-translation-line').length === 2);
        assert.deepEqual(await page.$$eval('.pt-translation-line', nodes => nodes.map(node => node.textContent)),
            ['翻译错误', 'Result: Page error']);
    });

    if (process.env.HY_MT2_LIVE === '1') {
        await step('live Hy-MT2: manual, selection, keyboard and full page', async () => {
            await settings({ hyMt2Port: Number(process.env.HY_MT2_PORT || 8096), hyMt2TimeoutSeconds: 32 });
            const result = await manual('The meeting starts at nine tomorrow morning.', 35000);
            assert.match(result, /[\u3400-\u9fff]/);
            console.log(`LIVE manual: ${result}`);
            await page.reload();
            await selectionTranslate('Please close the window.');
            await page.waitForFunction(() => /[\u3400-\u9fff]/.test(
                document.querySelector('.pt-translation-bubble')?.textContent || ''), { timeout: 35000 });
            console.log(`LIVE selection: ${await page.$eval('.pt-translation-bubble', node => node.textContent)}`);
            await dismiss();
            await select('Thank you for your help.');
            await page.keyboard.down('Alt');
            await page.keyboard.press('a');
            await page.keyboard.up('Alt');
            await page.waitForFunction(() => /[\u3400-\u9fff]/.test(
                document.querySelector('.pt-translation-bubble')?.textContent || ''), { timeout: 35000 });
            console.log(`LIVE keyboard: ${await page.$eval('.pt-translation-bubble', node => node.textContent)}`);
            await dismiss();
            await page.reload();
            await page.waitForSelector('.pt-btn-start');
            await fullPageTranslate();
            await page.waitForFunction(() => document.querySelectorAll('.pt-translation-line').length === 2,
                { timeout: 65000 });
            const translations = await page.$$eval('.pt-translation-line', nodes => nodes.map(node => node.textContent));
            assert.ok(translations.every(text => /[\u3400-\u9fff]/.test(text) && !/翻译错误|翻译超时|无法连接/.test(text)));
            console.log(`LIVE page: ${translations.join(' | ')}`);
            await page.screenshot({ path: join(artifacts, 'page-translation.png') });
        });
    }
    assert.deepEqual(errors, []);
    console.log(`Artifacts: ${artifacts}`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    if (process.exitCode && page && !page.isClosed()) {
        console.error('Page diagnostics:', await page.evaluate(() => ({
            text: document.body.innerText,
            selection: window.getSelection().toString()
        })).catch(() => null));
        console.error('Requests:', requests.map(item => item.body.text));
        console.error('Page errors:', errors);
        await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
        console.error(`Artifacts: ${artifacts}`);
    }
    if (browser) await browser.close();
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
});

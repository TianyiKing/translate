const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function createClock() {
    let now = 0;
    let nextId = 0;
    const timers = new Map();
    const add = (fn, delay, repeat) => {
        const id = ++nextId;
        timers.set(id, { fn, at: now + delay, delay, repeat });
        return id;
    };
    return {
        timers,
        setTimeout: (fn, delay) => add(fn, delay, false),
        setInterval: (fn, delay) => add(fn, delay, true),
        clearTimeout: id => timers.delete(id),
        clearInterval: id => timers.delete(id),
        async tick(ms) {
            const end = now + ms;
            while (true) {
                const next = [...timers].filter(([, timer]) => timer.at <= end)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                const [id, timer] = next;
                now = timer.at;
                if (timer.repeat) timer.at += timer.delay;
                else timers.delete(id);
                timer.fn();
                await flush();
            }
            now = end;
            await flush();
        }
    };
}

function load(file = 'background.js', settings = {}) {
    const clock = createClock();
    const store = { baiduAppId: 'test-only', ...settings };
    const listeners = {};
    const pending = [];
    let keepalives = 0;
    const chrome = {
        runtime: {
            onInstalled: { addListener: fn => { listeners.install = fn; } },
            onMessage: { addListener: fn => { listeners.message = fn; } },
            getPlatformInfo: async () => { keepalives++; },
            getURL: path => `chrome-extension://test/${path}`,
            sendMessage: (request, callback) => pending.push({ request, callback })
        },
        storage: {
            local: {
                get: (keys, callback) => {
                    const value = Object.fromEntries(keys.filter(key => key in store)
                        .map(key => [key, store[key]]));
                    if (callback) queueMicrotask(() => callback(value));
                    else return Promise.resolve(value);
                },
                set: async values => { Object.assign(store, values); }
            },
            onChanged: { addListener() {} }
        }
    };
    const nodes = [];
    const document = {
        addEventListener() {},
        createElement() {
            const node = {
                style: {}, textContent: '', isConnected: false,
                getBoundingClientRect: () => ({ width: 180, height: 40 }),
                remove() { this.isConnected = false; }
            };
            nodes.push(node);
            return node;
        },
        body: { appendChild(node) { node.isConnected = true; } }
    };
    const context = vm.createContext({
        chrome, ...clock, AbortController, document,
        window: { innerWidth: 1000, innerHeight: 800 },
        console: { log() {}, error() {} },
        fetch: async () => { throw new Error('Unexpected fetch'); }
    });
    vm.runInContext(readFileSync(join(__dirname, '..', file), 'utf8'), context);
    return {
        context, chrome, clock, store, listeners, pending, nodes,
        keepalives: () => keepalives,
        async send(request) {
            return await new Promise(resolve => {
                assert.equal(listeners.message(request, {}, resolve), true);
            });
        }
    };
}

const response = value => ({ ok: true, json: async () => value });
const waitForAbort = signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('Hy-MT2 validates settings and falls back to 8096 / 32', () => {
    const { context } = load();
    for (const value of [undefined, null, '', 0, -1, 1.5, 'bad', Infinity, 999999]) {
        assert.deepEqual(plain(context.getHyMt2Settings({
            hyMt2Port: value, hyMt2TimeoutSeconds: value
        })), { port: 8096, timeoutSeconds: 32 });
    }
    for (const [port, timeoutSeconds] of [[1, 1], [65535, 120], [9000, 45]]) {
        assert.deepEqual(plain(context.getHyMt2Settings({
            hyMt2Port: String(port), hyMt2TimeoutSeconds: String(timeoutSeconds)
        })), { port, timeoutSeconds });
    }
});

test('installation adds defaults without replacing selected sources or saved settings', async () => {
    const first = load('background.js', { provider: 'local', ttsProvider: 'baidu' });
    await first.listeners.install();
    assert.equal(first.store.provider, 'local');
    assert.equal(first.store.ttsProvider, 'baidu');
    assert.equal(first.store.hyMt2Port, 8096);
    assert.equal(first.store.hyMt2TimeoutSeconds, 32);

    const saved = load('background.js', {
        useBaidu: true, hyMt2Port: 9001, hyMt2TimeoutSeconds: 60
    });
    await saved.listeners.install();
    assert.equal(saved.store.provider, 'baidu');
    assert.equal(saved.store.hyMt2Port, 9001);
    assert.equal(saved.store.hyMt2TimeoutSeconds, 60);
});

test('request sends raw text and reads translated_text, then releases timers', async () => {
    const env = load();
    env.context.fetch = async (url, options) => {
        assert.equal(url, 'http://localhost:9001/v1/translate');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(options.body), {
            text: 'Hello\nworld', source_lang: 'en', target_lang: 'zh'
        });
        return response({ translated_text: '  translated result \n' });
    };
    assert.equal(await env.context.fetchHyMt2Translation('Hello\nworld', {
        hyMt2Port: 9001
    }), 'translated result');
    assert.equal(env.clock.timers.size, 0);
});

test('HTTP, JSON and empty response failures release all timers', async t => {
    const cases = [
        ['connection', async () => { throw new TypeError('offline'); }, 'ERROR:HY_MT2_CONNREFUSED'],
        ['HTTP', async () => ({ ok: false, status: 500 }), 'ERROR:FAILED'],
        ['JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }), 'ERROR:FAILED'],
        ...[{}, null, { translated_text: '  ' }, { translated_text: 42 }]
            .map((value, i) => [`invalid ${i}`, async () => response(value), 'ERROR:FAILED'])
    ];
    for (const [name, fetch, expected] of cases) {
        await t.test(name, async () => {
            const env = load();
            env.context.fetch = fetch;
            assert.equal(await env.context.fetchHyMt2Translation('Hello', {}), expected);
            assert.equal(env.clock.timers.size, 0);
        });
    }
});

for (const bodyPending of [false, true]) {
    test(`32 second deadline covers ${bodyPending ? 'response body' : 'queue and headers'}`, async () => {
        const env = load();
        env.context.fetch = async (url, { signal }) => bodyPending
            ? { ok: true, json: () => waitForAbort(signal) } : waitForAbort(signal);
        let completed = false;
        const result = env.context.fetchHyMt2Translation('Hello', {})
            .then(value => { completed = true; return value; });
        await flush();
        await env.clock.tick(31000);
        assert.equal(completed, false);
        assert.equal(env.keepalives(), 1);
        await env.clock.tick(1000);
        assert.equal(await result, 'ERROR:TIMEOUT');
        assert.equal(env.clock.timers.size, 0);
    });
}

test('custom timeout is honored and a long success releases keepalive', async () => {
    const env = load();
    env.context.fetch = async (url, { signal }) => waitForAbort(signal);
    const timeout = env.context.fetchHyMt2Translation('Hello', { hyMt2TimeoutSeconds: 1 });
    await env.clock.tick(1000);
    assert.equal(await timeout, 'ERROR:TIMEOUT');
    assert.equal(env.clock.timers.size, 0);

    let finish;
    env.context.fetch = () => new Promise(resolve => { finish = resolve; });
    const success = env.context.fetchHyMt2Translation('Hello', { hyMt2TimeoutSeconds: 60 });
    await env.clock.tick(41000);
    assert.equal(env.keepalives(), 2);
    finish(response({ translated_text: 'done' }));
    assert.equal(await success, 'done');
    assert.equal(env.clock.timers.size, 0);
});

test('routing honors the provider snapshot and retains legacy fallback', async () => {
    const env = load('background.js', { provider: 'hy_mt2', baiduSecret: 'test-only' });
    for (const [name, value] of [
        ['fetchHyMt2Translation', 'hy_mt2'], ['fetchLocalModelTranslation', 'local'],
        ['fetchGoogleTranslation', 'google'], ['fetchBaiduTranslation', 'baidu']
    ]) env.context[name] = async () => value;
    for (const provider of ['google', 'baidu', 'local', 'hy_mt2']) {
        assert.equal((await env.send({ action: 'TRANSLATE_TEXT', text: 'Hi', provider })).translation, provider);
    }
    assert.equal((await env.send({ action: 'TRANSLATE_TEXT', text: 'Hi' })).translation, 'hy_mt2');
    assert.equal((await env.send({ action: 'TRANSLATE_TEXT', provider: 'invalid' })).translation, 'hy_mt2');
    env.chrome.runtime.lastError = { message: 'storage unavailable' };
    assert.equal((await env.send({ action: 'TRANSLATE_TEXT' })).translation, 'ERROR:FAILED');
});

test('Hy-MT2 provider does not change TTS routing', async () => {
    const env = load('background.js', { provider: 'hy_mt2', ttsProvider: 'local' });
    env.context.fetchLocalTTS = async () => ({ audioData: null, errorCode: 'CONNREFUSED' });
    const result = await env.send({ action: 'SPEAK_TEXT', text: 'Hello' });
    assert.equal(result.success, false);
    assert.match(result.error, /Local TTS Server Unreachable/);
});

test('content waits beyond 5 seconds for Hy-MT2 and snapshots provider', async () => {
    const env = load('content.js', { provider: 'hy_mt2' });
    let completed = false;
    const result = env.context.translateText('Hello').then(value => { completed = true; return value; });
    await flush();
    env.store.provider = 'google';
    assert.equal(env.pending[0].request.provider, 'hy_mt2');
    await env.clock.tick(31000);
    assert.equal(completed, false);
    env.pending[0].callback({ translation: 'done' });
    assert.equal(await result, 'done');
    assert.equal(env.clock.timers.size, 0);
});

test('legacy content timeout remains 5 seconds and ignores late replies', async () => {
    const env = load('content.js', { provider: 'local' });
    const result = env.context.translateText('Hello');
    await flush();
    await env.clock.tick(5000);
    assert.equal(await result, 'ERROR:TIMEOUT');
    env.pending[0].callback({ translation: 'late' });
    assert.equal(await result, 'ERROR:TIMEOUT');
});

test('content handles missing responses, closed channels and storage failures', async () => {
    for (const kind of ['missing', 'channel', 'storage', 'send']) {
        const env = load('content.js', { provider: 'hy_mt2' });
        if (kind === 'storage') env.chrome.storage.local.get = async () => { throw new Error(); };
        if (kind === 'send') env.chrome.runtime.sendMessage = () => { throw new Error(); };
        const result = env.context.translateText('Hello');
        await flush();
        if (kind === 'channel') env.chrome.runtime.lastError = { message: 'channel closed' };
        if (env.pending.length) env.pending[0].callback(undefined);
        assert.equal(await result, 'ERROR:FAILED');
        assert.equal(env.clock.timers.size, 0);
    }
});

for (const method of ['showTranslationBubble', 'showTranslationBubbleAtMouse']) {
    test(`${method}: closing keeps request pending; old reply cannot overwrite new bubble`, async () => {
        const env = load('content.js', { provider: 'hy_mt2' });
        const show = text => method === 'showTranslationBubble'
            ? env.context[method](100, 100, text) : env.context[method](text);
        const old = show('First');
        await flush();
        env.context.removeBubble();
        assert.equal(env.nodes[0].isConnected, false);
        assert.equal(env.pending.length, 1);
        const current = show('Second');
        await flush();
        const bubble = env.nodes[1];
        env.pending[1].callback({ translation: 'new result' });
        await current;
        env.pending[0].callback({ translation: 'old result' });
        await old;
        assert.equal(bubble.textContent, 'new result');
        assert.equal(bubble.isConnected, true);
        assert.equal(env.pending.length, 2);
    });
}

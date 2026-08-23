import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import type { Browser } from 'playwright';

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-browser-timeout-'));
process.chdir(tempDir);

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a parent abort cancels a hung screenshot DNS lookup before browser launch', async () => {
  const { takeBrowserScreenshot } = await import('../src/tools/browserScreenshot');
  const controller = new AbortController();
  let launchCalls = 0;
  let lookupEntered!: () => void;
  const lookupEnteredPromise = new Promise<void>((resolve) => { lookupEntered = resolve; });

  const screenshot = takeBrowserScreenshot(
    { url: 'https://example.com/report' },
    controller.signal,
    {
      lookup: async () => {
        lookupEntered();
        return new Promise<never>(() => undefined);
      },
      launch: async () => {
        launchCalls += 1;
        throw new Error('browser launch must not start');
      },
    },
  );

  await lookupEnteredPromise;
  controller.abort(new Error('screenshot deadline expired'));
  await assert.rejects(screenshot, /screenshot deadline expired/);
  assert.equal(launchCalls, 0);
});

test('capture preflight rejects private literals and private DNS results before browser launch', async () => {
  const {
    preflightBrowserScreenshotUrl,
    validateBrowserScreenshotUrlLiteral,
  } = await import('../src/tools/browserScreenshot');

  assert.throws(
    () => validateBrowserScreenshotUrlLiteral('http://169.254.169.254/latest/meta-data'),
    /private network targets are blocked/i,
  );

  await assert.rejects(
    preflightBrowserScreenshotUrl('https://internal.example.test/report', undefined, {
      lookup: async () => [{ address: '10.20.30.40', family: 4 }],
    }),
    /private network targets are blocked/i,
  );
});

test('capture preflight rejects canonical IPv4-mapped and unspecified IPv6 targets', async () => {
  const {
    preflightBrowserScreenshotUrl,
    validateBrowserScreenshotUrlLiteral,
  } = await import('../src/tools/browserScreenshot');

  for (const targetUrl of [
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/latest/meta-data',
    'http://[::]/',
  ]) {
    assert.throws(
      () => validateBrowserScreenshotUrlLiteral(targetUrl),
      /private network targets are blocked/i,
      targetUrl,
    );
  }

  for (const address of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::']) {
    await assert.rejects(
      preflightBrowserScreenshotUrl('https://public-name.example.test/report', undefined, {
        lookup: async () => [{ address, family: 6 }],
      }),
      /private network targets are blocked/i,
      address,
    );
  }

  assert.doesNotThrow(
    () => validateBrowserScreenshotUrlLiteral('https://[2606:4700:4700::1111]/'),
  );
  await assert.doesNotReject(
    preflightBrowserScreenshotUrl('https://public-name.example.test/report', undefined, {
      lookup: async () => [{ address: '2606:4700:4700::1111', family: 6 }],
    }),
  );
});

test('a parent abort cancels a hung browser launch and closes a late browser result', async () => {
  const { takeBrowserScreenshot } = await import('../src/tools/browserScreenshot');
  const controller = new AbortController();
  let resolveLaunch!: (browser: Browser) => void;
  let launchEntered!: () => void;
  const launchEnteredPromise = new Promise<void>((resolve) => { launchEntered = resolve; });
  let closeCalls = 0;
  const lateBrowser = {
    close: async () => { closeCalls += 1; },
  } as unknown as Browser;

  const screenshot = takeBrowserScreenshot(
    { url: 'https://example.com/report' },
    controller.signal,
    {
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      launch: async () => {
        launchEntered();
        return new Promise<Browser>((resolve) => { resolveLaunch = resolve; });
      },
    },
  );

  await launchEnteredPromise;
  controller.abort(new Error('screenshot deadline expired'));
  await assert.rejects(screenshot, /screenshot deadline expired/);
  resolveLaunch(lateBrowser);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1, 'a browser that launches after cancellation is closed immediately');
});

test('a hung browser close cannot keep a timed-out screenshot step open', async () => {
  const { takeBrowserScreenshot } = await import('../src/tools/browserScreenshot');
  const controller = new AbortController();
  let gotoEntered!: () => void;
  const gotoEnteredPromise = new Promise<void>((resolve) => { gotoEntered = resolve; });
  let rejectGoto!: (error: Error) => void;
  let closeCalls = 0;
  const browser = {
    newPage: async () => ({
      goto: async () => {
        gotoEntered();
        return new Promise<never>((_resolve, reject) => { rejectGoto = reject; });
      },
      screenshot: async () => undefined,
      title: async () => 'Report',
    }),
    close: () => {
      closeCalls += 1;
      rejectGoto?.(new Error('browser closed after deadline'));
      return new Promise<never>(() => undefined);
    },
  } as unknown as Browser;

  const screenshot = takeBrowserScreenshot(
    { url: 'https://example.com/report' },
    controller.signal,
    {
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      launch: async () => browser,
      closeTimeoutMs: 5,
    },
  );
  await gotoEnteredPromise;
  controller.abort(new Error('screenshot deadline expired'));
  await assert.rejects(screenshot, /browser closed after deadline|screenshot deadline expired/);
  assert.ok(closeCalls >= 2, 'abort and bounded final cleanup both request browser shutdown');
});

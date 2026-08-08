import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDriveReader,
  DriveReaderError,
  DRIVE_READER_MAX_DOWNLOAD_BYTES,
  DRIVE_READER_MAX_LIST_PAGES,
  readDriveReaderConfig,
  type DriveReaderFetch,
} from '../src/integrationGateway/adapters/nativeDriveReader';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

function decodeBase64Url(segment: string): Buffer {
  return Buffer.from(segment, 'base64url');
}

function generateTestKeypair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// --- readDriveReaderConfig -------------------------------------------------

test('readDriveReaderConfig: inline key wins over file path; file path read from disk; absent/malformed -> null', () => {
  const { privateKey } = generateTestKeypair();
  const clientEmail = 'inline-reader@test.iam.gserviceaccount.com';
  const fileClientEmail = 'file-reader@test.iam.gserviceaccount.com';

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-native-drive-reader-'));
  const keyFilePath = path.join(tempDir, 'reader-key.json');
  fs.writeFileSync(keyFilePath, JSON.stringify({ client_email: fileClientEmail, private_key: privateKey }));

  try {
    // Inline wins over file path when both are present.
    const both = readDriveReaderConfig({
      GOOGLE_LIBRARY_READER_KEY: JSON.stringify({ client_email: clientEmail, private_key: privateKey }),
      GOOGLE_LIBRARY_READER_KEY_FILE: keyFilePath,
    } as unknown as NodeJS.ProcessEnv);
    assert.ok(both);
    assert.equal(both?.clientEmail, clientEmail);
    assert.equal(both?.privateKey, privateKey);

    // File path is read from disk when inline is absent.
    const fileOnly = readDriveReaderConfig({
      GOOGLE_LIBRARY_READER_KEY_FILE: keyFilePath,
    } as unknown as NodeJS.ProcessEnv);
    assert.ok(fileOnly);
    assert.equal(fileOnly?.clientEmail, fileClientEmail);
    assert.equal(fileOnly?.privateKey, privateKey);

    // Escaped \n sequences arriving through env JSON are normalized to real newlines.
    const escapedKey = privateKey.replace(/\n/g, '\\n');
    const escaped = readDriveReaderConfig({
      GOOGLE_LIBRARY_READER_KEY: JSON.stringify({ client_email: clientEmail, private_key: escapedKey }),
    } as unknown as NodeJS.ProcessEnv);
    assert.ok(escaped);
    assert.equal(escaped?.privateKey, privateKey);

    // Absent -> null.
    assert.equal(readDriveReaderConfig({} as NodeJS.ProcessEnv), null);

    // Malformed inline JSON -> null, never throws.
    assert.equal(
      readDriveReaderConfig({ GOOGLE_LIBRARY_READER_KEY: '{not json' } as unknown as NodeJS.ProcessEnv),
      null,
    );

    // Inline JSON missing required fields -> null.
    assert.equal(
      readDriveReaderConfig({
        GOOGLE_LIBRARY_READER_KEY: JSON.stringify({ client_email: clientEmail }),
      } as unknown as NodeJS.ProcessEnv),
      null,
    );

    // File path pointing at a nonexistent file -> null, never throws.
    assert.equal(
      readDriveReaderConfig({
        GOOGLE_LIBRARY_READER_KEY_FILE: path.join(tempDir, 'does-not-exist.json'),
      } as unknown as NodeJS.ProcessEnv),
      null,
    );

    // File contents that are malformed JSON -> null.
    const badFilePath = path.join(tempDir, 'bad-key.json');
    fs.writeFileSync(badFilePath, 'not json at all');
    assert.equal(
      readDriveReaderConfig({ GOOGLE_LIBRARY_READER_KEY_FILE: badFilePath } as unknown as NodeJS.ProcessEnv),
      null,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readDriveReaderConfig memoizes the key-file read, and re-reads when the env changes', () => {
  const { privateKey } = generateTestKeypair();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-reader-memo-'));
  const firstPath = path.join(tempDir, 'first-reader.json');
  const secondPath = path.join(tempDir, 'second-reader.json');
  fs.writeFileSync(firstPath, JSON.stringify({ client_email: 'first@test.iam', private_key: privateKey }));
  fs.writeFileSync(secondPath, JSON.stringify({ client_email: 'second@test.iam', private_key: privateKey }));

  try {
    const env = { GOOGLE_LIBRARY_READER_KEY_FILE: firstPath } as unknown as NodeJS.ProcessEnv;
    assert.equal(readDriveReaderConfig(env)?.clientEmail, 'first@test.iam');

    // Deleting the file proves the second call never touched the disk. This
    // runs on every lane check, every sweep, and every settings load.
    fs.rmSync(firstPath);
    assert.equal(
      readDriveReaderConfig(env)?.clientEmail,
      'first@test.iam',
      'a repeat call with identical env must be served from the memo, not a fresh readFileSync',
    );

    // A different env is a different question, and gets a fresh answer.
    const otherEnv = { GOOGLE_LIBRARY_READER_KEY_FILE: secondPath } as unknown as NodeJS.ProcessEnv;
    assert.equal(readDriveReaderConfig(otherEnv)?.clientEmail, 'second@test.iam');

    // Including the absent case — the memo must never pin a stale answer.
    assert.equal(readDriveReaderConfig({} as NodeJS.ProcessEnv), null);
    assert.equal(readDriveReaderConfig(otherEnv)?.clientEmail, 'second@test.iam');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// --- token exchange + caching ----------------------------------------------

test('token request is a valid RS256 JWT for drive.readonly and is cached across calls', async () => {
  const { publicKey, privateKey } = generateTestKeypair();
  const clientEmail = 'token-jwt-reader@test.iam.gserviceaccount.com';

  let tokenCallCount = 0;
  let listCallCount = 0;

  const fetchImpl: DriveReaderFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url === TOKEN_URL) {
      tokenCallCount += 1;
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');

      const assertion = body.get('assertion');
      assert.ok(assertion);
      const [headerSeg, claimsSeg, sigSeg] = (assertion as string).split('.');

      const header = JSON.parse(decodeBase64Url(headerSeg).toString('utf-8'));
      assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });

      const claims = JSON.parse(decodeBase64Url(claimsSeg).toString('utf-8'));
      assert.equal(claims.iss, clientEmail);
      assert.equal(claims.scope, DRIVE_SCOPE);
      assert.equal(claims.aud, TOKEN_URL);
      assert.equal(claims.exp - claims.iat, 3600);

      const signingInput = `${headerSeg}.${claimsSeg}`;
      const verified = crypto.verify(
        'RSA-SHA256',
        Buffer.from(signingInput),
        publicKey,
        decodeBase64Url(sigSeg),
      );
      assert.equal(verified, true);

      return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    }

    if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) {
      listCallCount += 1;
      assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Bearer tok');
      return jsonResponse({ files: [] });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);

  await reader.listFolderTree('root-folder-1');
  await reader.listFolderTree('root-folder-1');

  assert.equal(tokenCallCount, 1);
  assert.equal(listCallCount, 2);
});

// --- listFolderTree pagination + recursion ----------------------------------

test('listFolderTree paginates and recurses but never fetches more than 3 pages', async () => {
  const { privateKey } = generateTestKeypair();
  const clientEmail = 'pagination-reader@test.iam.gserviceaccount.com';

  const rootId = 'root-folder-id';
  const subId = 'sub-folder-id';

  const fileA = { id: 'file-a', name: 'A.txt', mimeType: 'text/plain' };
  const subfolderEntry = { id: subId, name: 'Sub', mimeType: 'application/vnd.google-apps.folder' };
  const fileB = { id: 'file-b', name: 'B.txt', mimeType: 'text/plain' };
  const fileC = { id: 'file-c', name: 'C.txt', mimeType: 'text/plain' };
  const fileD = { id: 'file-d', name: 'D.txt', mimeType: 'text/plain' };

  let listCallCount = 0;
  const seenRequests: string[] = [];

  const fetchImpl: DriveReaderFetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url === TOKEN_URL) {
      return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    }

    if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) {
      listCallCount += 1;
      const parsed = new URL(url);
      const q = parsed.searchParams.get('q') || '';
      const pageToken = parsed.searchParams.get('pageToken');
      const folderMatch = q.match(/^'([^']+)' in parents/);
      const folderId = folderMatch?.[1];
      seenRequests.push(`${folderId}:${pageToken || 'first'}`);

      if (folderId === rootId && !pageToken) {
        return jsonResponse({ files: [fileA, subfolderEntry], nextPageToken: 'root-p2' });
      }
      if (folderId === rootId && pageToken === 'root-p2') {
        return jsonResponse({ files: [fileB] });
      }
      if (folderId === subId && !pageToken) {
        return jsonResponse({ files: [fileC], nextPageToken: 'sub-p2' });
      }
      if (folderId === subId && pageToken === 'sub-p2') {
        return jsonResponse({ files: [fileD] });
      }
      throw new Error(`Unexpected files.list request: folder=${folderId} pageToken=${pageToken}`);
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);
  const tree = await reader.listFolderTree(rootId);

  assert.equal(DRIVE_READER_MAX_LIST_PAGES, 3);
  assert.equal(listCallCount, 3);
  assert.deepEqual(seenRequests, [`${rootId}:first`, `${rootId}:root-p2`, `${subId}:first`]);

  const resultIds = tree.files.map((file) => file.id);
  assert.deepEqual(resultIds, [fileA.id, subfolderEntry.id, fileB.id, fileC.id]);
  assert.ok(!resultIds.includes(fileD.id), 'sub-p2 must never be fetched once the page cap is hit');

  // The listing IS short. Saying so is the whole difference between "the
  // operator has no other files" and "we did not look".
  assert.equal(tree.truncated, true, 'a page-capped listing must report itself truncated');

  // Attribution: which folder each file came from, so a caller that can only
  // reconcile SOME folders knows which files it is entitled to judge.
  assert.equal(tree.files.find((file) => file.id === fileA.id)?.parentFolderId, rootId);
  assert.equal(tree.files.find((file) => file.id === fileC.id)?.parentFolderId, subId);
});

test('listFolderTree reports truncated: false when the whole tree fits the page budget', async () => {
  const { privateKey } = generateTestKeypair();
  const clientEmail = 'complete-listing-reader@test.iam.gserviceaccount.com';
  const rootId = 'small-root';

  const fetchImpl: DriveReaderFetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) {
      return jsonResponse({ files: [{ id: 'only-file', name: 'only.txt', mimeType: 'text/plain' }] });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);
  const tree = await reader.listFolderTree(rootId);

  assert.equal(tree.truncated, false);
  assert.deepEqual(tree.files.map((file) => file.id), ['only-file']);
  assert.equal(tree.files[0]?.parentFolderId, rootId);
});

// --- getFolderMeta: the real access probe -----------------------------------
//
// listFolderTree cannot serve as an access probe: Drive returns HTTP 200 with
// an empty file list when the caller lacks access to a folder, so an
// inaccessible folder is indistinguishable from an empty one if a child
// listing is all a caller ever does. getFolderMeta calls files.get on the
// folder itself, which genuinely 404s/403s when the reader cannot see it.

test('getFolderMeta requests files.get with id,name,mimeType fields and returns the metadata', async () => {
  const { privateKey } = generateTestKeypair();
  const clientEmail = 'folder-meta-reader@test.iam.gserviceaccount.com';
  const folderId = 'probe-folder-id';

  let requestedUrl: string | null = null;

  const fetchImpl: DriveReaderFetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${folderId}?`)) {
      requestedUrl = url;
      return jsonResponse({ id: folderId, name: 'Violema Library', mimeType: 'application/vnd.google-apps.folder' });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);
  const meta = await reader.getFolderMeta(folderId);

  assert.deepEqual(meta, {
    id: folderId,
    name: 'Violema Library',
    mimeType: 'application/vnd.google-apps.folder',
  });
  assert.ok(requestedUrl, 'expected a files.get request');
  const params = new URL(requestedUrl as string).searchParams;
  assert.equal(params.get('fields'), 'id,name,mimeType');
});

test('getFolderMeta surfaces a 404 (folder not shared with the reader) as DriveReaderError http_error carrying status 404', async () => {
  const { privateKey } = generateTestKeypair();
  const clientEmail = 'folder-meta-404-reader@test.iam.gserviceaccount.com';
  const folderId = 'unshared-folder-id';

  const fetchImpl: DriveReaderFetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${folderId}?`)) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);

  await assert.rejects(reader.getFolderMeta(folderId), (error: unknown) => {
    if (!(error instanceof DriveReaderError)) assert.fail('expected a DriveReaderError');
    assert.equal(error.code, 'http_error');
    assert.equal(error.status, 404);
    return true;
  });
});

// --- downloadFile size guard -------------------------------------------------

test('downloadFile refuses oversized content with DriveReaderError too_large', async () => {
  const { privateKey } = generateTestKeypair();
  const clientEmail = 'download-reader@test.iam.gserviceaccount.com';
  const fileId = 'huge-file-id';

  const fetchImpl: DriveReaderFetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url === TOKEN_URL) {
      return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    }

    if (url === `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`) {
      // A body that blows up if anything ever tries to read it — proves the
      // Content-Length check short-circuits before any buffering happens.
      const throwingBody = new ReadableStream({
        pull() {
          throw new Error('body must never be read once Content-Length exceeds the cap');
        },
      });
      return new Response(throwingBody, {
        status: 200,
        headers: { 'content-length': '6000000' },
      });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);

  await assert.rejects(
    reader.downloadFile(fileId),
    (error: unknown) => {
      if (!(error instanceof DriveReaderError)) assert.fail('expected a DriveReaderError');
      assert.equal(error.code, 'too_large');
      assert.ok(!error.message.includes(privateKey));
      return true;
    },
  );

  assert.ok(DRIVE_READER_MAX_DOWNLOAD_BYTES < 6_000_000);
});

// --- downloadFile: mid-stream failures stay inside DriveReaderError -----------

/** A body that yields one chunk and then errors the stream with `error`. */
function bodyThatFailsMidStream(error: Error): ReadableStream<Uint8Array> {
  let pulls = 0;
  return new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(new Uint8Array(16));
        return;
      }
      throw error;
    },
  });
}

const midStreamCases: Array<{ label: string; error: Error; expectedCode: string }> = [
  {
    label: 'a network drop mid-body',
    error: new TypeError('terminated'),
    expectedCode: 'http_error',
  },
  {
    // AbortSignal.timeout covers body STREAMING, not just headers — a slow
    // 4 MB PDF aborts here, well after timedFetch has returned.
    label: 'the request timeout firing mid-body',
    error: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    expectedCode: 'timeout',
  },
];

for (const testCase of midStreamCases) {
  test(`downloadFile maps ${testCase.label} to DriveReaderError ${testCase.expectedCode}`, async () => {
    const { privateKey } = generateTestKeypair();
    const clientEmail = 'stream-reader@test.iam.gserviceaccount.com';
    const fileId = 'slow-file-id';

    const fetchImpl: DriveReaderFetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === TOKEN_URL) return jsonResponse({ access_token: 'tok', expires_in: 3600 });
      if (url === `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`) {
        return new Response(bodyThatFailsMidStream(testCase.error), { status: 200 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);

    await assert.rejects(reader.downloadFile(fileId), (error: unknown) => {
      if (!(error instanceof DriveReaderError)) {
        assert.fail(`expected a DriveReaderError, got ${(error as Error)?.name}`);
      }
      assert.equal(error.code, testCase.expectedCode);
      assert.ok(!error.message.includes(privateKey));
      return true;
    });
  });
}

test('downloadFile still reports too_large (not http_error) when the stream cap trips', async () => {
  const { privateKey } = generateTestKeypair();
  const clientEmail = 'cap-reader@test.iam.gserviceaccount.com';
  const fileId = 'streamed-huge-file-id';

  // No Content-Length header, so only the running byte count can catch it.
  const fetchImpl: DriveReaderFetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    if (url === `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`) {
      const body = new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1_000_000));
        },
      });
      return new Response(body, { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);

  await assert.rejects(reader.downloadFile(fileId), (error: unknown) => {
    if (!(error instanceof DriveReaderError)) assert.fail('expected a DriveReaderError');
    assert.equal(error.code, 'too_large', 'the cap error must not be re-wrapped as a generic http_error');
    return true;
  });
});

// --- exportDoc ----------------------------------------------------------------

test('exportDoc maps a failing body read to DriveReaderError, and caps its size', async () => {
  const { privateKey } = generateTestKeypair();
  const clientEmail = 'export-fail-reader@test.iam.gserviceaccount.com';
  const exportUrlFor = (id: string) =>
    `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text%2Fplain`;

  const bodies: Record<string, () => ReadableStream<Uint8Array> | string> = {
    'timeout-doc': () =>
      bodyThatFailsMidStream(
        Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
      ),
    'broken-doc': () => bodyThatFailsMidStream(new TypeError('terminated')),
    'huge-doc': () => 'x'.repeat(DRIVE_READER_MAX_DOWNLOAD_BYTES + 1),
  };

  const fetchImpl: DriveReaderFetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    for (const [id, makeBody] of Object.entries(bodies)) {
      if (url === exportUrlFor(id)) return new Response(makeBody(), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);

  const expectations: Array<[string, string]> = [
    ['timeout-doc', 'timeout'],
    ['broken-doc', 'http_error'],
    ['huge-doc', 'too_large'],
  ];

  for (const [fileId, expectedCode] of expectations) {
    await assert.rejects(reader.exportDoc(fileId), (error: unknown) => {
      if (!(error instanceof DriveReaderError)) {
        assert.fail(`expected a DriveReaderError for ${fileId}, got ${(error as Error)?.name}`);
      }
      assert.equal(error.code, expectedCode, `${fileId} should surface as ${expectedCode}`);
      assert.ok(!error.message.includes(privateKey));
      return true;
    });
  }
});

test('exportDoc returns the exported plain text', async () => {
  const { privateKey } = generateTestKeypair();
  const clientEmail = 'export-reader@test.iam.gserviceaccount.com';
  const fileId = 'doc-file-id';

  const fetchImpl: DriveReaderFetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url === TOKEN_URL) {
      return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    }

    if (url === `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fplain`) {
      return new Response('Hello from a Google Doc export.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);
  const text = await reader.exportDoc(fileId);

  assert.equal(text, 'Hello from a Google Doc export.');
});

// --- error safety ---------------------------------------------------------

test('errors never contain the private key', async () => {
  const { privateKey } = generateTestKeypair();
  const clientEmail = 'error-safety-reader@test.iam.gserviceaccount.com';

  const fetchImpl: DriveReaderFetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url === TOKEN_URL) {
      return new Response('server exploded', { status: 500 });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);

  await assert.rejects(
    reader.listFolderTree('some-folder'),
    (error: unknown) => {
      if (!(error instanceof DriveReaderError)) assert.fail('expected a DriveReaderError');
      assert.equal(error.code, 'auth_failed');
      assert.ok(!error.message.includes(privateKey));
      assert.ok(!(error.stack || '').includes(privateKey));
      // Also guard against a leaked key body fragment (in case of partial normalization bugs).
      const keyBodyLine = privateKey.split('\n')[1] || '';
      if (keyBodyLine) {
        assert.ok(!error.message.includes(keyBodyLine));
        assert.ok(!(error.stack || '').includes(keyBodyLine));
      }
      return true;
    },
  );
});

// --- fix round 1: crypto.sign() and response.json() must never escape the taxonomy ---

test('a malformed private key surfaces as DriveReaderError auth_failed without leaking key material', async () => {
  const { privateKey: validKey } = generateTestKeypair();
  const clientEmail = 'malformed-key-reader@test.iam.gserviceaccount.com';
  // Simulates a truncated PEM from a hand-pasted env var: crypto.sign throws a
  // raw OpenSSL decoder error for this, which must never escape as-is.
  const truncatedPrivateKey = validKey.slice(0, 60);

  const fetchImpl: DriveReaderFetch = async () => {
    throw new Error('fetch must never be called when the private key cannot be used to sign');
  };

  const reader = createDriveReader({ clientEmail, privateKey: truncatedPrivateKey }, fetchImpl);

  await assert.rejects(
    reader.listFolderTree('some-folder'),
    (error: unknown) => {
      if (!(error instanceof DriveReaderError)) assert.fail('expected a DriveReaderError');
      assert.equal(error.code, 'auth_failed');
      assert.ok(!error.message.includes(truncatedPrivateKey));
      assert.ok(!error.message.includes('BEGIN'));
      assert.ok(!error.message.toLowerCase().includes('decoder'));
      assert.ok(!(error.stack || '').includes(truncatedPrivateKey));
      return true;
    },
  );
});

test('token endpoint 200 with invalid JSON surfaces as DriveReaderError', async () => {
  const { privateKey } = generateTestKeypair();
  const clientEmail = 'bad-token-json-reader@test.iam.gserviceaccount.com';

  const fetchImpl: DriveReaderFetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url === TOKEN_URL) {
      return new Response('this is not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);

  await assert.rejects(
    reader.listFolderTree('some-folder'),
    (error: unknown) => {
      if (!(error instanceof DriveReaderError)) assert.fail('expected a DriveReaderError');
      assert.equal(error.code, 'auth_failed');
      assert.ok(!error.message.includes(privateKey));
      return true;
    },
  );
});

test('files.list endpoint 200 with invalid JSON surfaces as DriveReaderError', async () => {
  const { privateKey } = generateTestKeypair();
  const clientEmail = 'bad-list-json-reader@test.iam.gserviceaccount.com';

  const fetchImpl: DriveReaderFetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url === TOKEN_URL) {
      return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    }

    if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) {
      return new Response('this is not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const reader = createDriveReader({ clientEmail, privateKey }, fetchImpl);

  await assert.rejects(
    reader.listFolderTree('some-folder'),
    (error: unknown) => {
      if (!(error instanceof DriveReaderError)) assert.fail('expected a DriveReaderError');
      assert.equal(error.code, 'http_error');
      assert.ok(!error.message.includes(privateKey));
      return true;
    },
  );
});

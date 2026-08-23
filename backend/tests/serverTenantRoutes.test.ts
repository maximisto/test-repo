import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

type TestServerContext = {
  baseUrl: string;
};

function closeServer(server: http.Server | null) {
  if (!server) return Promise.resolve();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function withTempServer(run: (context: TestServerContext) => Promise<void>) {
  const originalCwd = process.cwd();
  const originalApproved = process.env.VIOLEMA_APPROVED_EMAILS;
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
  const originalGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-server-tenant-'));

  process.chdir(tempDir);
  process.env.VIOLEMA_APPROVED_EMAILS = [
    'alice@example.com',
    'bob@example.com',
    'stale@example.com',
    'email-flow@example.com',
    'email-investor@example.com',
    'email-invalid@example.com',
    'email-string@example.com',
    'login-fallback@example.com',
    'allowlisted-oauth@example.com',
  ].join(',');
  process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
  process.env.GOOGLE_CLIENT_ID = 'test-google-client';
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';

  let server: http.Server | null = null;

  try {
    const { default: app } = await import('../src/server');
    server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a port.');

    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
  } finally {
    await closeServer(server);
    process.chdir(originalCwd);
    if (typeof originalApproved === 'string') process.env.VIOLEMA_APPROVED_EMAILS = originalApproved;
    else delete process.env.VIOLEMA_APPROVED_EMAILS;
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    if (typeof originalGoogleClientId === 'string') process.env.GOOGLE_CLIENT_ID = originalGoogleClientId;
    else delete process.env.GOOGLE_CLIENT_ID;
    if (typeof originalGoogleClientSecret === 'string') process.env.GOOGLE_CLIENT_SECRET = originalGoogleClientSecret;
    else delete process.env.GOOGLE_CLIENT_SECRET;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test('beta auth policy gates Terms and trials before tenant routes', async () => withTempServer(async ({ baseUrl }) => {
  const auth = await import('../src/auth');
  const adminAccess = await import('../src/adminAccessStore');
  const consent = await import('../src/betaConsentStore');
  const betaProgram = await import('../src/betaProgram');
  const store = await import('../src/platform/store');
  const scheduler = await import('../src/scheduler');
  const auditLog = await import('../src/integrationGateway/auditLog');

  const termsResponse = await fetch(`${baseUrl}/api/auth/terms`);
  assert.equal(termsResponse.status, 200);
  const terms = await readJson(termsResponse);
  assert.equal(terms.version, betaProgram.CURRENT_BETA_TERMS_VERSION);
  assert.equal(terms.digest, betaProgram.CURRENT_BETA_TERMS_DIGEST);
  assert.equal(terms.path, betaProgram.BETA_TERMS_PATH);
  assert.equal(terms.canonicalText, betaProgram.CURRENT_BETA_TERMS_CANONICAL_TEXT);
  assert.deepEqual(terms.participantTypes, betaProgram.PARTICIPANT_TYPES);
  assert.equal(
    (await import('node:crypto')).default
      .createHash('sha256')
      .update(String(terms.canonicalText))
      .digest('hex'),
    terms.digest,
  );

  const unauthenticatedAcceptance = await fetch(`${baseUrl}/api/auth/terms/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      acceptedTerms: true,
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
    }),
  });
  assert.equal(unauthenticatedAcceptance.status, 401);

  for (const invalidSignupQuery of [
    {
      acceptedTerms: 'true',
      acceptedEducation: 'true',
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
    },
    {
      acceptedTerms: 'true',
      acceptedEducation: 'true',
      participantType: 'investor',
      termsVersion: 'stale-terms-version',
    },
  ]) {
    const invalidSignupUrl = new URL(`${baseUrl}/api/auth/google/start`);
    invalidSignupUrl.searchParams.set('intent', 'signup');
    for (const [key, value] of Object.entries(invalidSignupQuery)) {
      invalidSignupUrl.searchParams.set(key, value);
    }
    const invalidSignupResponse = await fetch(invalidSignupUrl, { redirect: 'manual' });
    assert.equal(invalidSignupResponse.status, 302);
    assert.equal(new URL(String(invalidSignupResponse.headers.get('location'))).pathname, '/signup');
  }

  const emailSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'signup',
      email: 'email-flow@example.com',
      name: 'Email Flow',
      method: 'google',
      participantType: 'partner',
      acceptedTerms: true,
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      acceptedEducation: true,
    }),
  });
  assert.equal(emailSessionResponse.status, 200);
  const emailSession = await readJson(emailSessionResponse) as { user: Record<string, unknown> };
  assert.equal(emailSession.user.method, 'email');
  assert.equal(emailSession.user.participantType, 'partner');
  assert.equal(emailSession.user.requiresTermsAcceptance, false);
  const emailFlowUser = auth.listAuthUsers().find((user) => user.email === 'email-flow@example.com');
  assert.ok(emailFlowUser);
  assert.equal(store.getWorkspaceLedgerSummary(emailFlowUser.defaultWorkspaceId).balanceCredits, 500);

  const emailInvestorResponse = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'signup',
      email: 'email-investor@example.com',
      name: 'Email Investor',
      participantType: 'investor',
      acceptedTerms: true,
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      acceptedEducation: true,
    }),
  });
  assert.equal(emailInvestorResponse.status, 200);
  const emailInvestorSession = await readJson(emailInvestorResponse) as { user: Record<string, unknown> };
  assert.equal(emailInvestorSession.user.participantType, 'investor');
  assert.equal(consent.getCurrentBetaConsent('email-investor@example.com')?.participantType, 'investor');

  const emailLoginResponse = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'login',
      email: 'email-flow@example.com',
      name: 'Email Flow',
      participantType: 'investor',
      acceptedTerms: true,
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      acceptedEducation: true,
    }),
  });
  assert.equal(emailLoginResponse.status, 200);
  const emailLoginSession = await readJson(emailLoginResponse) as { user: Record<string, unknown> };
  assert.equal(emailLoginSession.user.participantType, 'partner');
  assert.equal(consent.listBetaConsentReceipts('email-flow@example.com').length, 1);

  for (const participantType of [null, 'tester']) {
    const invalidParticipantResponse = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'signup',
        email: 'email-invalid@example.com',
        name: 'Invalid Participant',
        participantType,
        acceptedTerms: true,
        termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
        acceptedEducation: true,
      }),
    });
    assert.equal(invalidParticipantResponse.status, 400);
  }

  const invalidIntentResponse = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'resume',
      email: 'email-invalid@example.com',
      name: 'Invalid Intent',
    }),
  });
  assert.equal(invalidIntentResponse.status, 400);

  const deniedSignupResponse = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'signup',
      email: 'pending-email-partner@example.com',
      name: 'Pending Email Partner',
      participantType: 'partner',
      acceptedTerms: true,
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      acceptedEducation: true,
    }),
  });
  assert.equal(deniedSignupResponse.status, 403);
  assert.equal(adminAccess.getAccessRecord('pending-email-partner@example.com')?.participantType, 'partner');

  const stringAcceptanceResponse = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'signup',
      email: 'email-string@example.com',
      participantType: 'founder_operator',
      name: 'String Acceptance',
      acceptedTerms: 'false',
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      acceptedEducation: true,
    }),
  });
  assert.equal(stringAcceptanceResponse.status, 200);
  const stringAcceptanceSession = await readJson(stringAcceptanceResponse) as { user: Record<string, unknown> };
  assert.equal(stringAcceptanceSession.user.requiresTermsAcceptance, true);
  assert.equal(consent.hasCurrentBetaConsent('email-string@example.com'), false);
  const stringAcceptanceUser = auth.listAuthUsers().find((user) => user.email === 'email-string@example.com');
  assert.ok(stringAcceptanceUser);
  assert.equal(store.getWorkspaceLedgerSummary(stringAcceptanceUser.defaultWorkspaceId).balanceCredits, 0);

  const currentTermsAcceptedAt = '2026-07-11T12:01:00.000Z';
  for (const email of ['alice@example.com', 'bob@example.com']) {
    consent.recordBetaConsent({
      email,
      participantType: 'founder_operator',
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      termsDigest: betaProgram.CURRENT_BETA_TERMS_DIGEST,
      acceptedAt: currentTermsAcceptedAt,
      authMethod: 'email',
      acceptanceSource: 'signup',
    });
  }

  const alice = auth.upsertAuthUser({
    email: 'alice@example.com',
    name: 'Alice',
    role: 'user',
    method: 'email',
    acceptedTerms: true,
    participantType: 'founder_operator',
    acceptedTermsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
    acceptedTermsAt: currentTermsAcceptedAt,
    acceptedEducation: true,
  });
  const bob = auth.upsertAuthUser({
    email: 'bob@example.com',
    name: 'Bob',
    role: 'user',
    method: 'email',
    acceptedTerms: true,
    participantType: 'founder_operator',
    acceptedTermsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
    acceptedTermsAt: currentTermsAcceptedAt,
    acceptedEducation: true,
  });
  const aliceSession = auth.createAuthSession(alice.id);
  const bobSession = auth.createAuthSession(bob.id);

  const legacyApprovedAt = '2026-07-11T12:02:00.000Z';
  fs.writeFileSync(path.join(process.cwd(), 'admin-access.json'), JSON.stringify([
    {
      email: 'legacy-investor@example.com',
      name: 'Legacy Investor',
      method: 'google',
      participantType: 'investor',
      status: 'approved',
      role: 'user',
      createdAt: legacyApprovedAt,
      updatedAt: legacyApprovedAt,
    },
    {
      email: 'legacy-current@example.com',
      name: 'Legacy Current',
      method: 'google',
      participantType: 'partner',
      status: 'approved',
      role: 'user',
      createdAt: legacyApprovedAt,
      updatedAt: legacyApprovedAt,
      updatedBy: 'mutable-editor@example.com',
    },
  ], null, 2));

  const approvedInvestorAcceptedAt = '2026-07-11T12:03:00.000Z';
  consent.recordBetaConsent({
    email: 'approved-investor@example.com',
    participantType: 'investor',
    termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
    termsDigest: betaProgram.CURRENT_BETA_TERMS_DIGEST,
    acceptedAt: approvedInvestorAcceptedAt,
    authMethod: 'google',
    acceptanceSource: 'signup',
  });
  adminAccess.recordAccessRequest({
    email: 'approved-investor@example.com',
    name: 'Approved Investor',
    method: 'google',
    participantType: 'investor',
    identityVerifiedAt: approvedInvestorAcceptedAt,
    acceptedTermsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
    acceptedTermsAt: approvedInvestorAcceptedAt,
  });
  adminAccess.setAccessStatus({
    email: 'approved-investor@example.com',
    status: 'approved',
    role: 'user',
    updatedBy: 'max@violema.com',
  });
  adminAccess.setAccessParticipantType({
    email: 'approved-investor@example.com',
    participantType: 'partner',
    updatedBy: 'editor-b@example.com',
  });
  adminAccess.setAccessParticipantType({
    email: 'approved-investor@example.com',
    participantType: 'investor',
    updatedBy: 'editor-b@example.com',
  });

  const localFetch = globalThis.fetch;
  async function completeGoogleOAuth(
    query: Record<string, string>,
    profile: { email: string; name: string; email_verified: boolean },
  ) {
    const startUrl = new URL(`${baseUrl}/api/auth/google/start`);
    for (const [key, value] of Object.entries(query)) startUrl.searchParams.set(key, value);
    const startResponse = await localFetch(startUrl, { redirect: 'manual' });
    assert.equal(startResponse.status, 302);
    const providerLocation = startResponse.headers.get('location');
    assert.ok(providerLocation);
    const state = new URL(providerLocation).searchParams.get('state');
    assert.ok(state);
    const statePayload = JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString('utf-8')) as Record<string, unknown>;

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      if (requestUrl === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'test-access-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (requestUrl === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify(profile), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return localFetch(input, init);
    };

    try {
      const callbackUrl = new URL(`${baseUrl}/api/auth/google/callback`);
      callbackUrl.searchParams.set('code', 'verified-google-code');
      callbackUrl.searchParams.set('state', state);
      const callbackResponse = await localFetch(callbackUrl, { redirect: 'manual' });
      return { callbackResponse, statePayload };
    } finally {
      globalThis.fetch = localFetch;
    }
  }

  const legacyLogin = await completeGoogleOAuth(
    { intent: 'login', next: '/dashboard' },
    { email: 'legacy-investor@example.com', name: 'Legacy Investor', email_verified: true },
  );
  assert.equal(legacyLogin.statePayload.acceptedTerms, false);
  const legacyCookie = legacyLogin.callbackResponse.headers.get('set-cookie');
  assert.ok(legacyCookie);
  const legacySessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { cookie: legacyCookie },
  });
  assert.equal(legacySessionResponse.status, 200);
  const legacySession = await readJson(legacySessionResponse) as {
    user: Record<string, unknown>;
  };
  assert.equal(legacySession.user.acceptedTerms, false);
  assert.equal(legacySession.user.acceptedTermsVersion, undefined);
  assert.equal(legacySession.user.participantType, 'investor');
  assert.equal(legacySession.user.requiresTermsAcceptance, true);
  const legacyInvestor = auth.listAuthUsers().find((user) => user.email === 'legacy-investor@example.com');
  assert.ok(legacyInvestor);
  assert.equal(store.getWorkspaceLedgerSummary(legacyInvestor.defaultWorkspaceId).balanceCredits, 0);

  const legacyCurrentAcceptedAt = '2026-07-11T12:03:30.000Z';
  consent.recordBetaConsent({
    email: 'legacy-current@example.com',
    participantType: 'partner',
    termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
    termsDigest: betaProgram.CURRENT_BETA_TERMS_DIGEST,
    acceptedAt: legacyCurrentAcceptedAt,
    authMethod: 'google',
    acceptanceSource: 'oauth_callback',
  });
  const legacyCurrentLogin = await completeGoogleOAuth(
    { intent: 'login', next: '/dashboard' },
    { email: 'legacy-current@example.com', name: 'Legacy Current', email_verified: true },
  );
  assert.ok(legacyCurrentLogin.callbackResponse.headers.get('set-cookie'));
  const legacyCurrentRecord = adminAccess.getAccessRecord('legacy-current@example.com');
  assert.equal(legacyCurrentRecord?.status, 'approved');
  assert.equal(legacyCurrentRecord?.identityVerifiedAt !== undefined, true);
  assert.equal(legacyCurrentRecord?.acceptedTermsVersion, betaProgram.CURRENT_BETA_TERMS_VERSION);
  assert.equal(legacyCurrentRecord?.acceptedTermsAt, legacyCurrentAcceptedAt);
  assert.equal(legacyCurrentRecord?.approvedBy, undefined);
  assert.equal(legacyCurrentRecord?.approvedAt, undefined);
  const legacyCurrentUser = auth.listAuthUsers().find((user) => user.email === 'legacy-current@example.com');
  assert.ok(legacyCurrentUser);
  const legacyCurrentTrial = store.listLedgerEntries(legacyCurrentUser.defaultWorkspaceId)
    .find((entry) => entry.source === 'trial_grant');
  assert.equal(legacyCurrentTrial?.metadata?.approvalActor, undefined);

  const allowlistedAcceptedAt = '2026-07-11T12:04:00.000Z';
  consent.recordBetaConsent({
    email: 'allowlisted-oauth@example.com',
    participantType: 'partner',
    termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
    termsDigest: betaProgram.CURRENT_BETA_TERMS_DIGEST,
    acceptedAt: allowlistedAcceptedAt,
    authMethod: 'google',
    acceptanceSource: 'oauth_callback',
  });
  const allowlistedLogin = await completeGoogleOAuth(
    { intent: 'login', next: '/dashboard' },
    { email: 'allowlisted-oauth@example.com', name: 'Allowlisted OAuth', email_verified: true },
  );
  assert.ok(allowlistedLogin.callbackResponse.headers.get('set-cookie'));
  const allowlistedRecord = adminAccess.getAccessRecord('allowlisted-oauth@example.com');
  assert.equal(allowlistedRecord?.status, 'approved');
  assert.equal(allowlistedRecord?.participantType, 'partner');
  assert.ok(allowlistedRecord?.identityVerifiedAt);
  assert.equal(allowlistedRecord?.acceptedTermsVersion, betaProgram.CURRENT_BETA_TERMS_VERSION);
  assert.equal(allowlistedRecord?.acceptedTermsAt, allowlistedAcceptedAt);
  assert.equal(allowlistedRecord?.approvedBy, undefined);
  assert.equal(allowlistedRecord?.approvedAt, undefined);

  const loginFallback = await completeGoogleOAuth(
    { intent: 'login', next: '/dashboard', participantType: 'partner' },
    { email: 'login-fallback@example.com', name: 'Login Fallback', email_verified: true },
  );
  assert.ok(loginFallback.callbackResponse.headers.get('set-cookie'));
  const loginFallbackUser = auth.listAuthUsers().find((user) => user.email === 'login-fallback@example.com');
  assert.ok(loginFallbackUser);
  assert.equal(loginFallbackUser.participantType, 'founder_operator');

  const unverifiedSignup = await completeGoogleOAuth(
    {
      intent: 'signup',
      next: '/dashboard',
      acceptedTerms: 'true',
      acceptedEducation: 'true',
      participantType: 'partner',
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
    },
    { email: 'unverified-partner@example.com', name: 'Unverified Partner', email_verified: false },
  );
  assert.equal(unverifiedSignup.callbackResponse.headers.get('set-cookie'), null);
  assert.equal(adminAccess.getAccessRecord('unverified-partner@example.com'), null);
  assert.equal(consent.hasCurrentBetaConsent('unverified-partner@example.com'), false);

  const pendingSignup = await completeGoogleOAuth(
    {
      intent: 'signup',
      next: '/dashboard',
      acceptedTerms: 'true',
      acceptedEducation: 'true',
      participantType: 'partner',
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
    },
    { email: 'pending-partner@example.com', name: 'Pending Partner', email_verified: true },
  );
  assert.equal(pendingSignup.callbackResponse.headers.get('set-cookie'), null);
  assert.equal(auth.listAuthUsers().some((user) => user.email === 'pending-partner@example.com'), false);
  const pendingAccess = adminAccess.getAccessRecord('pending-partner@example.com');
  assert.equal(pendingAccess?.status, 'requested');
  assert.equal(pendingAccess?.participantType, 'partner');
  assert.equal(pendingAccess?.acceptedTermsVersion, betaProgram.CURRENT_BETA_TERMS_VERSION);
  assert.equal(consent.hasCurrentBetaConsent('pending-partner@example.com'), true);
  const unapprovedWorkspaceLedger = store.getWorkspaceLedgerSummary('workspace_pending_partner');
  assert.equal(unapprovedWorkspaceLedger.balanceCredits, 0);

  const approvedInvestorLogin = await completeGoogleOAuth(
    { intent: 'login', next: '/dashboard' },
    { email: 'approved-investor@example.com', name: 'Approved Investor', email_verified: true },
  );
  const approvedInvestorCookie = approvedInvestorLogin.callbackResponse.headers.get('set-cookie');
  assert.ok(approvedInvestorCookie);
  const approvedInvestorSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { cookie: approvedInvestorCookie },
  });
  assert.equal(approvedInvestorSessionResponse.status, 200);
  const approvedInvestorSession = await readJson(approvedInvestorSessionResponse) as {
    user: Record<string, unknown>;
  };
  assert.equal(approvedInvestorSession.user.participantType, 'investor');
  assert.equal(approvedInvestorSession.user.requiresTermsAcceptance, false);
  const approvedInvestor = auth.listAuthUsers().find((user) => user.email === 'approved-investor@example.com');
  assert.ok(approvedInvestor);
  const approvedInvestorWorkspaceLedger = store.getWorkspaceLedgerSummary(approvedInvestor.defaultWorkspaceId);
  assert.equal(approvedInvestorWorkspaceLedger.balanceCredits, 500);
  const approvedInvestorTrial = store.listLedgerEntries(approvedInvestor.defaultWorkspaceId)
    .find((entry) => entry.source === 'trial_grant');
  assert.equal(approvedInvestorTrial?.metadata?.approvalActor, 'max@violema.com');

  const stale = auth.upsertAuthUser({
    email: 'stale@example.com',
    name: 'Stale Terms',
    role: 'user',
    method: 'email',
    participantType: 'founder_operator',
    acceptedTerms: true,
    acceptedEducation: true,
  });
  const staleSession = auth.createAuthSession(stale.id);
  const staleHeaders = { cookie: `violema_session=${staleSession.token}` };
  const staleSessionResponse = await fetch(`${baseUrl}/api/auth/session`, { headers: staleHeaders });
  assert.equal(staleSessionResponse.status, 200);
  assert.equal(
    ((await readJson(staleSessionResponse)).user as Record<string, unknown>).requiresTermsAcceptance,
    true,
  );
  const staleTermsProtectedResponse = await fetch(`${baseUrl}/api/settings`, { headers: staleHeaders });
  assert.equal(staleTermsProtectedResponse.status, 403);
  const staleTermsProtectedBody = await readJson(staleTermsProtectedResponse);
  assert.equal(staleTermsProtectedBody.code, 'terms_reacceptance_required');
  const staleSessionPatch = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'PATCH',
    headers: {
      ...staleHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Terms Bypass', slackChannelId: 'C-BYPASS' }),
  });
  assert.equal(staleSessionPatch.status, 403);
  assert.equal((await readJson(staleSessionPatch)).code, 'terms_reacceptance_required');
  assert.equal(auth.listAuthUsers().find((user) => user.email === stale.email)?.name, 'Stale Terms');

  const acceptedTermsResponse = await fetch(`${baseUrl}/api/auth/terms/accept`, {
    method: 'POST',
    headers: {
      ...staleHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      acceptedTerms: true,
      termsVersion: betaProgram.CURRENT_BETA_TERMS_VERSION,
      participantType: 'partner',
    }),
  });
  assert.equal(acceptedTermsResponse.status, 200);
  const acceptedTermsSession = await readJson(acceptedTermsResponse) as {
    user: Record<string, unknown>;
  };
  assert.equal(acceptedTermsSession.user.requiresTermsAcceptance, false);
  assert.equal(acceptedTermsSession.user.acceptedTermsVersion, betaProgram.CURRENT_BETA_TERMS_VERSION);
  const reauthorizationReceipt = consent.getCurrentBetaConsent('stale@example.com');
  assert.equal(reauthorizationReceipt?.acceptanceSource, 'reauthorization');
  assert.equal(reauthorizationReceipt?.participantType, 'founder_operator');
  assert.equal(store.getWorkspaceLedgerSummary(stale.defaultWorkspaceId).balanceCredits, 500);
  assert.equal((await fetch(`${baseUrl}/api/settings`, { headers: staleHeaders })).status, 200);

  const bobTask = store.createTask({
    workspaceId: bob.defaultWorkspaceId,
    title: 'Bob private task',
    description: 'Tenant-isolated work item',
    kind: 'automation',
    priority: 'medium',
    autonomyMode: 'supervised',
    assigneeRole: 'operator',
  });
  const bobAutomation = scheduler.createAutomation({
    workspaceId: bob.defaultWorkspaceId,
    name: 'Bob private automation',
    schedule: 'daily at 9am',
    actions: ['Summarize Bob-only data'],
  }, async () => ({ ok: true }));
  const bobRun = store.createTaskRun({
    workspaceId: bob.defaultWorkspaceId,
    taskId: bobTask.id,
    agentRole: 'operator',
    modelTier: 'default',
    estimatedCredits: 3,
    metadata: { automationId: bobAutomation.id },
  });
  store.addLedgerEntry({
    workspaceId: bob.defaultWorkspaceId,
    source: 'task_run',
    deltaCredits: -3,
    referenceType: 'task',
    referenceId: bobRun.id,
    note: 'Bob private task run charge',
  });
  const bobWorkflowLedgerEvent = auditLog.appendWorkflowLedgerEvent({
    workspaceId: bob.defaultWorkspaceId,
    workflowId: 'bob-private-workflow',
    automationId: bobAutomation.id,
    taskId: bobTask.id,
    taskRunId: bobRun.id,
    type: 'data_read',
    summary: 'Bob private workflow event',
  });

  const aliceHeaders = {
    cookie: `violema_session=${aliceSession.token}`,
  };
  const bobHeaders = {
    cookie: `violema_session=${bobSession.token}`,
  };
  const protectedPaths = [
    '/api/settings',
    '/api/platform/tasks',
    '/api/platform/task-runs',
    '/api/platform/ledger',
    '/api/automations',
    '/api/billing/config',
    '/api/studio/workflows',
    '/api/studio/runs',
    `/api/workflows/runs/${bobRun.id}/ledger`,
  ];

  for (const apiPath of protectedPaths) {
    const response = await fetch(`${baseUrl}${apiPath}`, {
      headers: {
        ...aliceHeaders,
        'X-Workspace-Id': bob.defaultWorkspaceId,
      },
    });
    assert.equal(response.status, 403, `${apiPath} should reject cross-tenant workspace selection`);
    const payload = await readJson(response);
    assert.match(String(payload.error), /Workspace access denied/);
  }

  const aliceTasks = await fetch(`${baseUrl}/api/platform/tasks`, { headers: aliceHeaders });
  assert.equal(aliceTasks.status, 200);
  assert.deepEqual((await readJson(aliceTasks)).items, []);

  const aliceRuns = await fetch(`${baseUrl}/api/platform/task-runs`, { headers: aliceHeaders });
  assert.equal(aliceRuns.status, 200);
  assert.deepEqual((await readJson(aliceRuns)).items, []);

  const aliceLedger = await fetch(`${baseUrl}/api/platform/ledger`, { headers: aliceHeaders });
  assert.equal(aliceLedger.status, 200);
  assert.deepEqual((await readJson(aliceLedger)).items, []);

  const aliceWorkflowLedger = await fetch(`${baseUrl}/api/workflows/runs/${bobRun.id}/ledger`, { headers: aliceHeaders });
  assert.equal(aliceWorkflowLedger.status, 200);
  assert.deepEqual((await readJson(aliceWorkflowLedger)).items, []);

  const aliceStudioWorkflows = await fetch(`${baseUrl}/api/studio/workflows`, { headers: aliceHeaders });
  assert.equal(aliceStudioWorkflows.status, 200);
  const aliceStudioWorkflowPayload = await readJson(aliceStudioWorkflows);
  assert.deepEqual(
    (aliceStudioWorkflowPayload.items as Array<{ automation: { id: string } }>).map((item) => item.automation.id),
    [],
  );

  const aliceStudioWorkflowDetail = await fetch(`${baseUrl}/api/studio/workflows/${bobAutomation.id}`, { headers: aliceHeaders });
  assert.equal(aliceStudioWorkflowDetail.status, 404);

  const aliceStudioRuns = await fetch(`${baseUrl}/api/studio/runs`, { headers: aliceHeaders });
  assert.equal(aliceStudioRuns.status, 200);
  assert.deepEqual((await readJson(aliceStudioRuns)).items, []);

  const aliceStudioReplay = await fetch(`${baseUrl}/api/studio/replay/${bobRun.id}`, { headers: aliceHeaders });
  assert.equal(aliceStudioReplay.status, 404);

  const aliceStudioContext = await fetch(`${baseUrl}/api/studio/context/${bobAutomation.id}`, { headers: aliceHeaders });
  assert.equal(aliceStudioContext.status, 404);

  const aliceStudioPolicies = await fetch(`${baseUrl}/api/studio/policies/${bobAutomation.id}`, { headers: aliceHeaders });
  assert.equal(aliceStudioPolicies.status, 404);

  const aliceAutomationMutations = [
    {
      method: 'POST',
      path: `/api/automations/${bobAutomation.id}/run`,
      body: undefined,
    },
    {
      method: 'PATCH',
      path: `/api/automations/${bobAutomation.id}`,
      body: { name: 'Alice should not rename Bob automation' },
    },
    {
      method: 'POST',
      path: `/api/automations/${bobAutomation.id}/reviews/${bobRun.id}/approve`,
      body: { reviewer: 'Alice' },
    },
    {
      method: 'POST',
      path: `/api/automations/${bobAutomation.id}/reviews/${bobRun.id}/request-changes`,
      body: { reviewer: 'Alice', note: 'No cross-tenant review changes' },
    },
    {
      method: 'POST',
      path: `/api/automations/${bobAutomation.id}/reviews/${bobRun.id}/rerun`,
      body: { reviewer: 'Alice', note: 'No cross-tenant reruns' },
    },
    {
      method: 'DELETE',
      path: `/api/automations/${bobAutomation.id}`,
      body: undefined,
    },
  ];

  for (const request of aliceAutomationMutations) {
    const response = await fetch(`${baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        ...aliceHeaders,
        'Content-Type': 'application/json',
      },
      body: request.body ? JSON.stringify(request.body) : undefined,
    });
    assert.equal(response.status, 404, `${request.method} ${request.path} should not expose Bob's automation`);
    const payload = await readJson(response);
    assert.match(String(payload.error), /Automation not found|Workflow not found/);
  }

  const bobTasks = await fetch(`${baseUrl}/api/platform/tasks`, { headers: bobHeaders });
  assert.equal(bobTasks.status, 200);
  const bobTaskPayload = await readJson(bobTasks);
  assert.deepEqual(
    (bobTaskPayload.items as Array<{ id: string }>).map((item) => item.id),
    [bobTask.id],
  );

  const bobAutomations = await fetch(`${baseUrl}/api/automations`, { headers: bobHeaders });
  assert.equal(bobAutomations.status, 200);
  const bobAutomationPayload = await readJson(bobAutomations);
  assert.deepEqual(
    (bobAutomationPayload.items as Array<{ id: string }>).map((item) => item.id),
    [bobAutomation.id],
  );

  const bobRuns = await fetch(`${baseUrl}/api/platform/task-runs`, { headers: bobHeaders });
  assert.equal(bobRuns.status, 200);
  assert.deepEqual(
    ((await readJson(bobRuns)).items as Array<{ id: string }>).map((item) => item.id),
    [bobRun.id],
  );

  const bobLedger = await fetch(`${baseUrl}/api/platform/ledger`, { headers: bobHeaders });
  assert.equal(bobLedger.status, 200);
  assert.ok(((await readJson(bobLedger)).items as Array<{ referenceId?: string }>).some((item) => item.referenceId === bobRun.id));

  const bobWorkflowLedger = await fetch(`${baseUrl}/api/workflows/runs/${bobRun.id}/ledger`, { headers: bobHeaders });
  assert.equal(bobWorkflowLedger.status, 200);
  assert.deepEqual(
    ((await readJson(bobWorkflowLedger)).items as Array<{ id: string }>).map((item) => item.id),
    [bobWorkflowLedgerEvent.id],
  );

  const aliceCreatedAutomation = await fetch(`${baseUrl}/api/automations`, {
    method: 'POST',
    headers: {
      ...aliceHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Alice owned automation',
      schedule: 'daily at 11am',
      actions: ['Summarize Alice-only data'],
    }),
  });
  assert.equal(aliceCreatedAutomation.status, 201);
  const aliceCreatedPayload = await readJson(aliceCreatedAutomation);
  assert.equal((aliceCreatedPayload.item as { owner_user_id?: string }).owner_user_id, alice.id);

  const tooManySteps = Array.from({ length: 25 }, (_, index) => ({
    id: `step_${index + 1}`,
    kind: 'note',
    objective: `Keep operator-authored step ${index + 1}.`,
  }));
  const rejectedStepCreate = await fetch(`${baseUrl}/api/automations`, {
    method: 'POST',
    headers: { ...aliceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Must not lose step 25',
      schedule: 'daily at 12pm',
      steps: tooManySteps,
    }),
  });
  assert.equal(rejectedStepCreate.status, 400);
  assert.match(String((await readJson(rejectedStepCreate)).error), /at most 24 workflow steps/i);

  const rejectedActionCreate = await fetch(`${baseUrl}/api/automations`, {
    method: 'POST',
    headers: { ...aliceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Must not lose action 25',
      schedule: 'daily at 12pm',
      actions: Array.from({ length: 25 }, (_, index) => `Operator action ${index + 1}`),
    }),
  });
  assert.equal(rejectedActionCreate.status, 400);
  assert.match(String((await readJson(rejectedActionCreate)).error), /at most 24 workflow steps/i);

  const rejectedMultiDeliveryCreate = await fetch(`${baseUrl}/api/automations`, {
    method: 'POST',
    headers: { ...aliceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Must not silently close two deliveries',
      schedule: 'daily at 12pm',
      actions: ['Send the brief to Slack', 'Email the brief to the board'],
    }),
  });
  assert.equal(rejectedMultiDeliveryCreate.status, 400);
  assert.match(String((await readJson(rejectedMultiDeliveryCreate)).error), /one delivery step/i);

  const rejectedQueryArgumentsCreate = await fetch(`${baseUrl}/api/automations`, {
    method: 'POST',
    headers: { ...aliceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Must reject impossible Stripe query',
      schedule: 'daily at 12pm',
      steps: [{
        id: 'stripe-typo',
        kind: 'query',
        objective: 'Read Stripe revenue.',
        inputs: { source: 'stripe', query_type: 'typo' },
      }],
    }),
  });
  assert.equal(rejectedQueryArgumentsCreate.status, 400);
  assert.match(String((await readJson(rejectedQueryArgumentsCreate)).error), /query_type "typo" is not supported/i);

  const rejectedCaptureArgumentsCreate = await fetch(`${baseUrl}/api/automations`, {
    method: 'POST',
    headers: { ...aliceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Must reject missing capture URL',
      schedule: 'daily at 12pm',
      steps: [{
        id: 'capture-missing-url',
        kind: 'capture',
        objective: 'Capture the pricing page.',
        inputs: {},
      }],
    }),
  });
  assert.equal(rejectedCaptureArgumentsCreate.status, 400);
  assert.match(String((await readJson(rejectedCaptureArgumentsCreate)).error), /needs a public http or https URL/i);

  const rejectedOrderingCreate = await fetch(`${baseUrl}/api/automations`, {
    method: 'POST',
    headers: { ...aliceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Must not deliver before evidence',
      schedule: 'daily at 12pm',
      steps: [
        {
          id: 'deliver-first',
          kind: 'deliver',
          objective: 'Deliver the brief.',
          deliveryTarget: { channel: 'slack', target: '#ops' },
        },
        { id: 'search-late', kind: 'search', objective: 'Research the evidence.' },
      ],
    }),
  });
  assert.equal(rejectedOrderingCreate.status, 400);
  assert.match(String((await readJson(rejectedOrderingCreate)).error), /workflow step order/i);

  const aliceAutomationId = (aliceCreatedPayload.item as { id: string }).id;
  const rejectedStepPatch = await fetch(`${baseUrl}/api/automations/${aliceAutomationId}`, {
    method: 'PATCH',
    headers: { ...aliceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps: tooManySteps }),
  });
  assert.equal(rejectedStepPatch.status, 400);
  assert.match(String((await readJson(rejectedStepPatch)).error), /at most 24 workflow steps/i);
  assert.deepEqual(
    scheduler.getAutomationById(aliceAutomationId)?.actions,
    ['Summarize Alice-only data'],
    'a rejected over-limit patch cannot persist a truncated definition',
  );

  const rejectedMultiDeliveryPatch = await fetch(`${baseUrl}/api/automations/${aliceAutomationId}`, {
    method: 'PATCH',
    headers: { ...aliceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions: ['Post the brief to Slack', 'Notify the board by email'] }),
  });
  assert.equal(rejectedMultiDeliveryPatch.status, 400);
  assert.match(String((await readJson(rejectedMultiDeliveryPatch)).error), /one delivery step/i);
  assert.deepEqual(
    scheduler.getAutomationById(aliceAutomationId)?.actions,
    ['Summarize Alice-only data'],
    'a rejected multi-delivery patch cannot alter the stored mission',
  );

  const rejectedQueryArgumentsPatch = await fetch(`${baseUrl}/api/automations/${aliceAutomationId}`, {
    method: 'PATCH',
    headers: { ...aliceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      steps: [{
        id: 'stripe-typo',
        kind: 'query',
        objective: 'Read Stripe revenue.',
        inputs: { source: 'stripe', query_type: 'typo' },
      }],
    }),
  });
  assert.equal(rejectedQueryArgumentsPatch.status, 400);
  assert.match(String((await readJson(rejectedQueryArgumentsPatch)).error), /query_type "typo" is not supported/i);
  assert.deepEqual(
    scheduler.getAutomationById(aliceAutomationId)?.actions,
    ['Summarize Alice-only data'],
    'a rejected argument patch cannot alter the stored mission',
  );

  const rejectedOrderingPatch = await fetch(`${baseUrl}/api/automations/${aliceAutomationId}`, {
    method: 'PATCH',
    headers: { ...aliceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      steps: [
        {
          id: 'write-first',
          kind: 'query',
          objective: 'Archive the brief.',
          inputs: { source: 'account_library', query_type: 'write', section: 'Competitive Intelligence' },
        },
        { id: 'search-late', kind: 'search', objective: 'Research the evidence.' },
      ],
    }),
  });
  assert.equal(rejectedOrderingPatch.status, 400);
  assert.match(String((await readJson(rejectedOrderingPatch)).error), /workflow step order/i);
  assert.deepEqual(
    scheduler.getAutomationById(aliceAutomationId)?.actions,
    ['Summarize Alice-only data'],
    'a rejected ordering patch cannot alter the stored mission',
  );

  fs.writeFileSync(path.join(process.cwd(), 'beta-consent-receipts.json'), '{malformed');
  fs.writeFileSync(path.join(process.cwd(), 'admin-access.json'), '{malformed');
  const adminMagicToken = auth.createAdminMagicLoginToken({
    email: 'max@violema.com',
    name: 'Max',
    next: '/admin',
  });
  const adminMagicResponse = await fetch(
    `${baseUrl}/api/auth/admin/magic?token=${encodeURIComponent(adminMagicToken)}`,
    { redirect: 'manual' },
  );
  assert.equal(adminMagicResponse.status, 302);
  const adminCookie = adminMagicResponse.headers.get('set-cookie');
  assert.ok(adminCookie);
  const adminSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(adminSessionResponse.status, 200);
  const adminSession = await readJson(adminSessionResponse) as {
    user: Record<string, unknown>;
  };
  assert.equal(adminSession.user.role, 'admin');
  assert.equal(adminSession.user.requiresTermsAcceptance, true);
  assert.equal((await fetch(`${baseUrl}/api/settings`, {
    headers: { cookie: adminCookie },
  })).status, 200);
}));

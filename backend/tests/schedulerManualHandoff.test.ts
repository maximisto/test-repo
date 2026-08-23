import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('manual trigger refuses before acknowledgement when its durable handoff write fails', async (t) => {
  const originalCwd = process.cwd();
  const originalDisableScheduler = process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-scheduler-handoff-'));

  try {
    process.chdir(tempDir);
    process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = '1';
    const scheduler = await import('../src/scheduler');
    const automation = scheduler.createAutomation({
      workspaceId: 'workspace_scheduler_handoff',
      name: 'Durable scheduler handoff',
      schedule: 'every monday at 9am',
      actions: ['Keep a note'],
      steps: [{ id: 'note', kind: 'note', title: 'Keep note', objective: 'Keep a note.' }],
    }, async () => ({ ok: true }));
    const writeFileSync = fs.writeFileSync.bind(fs);
    let triggerCalls = 0;
    t.mock.method(console, 'error', () => undefined);
    t.mock.method(fs, 'writeFileSync', ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof target === 'string' && target.endsWith(`${path.sep}automations.json`)) {
        throw new Error('automation handoff write unavailable');
      }
      return (writeFileSync as (...values: unknown[]) => unknown)(target, ...args);
    }) as typeof fs.writeFileSync);

    const result = scheduler.triggerAutomationNow(automation.id, async () => {
      triggerCalls += 1;
      return { ok: true };
    }, automation);

    assert.equal(result.status, 'handoff_failed');
    assert.equal(triggerCalls, 0, 'runner ownership never transferred');
  } finally {
    process.chdir(originalCwd);
    if (typeof originalDisableScheduler === 'string') process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER = originalDisableScheduler;
    else delete process.env.VIOLEMA_DISABLE_AUTOMATION_SCHEDULER;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

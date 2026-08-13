import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('sweepOrphanedTaskRuns fails runs stranded in running/retrying from before boot', async () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-orphaned-runs-'));
  process.chdir(tempDir);

  try {
    const store = await import('../src/platform/store');
    const baseInput = {
      workspaceId: 'workspace_demo',
      taskId: 'task_demo',
      agentRole: 'operator' as const,
      modelTier: 'default' as const,
      estimatedCredits: 10,
    };

    const orphanRunning = store.createTaskRun(baseInput);
    const orphanRetrying = store.createTaskRun(baseInput);
    store.updateTaskRun(orphanRetrying.id, { status: 'retrying' });
    const finished = store.createTaskRun(baseInput);
    store.finalizeTaskRun(finished.id, { status: 'succeeded' });

    // Boot happens after all three runs started.
    const bootTime = new Date(Date.now() + 5);
    const freshAfterBoot = store.createTaskRun(baseInput);
    store.updateTaskRun(freshAfterBoot.id, { startedAt: new Date(bootTime.getTime() + 1000).toISOString() } as never);

    const swept = store.sweepOrphanedTaskRuns(bootTime);
    const sweptIds = swept.map((run) => run.id).sort();
    assert.deepEqual(sweptIds, [orphanRunning.id, orphanRetrying.id].sort(), 'Only pre-boot running/retrying runs are swept.');

    const runs = store.listTaskRuns('workspace_demo');
    const byId = new Map(runs.map((run) => [run.id, run]));
    assert.equal(byId.get(orphanRunning.id)?.status, 'failed');
    assert.ok(byId.get(orphanRunning.id)?.finishedAt, 'Swept run must carry finishedAt.');
    // Facts, never a canned diagnosis: the sweep knows the run never
    // finished, not WHY it died. The old message blamed "a backend restart"
    // for every stranded run — the stale 512MB-PM2-cap-era explanation —
    // which also covered for runs a swallowed error abandoned mid-uptime.
    assert.match(String(byId.get(orphanRunning.id)?.error), /never finished/i);
    assert.doesNotMatch(String(byId.get(orphanRunning.id)?.error), /restart|memory|pm2/i, 'No asserted cause.');
    assert.match(String(byId.get(orphanRunning.id)?.error), /cause was not recorded/i, 'The unknown is named.');
    assert.equal(
      byId.get(orphanRunning.id)?.metadata?.orphanSweptAtBoot,
      bootTime.toISOString(),
      'The sweep stamps the boot it acted at.',
    );
    assert.equal(byId.get(orphanRunning.id)?.metadata?.orphanSweptFromStatus, 'running');
    assert.equal(byId.get(orphanRetrying.id)?.metadata?.orphanSweptFromStatus, 'retrying');
    assert.equal(byId.get(orphanRetrying.id)?.status, 'failed');
    assert.equal(byId.get(finished.id)?.status, 'succeeded', 'Finished runs stay untouched.');
    assert.equal(byId.get(freshAfterBoot.id)?.status, 'running', 'Post-boot runs stay untouched.');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('sweepZombieTasks closes running tasks whose runs are all terminal — and nothing else', async () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violema-zombie-tasks-'));
  process.chdir(tempDir);

  try {
    const store = await import('../src/platform/store');
    const runInput = (taskId: string) => ({
      workspaceId: 'workspace_demo',
      taskId,
      agentRole: 'operator' as const,
      modelTier: 'default' as const,
      estimatedCredits: 10,
    });
    const makeTask = (status: 'running' | 'waiting_review') => {
      const task = store.createTask({ workspaceId: 'workspace_demo', title: 'QA task', kind: 'automation' });
      store.updateTask(task.id, { status });
      return task;
    };

    // The 2026-08-03 zombie shape: task running, run long since succeeded.
    const zombie = makeTask('running');
    const zombieOldRun = store.createTaskRun(runInput(zombie.id));
    store.finalizeTaskRun(zombieOldRun.id, { status: 'failed' });
    const zombieNewRun = store.createTaskRun(runInput(zombie.id));
    store.finalizeTaskRun(zombieNewRun.id, { status: 'succeeded' });

    // Live work: run still in flight — closing this would race the scheduler.
    const live = makeTask('running');
    store.createTaskRun(runInput(live.id));

    // Never ran: nothing will ever close it, so the sweep fails it honestly
    // (operator ruling 2026-08-04: "kill all the zombies").
    const runless = makeTask('running');

    // Open review gate: not in scope, must never be touched at boot.
    const waiting = makeTask('waiting_review');
    const waitingRun = store.createTaskRun(runInput(waiting.id));
    store.finalizeTaskRun(waitingRun.id, { status: 'succeeded' });

    const bootTime = new Date(Date.now() + 5);
    const swept = store.sweepZombieTasks(bootTime);

    assert.deepEqual(swept.map((task) => task.id).sort(), [zombie.id, runless.id].sort(), 'The zombie and the run-less relic are swept.');

    const tasks = new Map(store.listTasks('workspace_demo').map((task) => [task.id, task]));
    const closed = tasks.get(zombie.id);
    assert.equal(closed?.status, 'completed', 'The NEWEST run outcome wins — succeeded maps to completed.');
    assert.equal(closed?.metadata?.zombieSweptFromRun, zombieNewRun.id, 'The sweep records which run decided the outcome.');
    assert.ok(closed?.metadata?.zombieSweptAt, 'The sweep stamps when it acted.');
    assert.equal(tasks.get(live.id)?.status, 'running', 'A task with an in-flight run stays running.');
    const failedRunless = tasks.get(runless.id);
    assert.equal(failedRunless?.status, 'failed', 'A pre-boot running task with no runs fails: no run will ever close it.');
    assert.equal(failedRunless?.metadata?.zombieSweptReason, 'no_runs', 'The sweep names why it failed a task that never ran.');
    assert.ok(failedRunless?.metadata?.zombieSweptAt, 'The run-less sweep stamps when it acted.');
    assert.equal(failedRunless?.metadata?.zombieSweptFromRun, undefined, 'No run decided this outcome, so none is claimed.');
    assert.equal(tasks.get(waiting.id)?.status, 'waiting_review', 'An open review gate is never closed by a boot.');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';

/**
 * The sidebar's project list and current-project subscriptions both observe the
 * whole settings collection. A settings write therefore re-emits both of
 * them, and each emission re-renders the whole board.
 *
 * The collaboration manager writes a settings record on every session start
 * and on every stop, so the manager's own bookkeeping re-renders the board.
 */
const repos: RxRepository[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.db.close();
});

it("counts the emissions a settings write causes", async () => {
  const rx = await createRxRepository({ name: `emit${crypto.randomUUID().replaceAll("-", "")}` });
  repos.push(rx);
  const board = await rx.createProject('Board', 'project');

  let projectEmissions = 0;
  let currentEmissions = 0;
  const stopProjects = rx.subscribeProjects(() => { projectEmissions += 1; });
  const stopCurrent = rx.subscribeCurrentProject(() => { currentEmissions += 1; });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const afterMount = { projectEmissions, currentEmissions };
  console.log('emissions after mount:', JSON.stringify(afterMount));

  // The write the collaboration manager makes when it records the account's
  // project order.
  const before = { projectEmissions, currentEmissions };
  await rx.setProjectOrderAccount('account-a');
  await new Promise((resolve) => setTimeout(resolve, 300));
  console.log('emissions caused by one settings write:', JSON.stringify({
    projects: projectEmissions - before.projectEmissions,
    currentProject: currentEmissions - before.currentEmissions
  }));

  stopProjects();
  stopCurrent();

  // A settings write that changes nothing must not re-emit anything: the
  // board should not re-render for bookkeeping.
  const afterStop = { projectEmissions, currentEmissions };
  await rx.setProjectOrderAccount('account-a');
  await new Promise((resolve) => setTimeout(resolve, 300));
  console.log('emissions caused by an unchanged settings write:', JSON.stringify({
    projects: projectEmissions - afterStop.projectEmissions,
    currentProject: currentEmissions - afterStop.currentEmissions
  }));

  expect(projectEmissions - afterStop.projectEmissions).toBe(0);
  expect(currentEmissions - afterStop.currentEmissions).toBe(0);
}, 60000);

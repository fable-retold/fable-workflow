/**
 * fable-workflow - Hydrate tests
 *
 * hydrate() rebuilds a subject from its stored event log, for a server that persists the
 * log rather than holding the engine in memory. The key guarantee is fidelity: building a
 * subject live and then rebuilding a fresh engine from that subject's timeline must produce
 * identical current states and identical folded metrics. That round trip is the guard that
 * keeps the replay fold and the live fold from drifting apart.
 */
const libAssert = require('assert');

const libFableWorkflow = require('../source/Fable-Workflow.js');
const libWorkflowEngine = libFableWorkflow.WorkflowEngine;

function deployWorkflow()
{
	return {
		Key: 'deploy',
		Name: 'Deploy Pipeline',
		States:
		[
			{ Key: 'queued', Name: 'Queued', IsInitial: true },
			{ Key: 'building', Name: 'Building' },
			{ Key: 'review', Name: 'In Review' },
			{ Key: 'deployed', Name: 'Deployed', IsTerminal: true }
		],
		Transitions:
		[
			{ From: 'queued', To: 'building', RequiresEntitlement: 'build', Guard: { address: 'Change.HasTests', op: '==', value: true } },
			{ From: 'building', To: 'review', RequiresEntitlement: 'build' },
			{ From: 'review', To: 'deployed', RequiresEntitlement: 'deploy', Guard: { all: [ { address: 'Change.Approved', op: '==', value: true }, { address: 'Change.GreenCI', op: '==', value: true } ] } },
			{ From: 'review', To: 'building', RequiresEntitlement: 'deploy' }
		]
	};
}

function makeEngine(pChanges, pClock)
{
	return new libWorkflowEngine(
		{
			now: () => pClock.t,
			contextResolver: (pID) => ({ Change: pChanges[pID] })
		});
}

suite
(
	'fable-workflow: hydrate (replay from the log)',
	() =>
	{
		test('a closed subject hydrates to identical state and metrics', (fDone) =>
		{
			let tmpChanges = { c1: { HasTests: true, Approved: true, GreenCI: true } };
			let tmpLive = makeEngine(tmpChanges, { t: 0 });
			tmpLive.defineWorkflow(deployWorkflow());
			tmpLive.open('c1', 'deploy', { ID: 'jan', Entitlements: ['build'] }, 0);
			tmpLive.emit('c1', { Type: 'actor.start', Actor: 'jan' }, 0);
			tmpLive.advance('c1', 'building', { ID: 'jan', Entitlements: ['build'] }, 1000);
			tmpLive.emit('c1', { Type: 'actor.start', Actor: 'jill' }, 1000);
			tmpLive.emit('c1', { Type: 'actor.stop', Actor: 'jill' }, 3000);
			tmpLive.advance('c1', 'review', { ID: 'jan', Entitlements: ['build'] }, 4000);
			tmpLive.emit('c1', { Type: 'actor.stop', Actor: 'jan' }, 5000);
			tmpLive.advance('c1', 'deployed', { ID: 'deb', Entitlements: ['deploy'] }, 6000);

			let tmpTimeline = tmpLive.getTimeline('c1');
			let tmpLiveState = tmpLive.getState('c1');
			let tmpLiveMetrics = tmpLive.getMetrics('c1');

			// a fresh engine, different clock, rebuilt from the log alone
			let tmpRebuilt = makeEngine(tmpChanges, { t: 99999 });
			tmpRebuilt.defineWorkflow(deployWorkflow());
			let tmpState = tmpRebuilt.hydrate('c1', 'deploy', tmpTimeline);

			libAssert.deepStrictEqual(tmpState, tmpLiveState);
			libAssert.deepStrictEqual(tmpRebuilt.getMetrics('c1'), tmpLiveMetrics);
			// jan 0..5000 and jill 1000..3000 -> effort 7000, active 5000, overlap 2000
			libAssert.strictEqual(tmpRebuilt.getMetrics('c1').OverlapMS, 2000);
			fDone();
		});

		test('a mid-flight subject hydrates and recomputes eligibility', (fDone) =>
		{
			let tmpChanges = { c1: { HasTests: true, Approved: true, GreenCI: true } };
			let tmpLive = makeEngine(tmpChanges, { t: 0 });
			tmpLive.defineWorkflow(deployWorkflow());
			tmpLive.open('c1', 'deploy', { ID: 'jan', Entitlements: ['build'] }, 0);
			tmpLive.advance('c1', 'building', { ID: 'jan', Entitlements: ['build'] }, 1000);
			tmpLive.advance('c1', 'review', { ID: 'jan', Entitlements: ['build'] }, 4000);

			let tmpRebuilt = makeEngine(tmpChanges, { t: 8000 });
			tmpRebuilt.defineWorkflow(deployWorkflow());
			tmpRebuilt.hydrate('c1', 'deploy', tmpLive.getTimeline('c1'));

			libAssert.deepStrictEqual(tmpRebuilt.getState('c1').CurrentStates, ['review']);
			libAssert.strictEqual(tmpRebuilt.getMetrics('c1').StateTime.queued, 1000);
			libAssert.strictEqual(tmpRebuilt.getMetrics('c1').StateTime.building, 3000);
			// eligibility was rebuilt: the guarded deploy exit reads as satisfied
			let tmpExits = tmpRebuilt.getAvailableExits('c1').filter((pExit) => pExit.ToState === 'deployed');
			libAssert.strictEqual(tmpExits[0].GuardSatisfied, true);
			fDone();
		});

		test('hydrate rejects an unknown workflow and a duplicate subject', (fDone) =>
		{
			let tmpEngine = makeEngine({ c1: {} }, { t: 0 });
			tmpEngine.defineWorkflow(deployWorkflow());
			libAssert.throws(() => tmpEngine.hydrate('c1', 'nope', []), /unknown workflow/);
			tmpEngine.hydrate('c1', 'deploy', []);
			libAssert.throws(() => tmpEngine.hydrate('c1', 'deploy', []), /already open/);
			fDone();
		});
	}
);

/**
 * fable-workflow - Unit Tests
 *
 * The engine is exercised directly (no Fable needed); one suite proves the Fable
 * service wiring. The test domain is a deliberately arbitrary "deploy pipeline" fed
 * through a context resolver, so the same engine that the example runs against
 * editorial articles is shown driving a different data model purely from config.
 */
const libAssert = require('assert');

const libFableWorkflow = require('../source/Fable-Workflow.js');
const libWorkflowEngine = libFableWorkflow.WorkflowEngine;
const libWorkflowGuards = libFableWorkflow.WorkflowGuards;

// A deploy-pipeline workflow defined entirely in config.
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

// An engine whose data model is a plain object the test mutates; the engine reaches
// it only through the resolver, never by field name.
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
	'fable-workflow',
	() =>
	{
		suite
		(
			'Module exports',
			() =>
			{
				test('exports the provider, engine, and guards', (fDone) =>
				{
					libAssert.strictEqual(typeof libFableWorkflow, 'function');
					libAssert.strictEqual(typeof libWorkflowEngine, 'function');
					libAssert.strictEqual(typeof libWorkflowGuards, 'function');
					fDone();
				});
			}
		);

		suite
		(
			'Guards (structured condition trees)',
			() =>
			{
				let tmpGuards = new libWorkflowGuards();
				let tmpContext = { Item: { Score: 4, QA: { Passed: true } }, Links: { Media: [{ Type: 'image' }, { Type: 'pdf' }] } };

				test('leaf operators evaluate against addresses', (fDone) =>
				{
					libAssert.strictEqual(tmpGuards.evaluate({ address: 'Item.Score', op: '>=', value: 3 }, tmpContext), true);
					libAssert.strictEqual(tmpGuards.evaluate({ address: 'Item.Score', op: '>', value: 9 }, tmpContext), false);
					libAssert.strictEqual(tmpGuards.evaluate({ address: 'Item.QA.Passed', op: '==', value: true }, tmpContext), true);
					libAssert.strictEqual(tmpGuards.evaluate({ address: 'Item.Missing', op: 'exists' }, tmpContext), false);
					fDone();
				});

				test('all / any / not compose', (fDone) =>
				{
					libAssert.strictEqual(tmpGuards.evaluate({ all: [ { address: 'Item.QA.Passed', op: '==', value: true }, { address: 'Item.Score', op: '>=', value: 3 } ] }, tmpContext), true);
					libAssert.strictEqual(tmpGuards.evaluate({ all: [ { address: 'Item.QA.Passed', op: '==', value: true }, { address: 'Item.Score', op: '>=', value: 9 } ] }, tmpContext), false);
					libAssert.strictEqual(tmpGuards.evaluate({ any: [ { address: 'Item.Score', op: '>=', value: 9 }, { address: 'Item.QA.Passed', op: '==', value: true } ] }, tmpContext), true);
					libAssert.strictEqual(tmpGuards.evaluate({ not: { address: 'Item.QA.Passed', op: '==', value: true } }, tmpContext), false);
					fDone();
				});

				test('wildcard collection reductions', (fDone) =>
				{
					libAssert.strictEqual(tmpGuards.evaluate({ address: 'Links.Media[].Type', op: 'includesAny', value: ['image', 'video'] }, tmpContext), true);
					libAssert.strictEqual(tmpGuards.evaluate({ address: 'Links.Media[].Type', op: 'includesAny', value: ['video'] }, tmpContext), false);
					libAssert.strictEqual(tmpGuards.evaluate({ address: 'Links.Media[].Type', op: 'countGte', value: 2 }, tmpContext), true);
					fDone();
				});

				test('a null guard is always satisfied', (fDone) =>
				{
					libAssert.strictEqual(tmpGuards.evaluate(null, tmpContext), true);
					fDone();
				});

				test('dependencies lists the addresses', (fDone) =>
				{
					let tmpDeps = tmpGuards.dependencies({ all: [ { address: 'Item.QA.Passed', op: '==', value: true }, { address: 'Item.Score', op: '>=', value: 3 } ] });
					libAssert.deepStrictEqual(tmpDeps.sort(), ['Item.QA.Passed', 'Item.Score']);
					fDone();
				});

				test('validate rejects a bad operator and a missing address', (fDone) =>
				{
					libAssert.strictEqual(tmpGuards.validate({ address: 'Item.Score', op: '>=', value: 3 }), null);
					libAssert.ok(tmpGuards.validate({ address: 'Item.Score', op: 'bogus', value: 3 }));
					libAssert.ok(tmpGuards.validate({ op: '==', value: 3 }));
					fDone();
				});
			}
		);

		suite
		(
			'Workflow definition validation',
			() =>
			{
				test('rejects a transition to an unknown state', (fDone) =>
				{
					let tmpEngine = new libWorkflowEngine();
					libAssert.throws(() => tmpEngine.defineWorkflow({ Key: 'x', States: [{ Key: 'a', IsInitial: true }], Transitions: [{ From: 'a', To: 'nope' }] }), /unknown state/);
					fDone();
				});

				test('rejects an invalid guard', (fDone) =>
				{
					let tmpEngine = new libWorkflowEngine();
					libAssert.throws(() => tmpEngine.defineWorkflow({ Key: 'x', States: [{ Key: 'a', IsInitial: true }, { Key: 'b' }], Transitions: [{ From: 'a', To: 'b', Guard: { op: 'bogus' } }] }), /invalid guard/);
					fDone();
				});
			}
		);

		suite
		(
			'Lifecycle + guards + gates',
			() =>
			{
				test('open lands in the initial state with an opened + state.enter log', (fDone) =>
				{
					let tmpClock = { t: 1000 };
					let tmpChanges = { c1: { HasTests: false } };
					let tmpEngine = makeEngine(tmpChanges, tmpClock);
					tmpEngine.defineWorkflow(deployWorkflow());
					let tmpState = tmpEngine.open('c1', 'deploy', { ID: 'jan', Entitlements: ['build'] });
					libAssert.deepStrictEqual(tmpState.CurrentStates, ['queued']);
					let tmpTypes = tmpEngine.getTimeline('c1').map((pEvent) => pEvent.Type);
					libAssert.deepStrictEqual(tmpTypes, ['opened', 'state.enter']);
					fDone();
				});

				test('a guard blocks the move until the data is ready', (fDone) =>
				{
					let tmpClock = { t: 1000 };
					let tmpChanges = { c1: { HasTests: false } };
					let tmpEngine = makeEngine(tmpChanges, tmpClock);
					tmpEngine.defineWorkflow(deployWorkflow());
					tmpEngine.open('c1', 'deploy', { ID: 'jan', Entitlements: ['build'] });

					let tmpBlocked = tmpEngine.advance('c1', 'building', { ID: 'jan', Entitlements: ['build'] });
					libAssert.strictEqual(tmpBlocked.ok, false);
					libAssert.match(tmpBlocked.reason, /guard/);

					// the consumer changes its own data, then signals a re-eval
					tmpChanges.c1.HasTests = true;
					tmpClock.t = 1500;
					tmpEngine.reevaluate('c1');

					let tmpReady = tmpEngine.advance('c1', 'building', { ID: 'jan', Entitlements: ['build'] });
					libAssert.strictEqual(tmpReady.ok, true);
					libAssert.deepStrictEqual(tmpEngine.getState('c1').CurrentStates, ['building']);
					fDone();
				});

				test('a missing entitlement blocks the move', (fDone) =>
				{
					let tmpClock = { t: 1000 };
					let tmpChanges = { c1: { HasTests: true } };
					let tmpEngine = makeEngine(tmpChanges, tmpClock);
					tmpEngine.defineWorkflow(deployWorkflow());
					tmpEngine.open('c1', 'deploy', { ID: 'jan', Entitlements: ['build'] });
					let tmpResult = tmpEngine.advance('c1', 'building', { ID: 'pat', Entitlements: ['read'] });
					libAssert.strictEqual(tmpResult.ok, false);
					libAssert.match(tmpResult.reason, /entitlement/);
					fDone();
				});

				test('became-available fires when a guard flips true', (fDone) =>
				{
					let tmpClock = { t: 1000 };
					let tmpChanges = { c1: { HasTests: true, Approved: false, GreenCI: false } };
					let tmpEngine = makeEngine(tmpChanges, tmpClock);
					tmpEngine.defineWorkflow(deployWorkflow());
					tmpEngine.open('c1', 'deploy', { ID: 'jan', Entitlements: ['build'] });
					tmpEngine.advance('c1', 'building', { ID: 'jan', Entitlements: ['build'] }, 1100);
					tmpEngine.advance('c1', 'review', { ID: 'jan', Entitlements: ['build'] }, 1200);

					// deploy exit guarded; not yet satisfied
					let tmpExitsBefore = tmpEngine.getAvailableExits('c1').filter((pExit) => pExit.ToState === 'deployed');
					libAssert.strictEqual(tmpExitsBefore[0].GuardSatisfied, false);

					tmpChanges.c1.Approved = true; tmpChanges.c1.GreenCI = true;
					tmpEngine.reevaluate('c1', 1300);

					let tmpAvailable = tmpEngine.getTimeline('c1').filter((pEvent) => pEvent.Type === 'exit.became-available');
					libAssert.strictEqual(tmpAvailable.length, 1);
					libAssert.strictEqual(tmpAvailable[0].Payload.ToState, 'deployed');
					fDone();
				});

				test('multiple exits, and a terminal state closes the subject', (fDone) =>
				{
					let tmpClock = { t: 1000 };
					let tmpChanges = { c1: { HasTests: true, Approved: true, GreenCI: true } };
					let tmpEngine = makeEngine(tmpChanges, tmpClock);
					tmpEngine.defineWorkflow(deployWorkflow());
					tmpEngine.open('c1', 'deploy', { ID: 'jan', Entitlements: ['build'] }, 1000);
					tmpEngine.advance('c1', 'building', { ID: 'jan', Entitlements: ['build'] }, 1100);
					tmpEngine.advance('c1', 'review', { ID: 'jan', Entitlements: ['build'] }, 1200);

					// from review there are two exits: deployed (guarded) and building (reject)
					let tmpExits = tmpEngine.getAvailableExits('c1').map((pExit) => pExit.ToState).sort();
					libAssert.deepStrictEqual(tmpExits, ['building', 'deployed']);

					let tmpDeploy = tmpEngine.advance('c1', 'deployed', { ID: 'deb', Entitlements: ['deploy'] }, 1300);
					libAssert.strictEqual(tmpDeploy.ok, true);
					libAssert.strictEqual(tmpEngine.getState('c1').Closed, true);
					libAssert.deepStrictEqual(tmpEngine.getAvailableExits('c1'), []);
					fDone();
				});
			}
		);

		suite
		(
			'Agency queries (indexed reads)',
			() =>
			{
				test('whatCanAdvance and whoCanActOn reflect gates + readiness', (fDone) =>
				{
					let tmpClock = { t: 1000 };
					let tmpChanges = { c1: { HasTests: true, Approved: true, GreenCI: true }, c2: { HasTests: true, Approved: false, GreenCI: false } };
					let tmpEngine = makeEngine(tmpChanges, tmpClock);
					tmpEngine.defineWorkflow(deployWorkflow());
					// drive both to review
					['c1', 'c2'].forEach((pID) =>
					{
						tmpEngine.open(pID, 'deploy', { ID: 'jan', Entitlements: ['build'] }, 1000);
						tmpEngine.advance(pID, 'building', { ID: 'jan', Entitlements: ['build'] }, 1100);
						tmpEngine.advance(pID, 'review', { ID: 'jan', Entitlements: ['build'] }, 1200);
					});

					// Both have a deploy-gated exit available (c1 -> deployed is ready, c2 -> building
					// is the ungated reject path), so a deployer can act on both.
					let tmpDeployer = { ID: 'deb', Entitlements: ['deploy'] };
					libAssert.ok(tmpEngine.whatCanAdvance(tmpDeployer).indexOf('c1') >= 0, 'a deployer can advance c1');

					// A builder has no agency at the review stage (both exits require deploy).
					let tmpBuilder = { ID: 'jan', Entitlements: ['build'] };
					libAssert.ok(tmpEngine.whatCanAdvance(tmpBuilder).indexOf('c1') < 0, 'a builder has no agency in review');

					// Readiness is per-exit: c1 can go to deployed, c2 cannot (its guard is false),
					// though c2 can still be rejected back to building.
					let tmpC1 = tmpEngine.whoCanActOn('c1').map((pExit) => pExit.ToState);
					let tmpC2 = tmpEngine.whoCanActOn('c2').map((pExit) => pExit.ToState);
					libAssert.ok(tmpC1.indexOf('deployed') >= 0, 'c1 deploy exit is ready');
					libAssert.ok(tmpC2.indexOf('deployed') < 0, 'c2 deploy exit is not ready (guard false)');
					libAssert.ok(tmpC2.indexOf('building') >= 0, 'c2 can still be rejected to building');
					fDone();
				});
			}
		);

		suite
		(
			'Metrics (folded incrementally)',
			() =>
			{
				test('time-in-state accumulates across transitions', (fDone) =>
				{
					let tmpClock = { t: 0 };
					let tmpChanges = { c1: { HasTests: true } };
					let tmpEngine = makeEngine(tmpChanges, tmpClock);
					tmpEngine.defineWorkflow(deployWorkflow());
					tmpEngine.open('c1', 'deploy', { ID: 'jan', Entitlements: ['build'] }, 0);
					tmpEngine.advance('c1', 'building', { ID: 'jan', Entitlements: ['build'] }, 1000);   // queued: 0..1000
					tmpEngine.advance('c1', 'review', { ID: 'jan', Entitlements: ['build'] }, 4000);      // building: 1000..4000
					let tmpMetrics = tmpEngine.getMetrics('c1');
					libAssert.strictEqual(tmpMetrics.StateTime.queued, 1000);
					libAssert.strictEqual(tmpMetrics.StateTime.building, 3000);
					fDone();
				});

				test('effort, active, and overlap from actor intervals', (fDone) =>
				{
					let tmpClock = { t: 0 };
					let tmpChanges = { c1: { HasTests: true } };
					let tmpEngine = makeEngine(tmpChanges, tmpClock);
					tmpEngine.defineWorkflow(deployWorkflow());
					tmpEngine.open('c1', 'deploy', { ID: 'jan', Entitlements: ['build'] }, 0);
					// jan works 0..5, jill works 1..3 -> effort 5+2=7, active (union) 0..5=5, overlap=2
					tmpEngine.emit('c1', { Type: 'actor.start', Actor: 'jan' }, 0);
					tmpEngine.emit('c1', { Type: 'actor.start', Actor: 'jill' }, 1);
					tmpEngine.emit('c1', { Type: 'actor.stop', Actor: 'jill' }, 3);
					tmpEngine.emit('c1', { Type: 'actor.stop', Actor: 'jan' }, 5);
					let tmpMetrics = tmpEngine.getMetrics('c1');
					libAssert.strictEqual(tmpMetrics.EffortMS, 7);
					libAssert.strictEqual(tmpMetrics.ActiveMS, 5);
					libAssert.strictEqual(tmpMetrics.OverlapMS, 2);
					fDone();
				});
			}
		);

		suite
		(
			'Fable service wiring',
			() =>
			{
				test('registers on a Fable instance and drives a subject from config', (fDone) =>
				{
					const libFable = require('fable');
					let tmpFable = new libFable({ Product: 'WFTest', LogStreams: [{ streamtype: 'console', level: 'fatal' }] });
					tmpFable.serviceManager.addServiceType('Workflow', libFableWorkflow);
					let tmpWorkflow = tmpFable.serviceManager.instantiateServiceProvider('Workflow');

					let tmpChanges = { c1: { HasTests: true } };
					tmpWorkflow.setContextResolver((pID) => ({ Change: tmpChanges[pID] }));
					tmpWorkflow.defineWorkflow(deployWorkflow());
					tmpWorkflow.open('c1', 'deploy', { ID: 'jan', Entitlements: ['build'] });
					let tmpResult = tmpWorkflow.advance('c1', 'building', { ID: 'jan', Entitlements: ['build'] });
					libAssert.strictEqual(tmpResult.ok, true);
					libAssert.deepStrictEqual(tmpWorkflow.getState('c1').CurrentStates, ['building']);
					fDone();
				});
			}
		);
	}
);

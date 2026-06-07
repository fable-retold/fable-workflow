'use strict';

/**
 * fable-workflow example: editorial review.
 *
 * Run with: npm run example
 *
 * The point of this example is that the engine knows nothing about "articles". The
 * workflow is config, the data is an arbitrary object reached through a resolver,
 * and the roles are arbitrary strings. The same engine drives a second, unrelated
 * domain (a hardware RMA) at the bottom with nothing but different config + data.
 */

const libFable = require('fable');
const libFableWorkflow = require('../source/Fable-Workflow.js');

// A stepped clock so the printed durations are deterministic.
let _Clock = { t: 0 };
function at(pMs) { _Clock.t = pMs; return pMs; }

let tmpFable = new libFable({ Product: 'WorkflowExample', LogStreams: [{ streamtype: 'console', level: 'fatal' }] });
tmpFable.serviceManager.addServiceType('Workflow', libFableWorkflow);
let tmpWorkflow = tmpFable.serviceManager.instantiateServiceProvider('Workflow', { Now: () => _Clock.t });

function line() { console.log('-'.repeat(70)); }
function show(pLabel, pValue) { console.log('  ' + pLabel + ': ' + (typeof pValue === 'string' ? pValue : JSON.stringify(pValue))); }

// -- 1. The workflow, entirely in config --------------------------------------
tmpWorkflow.defineWorkflow(
	{
		Key: 'editorial',
		Name: 'Editorial Review',
		States:
		[
			{ Key: 'draft',     Name: 'Draft',      Category: 'design', IsInitial: true },
			{ Key: 'review',    Name: 'In Review',  Category: 'verify' },
			{ Key: 'copyedit',  Name: 'Copy Edit',  Category: 'build' },
			{ Key: 'published', Name: 'Published',  Category: 'done', IsTerminal: true }
		],
		Transitions:
		[
			// readiness guards address into arbitrary article data; gates are role strings
			{ From: 'draft',    To: 'review',    RequiresEntitlement: 'author.submit',  Guard: { address: 'Article.WordCount', op: '>=', value: 500 } },
			{ From: 'review',   To: 'copyedit',  RequiresEntitlement: 'editor.approve', Guard: { all: [ { address: 'Article.Score', op: '>=', value: 3 }, { address: 'Article.Media[].Kind', op: 'includesAny', value: ['image', 'video'] } ] } },
			{ From: 'review',   To: 'draft',     RequiresEntitlement: 'editor.approve' },                       // a second exit: send back
			{ From: 'copyedit', To: 'published', RequiresEntitlement: 'editor.publish', Guard: { address: 'Article.CopyeditDone', op: '==', value: true } }
		]
	});

// -- 2. The arbitrary data model, reached only through a resolver -------------
let _Articles =
{
	'a-42': { WordCount: 320, Score: 0, CopyeditDone: false, Media: [] }
};
tmpWorkflow.setContextResolver((pID) => ({ Article: _Articles[pID] }));

// actors are { ID, Entitlements }
let _Jan = { ID: 'jan',  Entitlements: ['author.submit'] };
let _Ed  = { ID: 'edie', Entitlements: ['editor.approve', 'editor.publish'] };

line();
console.log('EDITORIAL REVIEW (the engine has never heard of an "article")');
line();

// -- 3. Open + try to advance before the data is ready ------------------------
tmpWorkflow.open('a-42', 'editorial', _Jan, at(0));
show('opened in state', tmpWorkflow.getState('a-42').CurrentStates);

let tmpEarly = tmpWorkflow.advance('a-42', 'review', _Jan, at(10 * 60000));
show('submit at 320 words', tmpEarly.ok ? 'allowed' : 'blocked - ' + tmpEarly.reason);

// the author keeps writing; the consumer mutates its own data and signals a re-eval
_Articles['a-42'].WordCount = 900;
tmpWorkflow.reevaluate('a-42', at(45 * 60000));
let tmpSubmit = tmpWorkflow.advance('a-42', 'review', _Jan, at(45 * 60000));
show('submit at 900 words', tmpSubmit.ok ? 'allowed -> ' + tmpSubmit.state.CurrentStates : 'blocked');

// -- 4. The reviewer needs a score AND a figure; a second exit exists too -----
show('exits from review', tmpWorkflow.getAvailableExits('a-42').map((e) => e.ToState + (e.GuardSatisfied ? '(ready)' : '(blocked)')));
let tmpTryApprove = tmpWorkflow.advance('a-42', 'copyedit', _Ed, at(60 * 60000));
show('approve with no score/figure', tmpTryApprove.ok ? 'allowed' : 'blocked - ' + tmpTryApprove.reason);

_Articles['a-42'].Score = 4;
_Articles['a-42'].Media = [{ Kind: 'image' }];
tmpWorkflow.reevaluate('a-42', at(120 * 60000));
let tmpBecame = tmpWorkflow.getTimeline('a-42').filter((e) => e.Type === 'exit.became-available').map((e) => e.Payload.ToState);
show('became available after edits', tmpBecame);
let tmpApprove = tmpWorkflow.advance('a-42', 'copyedit', _Ed, at(120 * 60000));
show('approve now', tmpApprove.ok ? 'allowed -> ' + tmpApprove.state.CurrentStates : 'blocked');

// -- 5. Who can act, and what can the editor advance --------------------------
_Articles['a-42'].CopyeditDone = true;
tmpWorkflow.reevaluate('a-42', at(200 * 60000));
show('who can act on a-42', tmpWorkflow.whoCanActOn('a-42'));
show('what can the editor advance', tmpWorkflow.whatCanAdvance(_Ed));

tmpWorkflow.advance('a-42', 'published', _Ed, at(210 * 60000));
show('final state', tmpWorkflow.getState('a-42'));

// -- 6. The whole timeline + the folded metrics -------------------------------
line();
console.log('TIMELINE');
tmpWorkflow.getTimeline('a-42').forEach((e) =>
{
	console.log('  ' + String(e.At).padStart(8) + 'ms  ' + e.Type + (e.State ? ' [' + e.State + ']' : '') + (e.Actor ? ' by ' + e.Actor : '') + (e.Payload ? ' ' + JSON.stringify(e.Payload) : ''));
});
line();
console.log('METRICS (folded on every event, no replay)');
let tmpMetrics = tmpWorkflow.getMetrics('a-42');
show('elapsed ms', tmpMetrics.ElapsedMS);
show('time in each state (ms)', tmpMetrics.StateTime);

// -- 7. The SAME engine, a different domain, from config alone ----------------
line();
console.log('SAME ENGINE, DIFFERENT DOMAIN: a hardware RMA');
line();
tmpWorkflow.defineWorkflow(
	{
		Key: 'rma',
		Name: 'Hardware RMA',
		States: [ { Key: 'received', IsInitial: true }, { Key: 'diagnosed' }, { Key: 'refunded', IsTerminal: true } ],
		Transitions:
		[
			{ From: 'received',  To: 'diagnosed', RequiresEntitlement: 'tech',    Guard: { address: 'Unit.SerialVerified', op: '==', value: true } },
			{ From: 'diagnosed', To: 'refunded',  RequiresEntitlement: 'finance', Guard: { address: 'Unit.FaultConfirmed', op: '==', value: true } }
		]
	});
let _Units = { 'rma-9': { SerialVerified: true, FaultConfirmed: false } };
tmpWorkflow.setContextResolver((pID) => _Articles[pID] ? { Article: _Articles[pID] } : { Unit: _Units[pID] });
tmpWorkflow.open('rma-9', 'rma', { ID: 'sam', Entitlements: ['tech'] }, at(0));
let tmpDiag = tmpWorkflow.advance('rma-9', 'diagnosed', { ID: 'sam', Entitlements: ['tech'] }, at(1000));
show('rma received -> diagnosed', tmpDiag.ok ? 'allowed' : 'blocked');
show('refund ready?', tmpWorkflow.getAvailableExits('rma-9').map((e) => e.ToState + (e.GuardSatisfied ? '(ready)' : '(blocked - needs fault confirmed)')));
console.log('\nSame engine, same five methods, zero code per domain. It is all config + a resolver.');
line();

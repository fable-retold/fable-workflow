'use strict';

/**
 * Workflow-Engine
 *
 * The pure, data-model-agnostic core. It holds workflow definitions (config), an
 * append-only event log per subject, and two materialized projections folded on
 * every event: a metrics rollup (time in state, effort, active, overlap, stalled)
 * and an eligibility set (the currently-open exits with guard-satisfied + the gate).
 * Guard readiness is precomputed on write, so the agency queries are flat reads.
 *
 * The engine never imports a consumer's schema. It reaches data only through a
 * contextResolver(subjectId) -> object that the consumer supplies; guards address
 * into that object. An actor is { ID, Entitlements: [] }.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const libWorkflowGuards = require('./Workflow-Guards.js');

class WorkflowEngine
{
	/**
	 * @param {object} [pOptions] - { resolveAddress, contextResolver, now }
	 */
	constructor(pOptions)
	{
		let tmpOptions = pOptions || {};
		this._guards = new libWorkflowGuards(tmpOptions.resolveAddress);
		this._now = (typeof tmpOptions.now === 'function') ? tmpOptions.now : () => Date.now();
		this._contextResolver = (typeof tmpOptions.contextResolver === 'function') ? tmpOptions.contextResolver : () => ({});

		this._workflows = {};       // key -> normalized definition
		this._subjects = {};        // subjectId -> record
		this._eventSeq = 0;
		this._agencyIndex = {};     // entitlement (or '*') -> { subjectId: true } with a satisfied exit
	}

	setContextResolver(pFunction) { if (typeof pFunction === 'function') { this._contextResolver = pFunction; } return this; }

	// -- workflow definitions -------------------------------------------------

	defineWorkflow(pDefinition)
	{
		let tmpDefinition = this._normalizeWorkflow(pDefinition);
		this._workflows[tmpDefinition.Key] = tmpDefinition;
		return tmpDefinition;
	}

	getWorkflow(pKey) { return this._workflows[pKey] || null; }

	_normalizeWorkflow(pDefinition)
	{
		if (!pDefinition || !pDefinition.Key) { throw new Error('a workflow definition requires a Key'); }
		let tmpStates = {};
		let tmpInitial = null;
		(pDefinition.States || []).forEach((pState) =>
		{
			if (!pState.Key) { throw new Error('a workflow state requires a Key'); }
			tmpStates[pState.Key] = { Key: pState.Key, Name: pState.Name || pState.Key, IsInitial: !!pState.IsInitial, IsTerminal: !!pState.IsTerminal, Category: pState.Category || null };
			if (pState.IsInitial) { tmpInitial = pState.Key; }
		});
		let tmpStateKeys = Object.keys(tmpStates);
		if (!tmpStateKeys.length) { throw new Error('a workflow requires at least one state'); }
		if (!tmpInitial) { tmpInitial = tmpStateKeys[0]; tmpStates[tmpInitial].IsInitial = true; }

		let tmpTransitions = (pDefinition.Transitions || []).map((pTransition) =>
		{
			if (!tmpStates[pTransition.From]) { throw new Error('transition From references unknown state "' + pTransition.From + '"'); }
			if (!tmpStates[pTransition.To]) { throw new Error('transition To references unknown state "' + pTransition.To + '"'); }
			let tmpGuardError = this._guards.validate(pTransition.Guard);
			if (tmpGuardError) { throw new Error('transition ' + pTransition.From + ' -> ' + pTransition.To + ' has an invalid guard: ' + tmpGuardError); }
			return {
				Key: pTransition.Key || (pTransition.From + '->' + pTransition.To),
				From: pTransition.From,
				To: pTransition.To,
				RequiresEntitlement: pTransition.RequiresEntitlement || null,
				ActorAddress: pTransition.ActorAddress || null,
				Guard: pTransition.Guard || null
			};
		});

		return {
			Key: pDefinition.Key,
			Name: pDefinition.Name || pDefinition.Key,
			AllowParallelStates: !!pDefinition.AllowParallelStates,
			States: tmpStates,
			Initial: tmpInitial,
			Transitions: tmpTransitions
		};
	}

	// -- lifecycle -------------------------------------------------------------

	open(pSubjectId, pWorkflowKey, pActor, pAt)
	{
		let tmpDefinition = this._workflows[pWorkflowKey];
		if (!tmpDefinition) { throw new Error('unknown workflow "' + pWorkflowKey + '"'); }
		if (this._subjects[pSubjectId]) { throw new Error('subject "' + pSubjectId + '" is already open'); }
		let tmpAt = (pAt != null) ? pAt : this._now();

		this._subjects[pSubjectId] =
		{
			SubjectID: pSubjectId,
			WorkflowKey: pWorkflowKey,
			Events: [],
			CurrentStates: [],
			Closed: false,
			Rollup: { OpenedAt: tmpAt, ClosedAt: null, ElapsedMS: 0, ActiveMS: 0, StalledMS: 0, EffortMS: 0, OverlapMS: 0, StateTime: {}, ActorTime: {} },
			Eligibility: [],
			_open: { states: {}, actors: {}, activeCount: 0, activeSince: null }
		};
		this._append(pSubjectId, { Type: 'opened', Actor: _actorID(pActor) }, tmpAt);
		this._enterState(pSubjectId, tmpDefinition.Initial, _actorID(pActor), tmpAt);
		this._recomputeEligibility(pSubjectId, tmpAt);
		return this.getState(pSubjectId);
	}

	/** Low-level append for non-transition events (actor.start/stop, note, prompt, ...). */
	emit(pSubjectId, pEvent, pAt)
	{
		let tmpRecord = this._subjects[pSubjectId];
		if (!tmpRecord) { throw new Error('unknown subject "' + pSubjectId + '"'); }
		let tmpAt = (pAt != null) ? pAt : this._now();
		if (pEvent.Type === 'actor.start') { this._actorStart(pSubjectId, pEvent.Actor, tmpAt); }
		else if (pEvent.Type === 'actor.stop') { this._actorStop(pSubjectId, pEvent.Actor, tmpAt); }
		else { this._append(pSubjectId, pEvent, tmpAt); }
		this._recomputeEligibility(pSubjectId, tmpAt);
		return tmpRecord.Events[tmpRecord.Events.length - 1];
	}

	/**
	 * Attempt a governed transition. Returns { ok, reason?, state? }. Validates the
	 * exit exists, its guard is satisfied (already precomputed), and the actor clears
	 * the gate (entitlement + optional data-derived actor).
	 */
	advance(pSubjectId, pToStateKey, pActor, pAt)
	{
		let tmpRecord = this._subjects[pSubjectId];
		if (!tmpRecord) { return { ok: false, reason: 'unknown subject' }; }
		if (tmpRecord.Closed) { return { ok: false, reason: 'subject is closed' }; }
		let tmpAt = (pAt != null) ? pAt : this._now();
		let tmpActor = pActor || {};
		let tmpEntitlements = tmpActor.Entitlements || [];

		let tmpExit = tmpRecord.Eligibility.find((pExit) => pExit.ToState === pToStateKey);
		if (!tmpExit) { return { ok: false, reason: 'no transition to "' + pToStateKey + '" from the current state' }; }
		if (!tmpExit.GuardSatisfied) { return { ok: false, reason: 'the readiness guard for "' + pToStateKey + '" is not satisfied' }; }
		if (tmpExit.RequiredEntitlement && tmpEntitlements.indexOf(tmpExit.RequiredEntitlement) < 0)
		{
			return { ok: false, reason: 'actor lacks the "' + tmpExit.RequiredEntitlement + '" entitlement' };
		}
		if (tmpExit.ResolvedActor != null && tmpActor.ID !== tmpExit.ResolvedActor)
		{
			return { ok: false, reason: 'only the designated actor may make this move' };
		}

		this._enterState(pSubjectId, pToStateKey, tmpActor.ID || null, tmpAt);
		this._recomputeEligibility(pSubjectId, tmpAt);
		return { ok: true, state: this.getState(pSubjectId) };
	}

	/** Re-fold eligibility after the consumer changes a subject's data. */
	reevaluate(pSubjectId, pAt)
	{
		if (this._subjects[pSubjectId]) { this._recomputeEligibility(pSubjectId, (pAt != null) ? pAt : this._now()); }
	}

	/**
	 * Rebuild a subject from its stored event log, for a server that persists the log
	 * rather than holding the engine in memory. The log is the source of truth; this
	 * replays it to reconstruct the current states and the folded projections, without
	 * appending anything new. After replay, eligibility is recomputed against the current
	 * data (unless the subject is closed) so the agency reads work immediately. Events are
	 * sorted by (At, ID) so an out-of-order fetch still folds correctly.
	 */
	hydrate(pSubjectId, pWorkflowKey, pEvents)
	{
		let tmpDefinition = this._workflows[pWorkflowKey];
		if (!tmpDefinition) { throw new Error('unknown workflow "' + pWorkflowKey + '"'); }
		if (this._subjects[pSubjectId]) { throw new Error('subject "' + pSubjectId + '" is already open'); }

		let tmpEvents = (pEvents || []).slice().sort((pA, pB) => ((pA.At - pB.At) || ((pA.ID || 0) - (pB.ID || 0))));
		let tmpOpenedAt = tmpEvents.length ? tmpEvents[0].At : this._now();

		this._subjects[pSubjectId] =
		{
			SubjectID: pSubjectId,
			WorkflowKey: pWorkflowKey,
			Events: [],
			CurrentStates: [],
			Closed: false,
			Rollup: { OpenedAt: tmpOpenedAt, ClosedAt: null, ElapsedMS: 0, ActiveMS: 0, StalledMS: 0, EffortMS: 0, OverlapMS: 0, StateTime: {}, ActorTime: {} },
			Eligibility: [],
			_open: { states: {}, actors: {}, activeCount: 0, activeSince: null }
		};

		tmpEvents.forEach((pEvent) =>
		{
			this._replayEvent(pSubjectId, pEvent);
			if ((pEvent.ID || 0) > this._eventSeq) { this._eventSeq = pEvent.ID; }
		});

		if (!this._subjects[pSubjectId].Closed) { this._recomputeEligibility(pSubjectId, this._now()); }
		return this.getState(pSubjectId);
	}

	// -- internal folds --------------------------------------------------------

	_append(pSubjectId, pEvent, pAt)
	{
		let tmpRecord = this._subjects[pSubjectId];
		let tmpEvent = Object.assign({ ID: ++this._eventSeq, At: (pAt != null) ? pAt : this._now() }, pEvent);
		tmpRecord.Events.push(tmpEvent);
		return tmpEvent;
	}

	_enterState(pSubjectId, pStateKey, pActorID, pAt)
	{
		let tmpRecord = this._subjects[pSubjectId];
		let tmpDefinition = this._workflows[tmpRecord.WorkflowKey];
		if (!tmpDefinition.AllowParallelStates)
		{
			tmpRecord.CurrentStates.slice().forEach((pState) => this._exitState(pSubjectId, pState, pActorID, pAt));
		}
		if (tmpRecord.CurrentStates.indexOf(pStateKey) < 0) { tmpRecord.CurrentStates.push(pStateKey); }
		tmpRecord._open.states[pStateKey] = pAt;
		this._append(pSubjectId, { Type: 'state.enter', State: pStateKey, Actor: pActorID }, pAt);
		if (tmpDefinition.States[pStateKey].IsTerminal) { this._close(pSubjectId, pActorID, pAt); }
	}

	_exitState(pSubjectId, pStateKey, pActorID, pAt)
	{
		let tmpRecord = this._subjects[pSubjectId];
		let tmpSince = tmpRecord._open.states[pStateKey];
		if (tmpSince != null)
		{
			tmpRecord.Rollup.StateTime[pStateKey] = (tmpRecord.Rollup.StateTime[pStateKey] || 0) + (pAt - tmpSince);
			delete tmpRecord._open.states[pStateKey];
		}
		let tmpIndex = tmpRecord.CurrentStates.indexOf(pStateKey);
		if (tmpIndex >= 0) { tmpRecord.CurrentStates.splice(tmpIndex, 1); }
		this._append(pSubjectId, { Type: 'state.exit', State: pStateKey, Actor: pActorID }, pAt);
	}

	_actorStart(pSubjectId, pActorID, pAt)
	{
		let tmpRecord = this._subjects[pSubjectId];
		if (tmpRecord._open.actors[pActorID] != null) { return; }
		tmpRecord._open.actors[pActorID] = pAt;
		if (tmpRecord._open.activeCount === 0) { tmpRecord._open.activeSince = pAt; }
		tmpRecord._open.activeCount++;
		this._append(pSubjectId, { Type: 'actor.start', Actor: pActorID }, pAt);
	}

	_actorStop(pSubjectId, pActorID, pAt)
	{
		let tmpRecord = this._subjects[pSubjectId];
		let tmpSince = tmpRecord._open.actors[pActorID];
		if (tmpSince == null) { return; }
		let tmpDuration = pAt - tmpSince;
		tmpRecord.Rollup.EffortMS += tmpDuration;
		tmpRecord.Rollup.ActorTime[pActorID] = (tmpRecord.Rollup.ActorTime[pActorID] || 0) + tmpDuration;
		delete tmpRecord._open.actors[pActorID];
		tmpRecord._open.activeCount--;
		if (tmpRecord._open.activeCount === 0 && tmpRecord._open.activeSince != null)
		{
			tmpRecord.Rollup.ActiveMS += (pAt - tmpRecord._open.activeSince);
			tmpRecord._open.activeSince = null;
		}
		tmpRecord.Rollup.OverlapMS = tmpRecord.Rollup.EffortMS - tmpRecord.Rollup.ActiveMS;
		this._append(pSubjectId, { Type: 'actor.stop', Actor: pActorID }, pAt);
	}

	_close(pSubjectId, pActorID, pAt)
	{
		let tmpRecord = this._subjects[pSubjectId];
		if (tmpRecord.Closed) { return; }
		tmpRecord.CurrentStates.slice().forEach((pState) => this._exitState(pSubjectId, pState, pActorID, pAt));
		Object.keys(tmpRecord._open.actors).forEach((pActor) => this._actorStop(pSubjectId, pActor, pAt));
		tmpRecord.Closed = true;
		tmpRecord.Rollup.ClosedAt = pAt;
		tmpRecord.Rollup.ElapsedMS = pAt - tmpRecord.Rollup.OpenedAt;
		tmpRecord.Rollup.StalledMS = Math.max(0, tmpRecord.Rollup.ElapsedMS - tmpRecord.Rollup.ActiveMS);
		tmpRecord.Rollup.OverlapMS = tmpRecord.Rollup.EffortMS - tmpRecord.Rollup.ActiveMS;
		this._append(pSubjectId, { Type: 'closed', Actor: pActorID }, pAt);
		tmpRecord.Eligibility = [];
		this._clearAgency(pSubjectId);
	}

	// Apply one already-recorded event's fold, without appending a new event. This mirrors
	// the accrual the live lifecycle methods do; hydrate() replays the log through it. A
	// round-trip test (build live -> hydrate from the timeline) guards the two against drift.
	_replayEvent(pSubjectId, pEvent)
	{
		let tmpRecord = this._subjects[pSubjectId];
		let tmpAt = pEvent.At;
		switch (pEvent.Type)
		{
			case 'state.enter':
				tmpRecord._open.states[pEvent.State] = tmpAt;
				if (tmpRecord.CurrentStates.indexOf(pEvent.State) < 0) { tmpRecord.CurrentStates.push(pEvent.State); }
				break;
			case 'state.exit':
			{
				let tmpSince = tmpRecord._open.states[pEvent.State];
				if (tmpSince != null)
				{
					tmpRecord.Rollup.StateTime[pEvent.State] = (tmpRecord.Rollup.StateTime[pEvent.State] || 0) + (tmpAt - tmpSince);
					delete tmpRecord._open.states[pEvent.State];
				}
				let tmpIndex = tmpRecord.CurrentStates.indexOf(pEvent.State);
				if (tmpIndex >= 0) { tmpRecord.CurrentStates.splice(tmpIndex, 1); }
				break;
			}
			case 'actor.start':
				if (tmpRecord._open.actors[pEvent.Actor] == null)
				{
					tmpRecord._open.actors[pEvent.Actor] = tmpAt;
					if (tmpRecord._open.activeCount === 0) { tmpRecord._open.activeSince = tmpAt; }
					tmpRecord._open.activeCount++;
				}
				break;
			case 'actor.stop':
			{
				let tmpSince = tmpRecord._open.actors[pEvent.Actor];
				if (tmpSince != null)
				{
					let tmpDuration = tmpAt - tmpSince;
					tmpRecord.Rollup.EffortMS += tmpDuration;
					tmpRecord.Rollup.ActorTime[pEvent.Actor] = (tmpRecord.Rollup.ActorTime[pEvent.Actor] || 0) + tmpDuration;
					delete tmpRecord._open.actors[pEvent.Actor];
					tmpRecord._open.activeCount--;
					if (tmpRecord._open.activeCount === 0 && tmpRecord._open.activeSince != null)
					{
						tmpRecord.Rollup.ActiveMS += (tmpAt - tmpRecord._open.activeSince);
						tmpRecord._open.activeSince = null;
					}
					tmpRecord.Rollup.OverlapMS = tmpRecord.Rollup.EffortMS - tmpRecord.Rollup.ActiveMS;
				}
				break;
			}
			case 'closed':
				tmpRecord.Closed = true;
				tmpRecord.Rollup.ClosedAt = tmpAt;
				tmpRecord.Rollup.ElapsedMS = tmpAt - tmpRecord.Rollup.OpenedAt;
				tmpRecord.Rollup.StalledMS = Math.max(0, tmpRecord.Rollup.ElapsedMS - tmpRecord.Rollup.ActiveMS);
				tmpRecord.Rollup.OverlapMS = tmpRecord.Rollup.EffortMS - tmpRecord.Rollup.ActiveMS;
				break;
			default:
				// opened, exit.became-available, and any custom event carry no fold.
				break;
		}
		tmpRecord.Events.push(pEvent);
	}

	_buildContext(pSubjectId)
	{
		let tmpRecord = this._subjects[pSubjectId];
		let tmpConsumer = this._contextResolver(pSubjectId) || {};
		// Engine-owned namespaces are layered on top so guards can read State / Metrics.
		return Object.assign({}, tmpConsumer,
			{
				State: { Current: tmpRecord.CurrentStates.slice() },
				Metrics: tmpRecord.Rollup
			});
	}

	_recomputeEligibility(pSubjectId, pAt)
	{
		let tmpRecord = this._subjects[pSubjectId];
		if (tmpRecord.Closed) { tmpRecord.Eligibility = []; this._clearAgency(pSubjectId); return; }
		let tmpDefinition = this._workflows[tmpRecord.WorkflowKey];
		let tmpContext = this._buildContext(pSubjectId);

		let tmpPrior = {};
		tmpRecord.Eligibility.forEach((pExit) => { tmpPrior[pExit.Key] = pExit.GuardSatisfied; });

		let tmpNext = [];
		tmpRecord.CurrentStates.forEach((pStateKey) =>
		{
			tmpDefinition.Transitions.filter((pTransition) => pTransition.From === pStateKey).forEach((pTransition) =>
			{
				let tmpSatisfied = this._guards.evaluate(pTransition.Guard, tmpContext);
				let tmpResolvedActor = pTransition.ActorAddress ? this._guards.resolveAddress(tmpContext, pTransition.ActorAddress) : null;
				tmpNext.push(
					{
						Key: pTransition.Key,
						FromState: pTransition.From,
						ToState: pTransition.To,
						GuardSatisfied: !!tmpSatisfied,
						RequiredEntitlement: pTransition.RequiresEntitlement,
						ResolvedActor: (tmpResolvedActor === undefined) ? null : tmpResolvedActor
					});
				if (tmpSatisfied && tmpPrior[pTransition.Key] === false)
				{
					this._append(pSubjectId, { Type: 'exit.became-available', State: pTransition.From, Payload: { ToState: pTransition.To } }, pAt);
				}
			});
		});
		tmpRecord.Eligibility = tmpNext;
		this._reindexAgency(pSubjectId);
	}

	_reindexAgency(pSubjectId)
	{
		this._clearAgency(pSubjectId);
		let tmpRecord = this._subjects[pSubjectId];
		tmpRecord.Eligibility.forEach((pExit) =>
		{
			if (!pExit.GuardSatisfied) { return; }
			let tmpKey = pExit.RequiredEntitlement || '*';
			if (!this._agencyIndex[tmpKey]) { this._agencyIndex[tmpKey] = {}; }
			this._agencyIndex[tmpKey][pSubjectId] = true;
		});
	}

	_clearAgency(pSubjectId)
	{
		Object.keys(this._agencyIndex).forEach((pKey) => { if (this._agencyIndex[pKey]) { delete this._agencyIndex[pKey][pSubjectId]; } });
	}

	// -- reads (the payoff: indexed, no guard evaluation) ----------------------

	getState(pSubjectId)
	{
		let tmpRecord = this._subjects[pSubjectId];
		return tmpRecord ? { SubjectID: pSubjectId, WorkflowKey: tmpRecord.WorkflowKey, CurrentStates: tmpRecord.CurrentStates.slice(), Closed: tmpRecord.Closed } : null;
	}

	getTimeline(pSubjectId) { let tmpRecord = this._subjects[pSubjectId]; return tmpRecord ? tmpRecord.Events.slice() : []; }

	getMetrics(pSubjectId)
	{
		let tmpRecord = this._subjects[pSubjectId];
		if (!tmpRecord) { return null; }
		let tmpMetrics = JSON.parse(JSON.stringify(tmpRecord.Rollup));
		if (!tmpRecord.Closed) { tmpMetrics.ElapsedMS = this._now() - tmpRecord.Rollup.OpenedAt; }
		return tmpMetrics;
	}

	getAvailableExits(pSubjectId) { let tmpRecord = this._subjects[pSubjectId]; return tmpRecord ? tmpRecord.Eligibility.slice() : []; }

	/** Subjects this actor can move forward right now (indexed read; no guard eval). */
	whatCanAdvance(pActor)
	{
		let tmpActor = pActor || {};
		let tmpEntitlements = tmpActor.Entitlements || [];
		let tmpCandidates = {};
		['*'].concat(tmpEntitlements).forEach((pEntitlement) =>
		{
			let tmpMap = this._agencyIndex[pEntitlement];
			if (tmpMap) { Object.keys(tmpMap).forEach((pSubjectId) => { tmpCandidates[pSubjectId] = true; }); }
		});
		return Object.keys(tmpCandidates).filter((pSubjectId) =>
		{
			let tmpRecord = this._subjects[pSubjectId];
			return tmpRecord && tmpRecord.Eligibility.some((pExit) => pExit.GuardSatisfied
				&& (!pExit.RequiredEntitlement || tmpEntitlements.indexOf(pExit.RequiredEntitlement) >= 0)
				&& (pExit.ResolvedActor == null || pExit.ResolvedActor === tmpActor.ID));
		});
	}

	/** Who has agency on this subject at its current stage. */
	whoCanActOn(pSubjectId)
	{
		let tmpRecord = this._subjects[pSubjectId];
		if (!tmpRecord) { return []; }
		return tmpRecord.Eligibility.filter((pExit) => pExit.GuardSatisfied).map((pExit) => (
			{ ToState: pExit.ToState, RequiredEntitlement: pExit.RequiredEntitlement, ResolvedActor: pExit.ResolvedActor }));
	}

	getSubjectIds() { return Object.keys(this._subjects); }
}

function _actorID(pActor) { return (pActor && pActor.ID != null) ? pActor.ID : (pActor != null ? pActor : null); }

module.exports = WorkflowEngine;

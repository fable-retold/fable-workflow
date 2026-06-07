'use strict';

/**
 * Fable Workflow
 *
 * A Fable service provider wrapping the pure WorkflowEngine. Register it on a Fable
 * instance, define workflows from config, give it a context resolver for your data,
 * and drive subjects through their states. The engine is data-model-agnostic: it
 * reaches your data only through the context resolver, so the same engine runs any
 * domain purely from config.
 *
 *   fable.serviceManager.addServiceType('Workflow', require('fable-workflow'));
 *   fable.serviceManager.instantiateServiceProvider('Workflow');
 *   fable.Workflow.defineWorkflow({ Key: 'editorial', States: [...], Transitions: [...] });
 *   fable.Workflow.setContextResolver((pID) => myData[pID]);
 *   fable.Workflow.open('article-1', 'editorial', { ID: 'jan', Entitlements: ['submit'] });
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libWorkflowEngine = require('./Workflow-Engine.js');

class FableWorkflow extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'Workflow';

		this._engine = new libWorkflowEngine(
			{
				resolveAddress: this._buildAddressResolver(),
				contextResolver: (this.options && typeof this.options.ContextResolver === 'function') ? this.options.ContextResolver : null,
				now: (this.options && typeof this.options.Now === 'function') ? this.options.Now : null
			});
	}

	// Address resolution via Manyfest. Prefer the Fable instance's factory; fall back
	// to a standalone Manyfest so the provider also works without a full Fable.
	_buildAddressResolver()
	{
		try
		{
			if (this.fable && typeof this.fable.newManyfest === 'function')
			{
				let tmpManyfest = this.fable.newManyfest();
				return (pContext, pAddress) => tmpManyfest.getValueAtAddress(pContext, pAddress);
			}
		}
		catch (pError) { /* fall through to standalone */ }
		let libManyfest = require('manyfest');
		let tmpManyfestClass = libManyfest.Manyfest || libManyfest;
		let tmpManyfest = new tmpManyfestClass();
		return (pContext, pAddress) => tmpManyfest.getValueAtAddress(pContext, pAddress);
	}

	get engine() { return this._engine; }

	// -- delegated API ---------------------------------------------------------
	setContextResolver(pFunction) { this._engine.setContextResolver(pFunction); return this; }
	defineWorkflow(pDefinition) { return this._engine.defineWorkflow(pDefinition); }
	getWorkflow(pKey) { return this._engine.getWorkflow(pKey); }
	open(pSubjectId, pWorkflowKey, pActor, pAt) { return this._engine.open(pSubjectId, pWorkflowKey, pActor, pAt); }
	emit(pSubjectId, pEvent, pAt) { return this._engine.emit(pSubjectId, pEvent, pAt); }
	advance(pSubjectId, pToState, pActor, pAt) { return this._engine.advance(pSubjectId, pToState, pActor, pAt); }
	reevaluate(pSubjectId, pAt) { return this._engine.reevaluate(pSubjectId, pAt); }
	getState(pSubjectId) { return this._engine.getState(pSubjectId); }
	getTimeline(pSubjectId) { return this._engine.getTimeline(pSubjectId); }
	getMetrics(pSubjectId) { return this._engine.getMetrics(pSubjectId); }
	getAvailableExits(pSubjectId) { return this._engine.getAvailableExits(pSubjectId); }
	whatCanAdvance(pActor) { return this._engine.whatCanAdvance(pActor); }
	whoCanActOn(pSubjectId) { return this._engine.whoCanActOn(pSubjectId); }
}

module.exports = FableWorkflow;
module.exports.WorkflowEngine = libWorkflowEngine;
module.exports.WorkflowGuards = require('./Workflow-Guards.js');

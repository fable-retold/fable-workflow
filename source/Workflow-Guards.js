'use strict';

/**
 * Workflow-Guards
 *
 * A guard is a structured condition tree, not a free-text expression. Leaves are
 * { address, op, value }; branches are { all: [...] }, { any: [...] }, { not: ... }.
 * Addresses are resolved against a consumer-supplied context object (so the engine
 * stays ignorant of the data model), and the tree is evaluated in plain JS. This is
 * robust, declarative, validatable, and its data dependencies (the addresses) are
 * trivially extractable for reactive re-evaluation.
 *
 * A null/undefined guard means "no condition", which is always satisfied.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

// Reduce a Manyfest wildcard result (e.g. an object keyed by 'Media[0].Type') to a
// flat array of values, so collection conditions can be expressed.
function _wildcardValues(pResolved)
{
	if (Array.isArray(pResolved)) { return pResolved; }
	if (pResolved && typeof pResolved === 'object') { return Object.keys(pResolved).map((pKey) => pResolved[pKey]); }
	return (pResolved === undefined || pResolved === null) ? [] : [pResolved];
}

const _OPERATORS =
{
	'==':  (pA, pB) => pA == pB,
	'===': (pA, pB) => pA === pB,
	'!=':  (pA, pB) => pA != pB,
	'>':   (pA, pB) => Number(pA) > Number(pB),
	'>=':  (pA, pB) => Number(pA) >= Number(pB),
	'<':   (pA, pB) => Number(pA) < Number(pB),
	'<=':  (pA, pB) => Number(pA) <= Number(pB),
	'in':  (pA, pB) => Array.isArray(pB) && pB.indexOf(pA) >= 0,
	'nin': (pA, pB) => Array.isArray(pB) && pB.indexOf(pA) < 0,
	'exists': (pA) => (pA !== undefined && pA !== null),
	'empty':  (pA) => (pA === undefined || pA === null || pA === '' || (Array.isArray(pA) && pA.length === 0)),
	'truthy': (pA) => !!pA,
	'falsy':  (pA) => !pA,
	// Collection (wildcard address) reductions:
	'includesAny': (pA, pB) => { let tmpValues = _wildcardValues(pA); return Array.isArray(pB) && tmpValues.some((pValue) => pB.indexOf(pValue) >= 0); },
	'includesAll': (pA, pB) => { let tmpValues = _wildcardValues(pA); return Array.isArray(pB) && pB.every((pValue) => tmpValues.indexOf(pValue) >= 0); },
	'countGte':    (pA, pB) => _wildcardValues(pA).length >= Number(pB)
};

function _defaultResolveAddress()
{
	let libManyfest = require('manyfest');
	let tmpManyfestClass = libManyfest.Manyfest || libManyfest;
	let tmpManyfest = new tmpManyfestClass();
	return (pContext, pAddress) => tmpManyfest.getValueAtAddress(pContext, pAddress);
}

class WorkflowGuards
{
	/**
	 * @param {function} [pResolveAddress] - (context, address) -> value. Defaults to a
	 *   standalone Manyfest resolver.
	 */
	constructor(pResolveAddress)
	{
		this.resolveAddress = (typeof pResolveAddress === 'function') ? pResolveAddress : _defaultResolveAddress();
	}

	/** Evaluate a guard tree against a context. Returns a boolean. */
	evaluate(pGuard, pContext)
	{
		if (pGuard == null) { return true; }
		if (Array.isArray(pGuard.all)) { return pGuard.all.every((pChild) => this.evaluate(pChild, pContext)); }
		if (Array.isArray(pGuard.any)) { return pGuard.any.some((pChild) => this.evaluate(pChild, pContext)); }
		if (pGuard.not) { return !this.evaluate(pGuard.not, pContext); }

		let tmpOperator = _OPERATORS[pGuard.op || 'truthy'];
		if (!tmpOperator) { return false; }
		let tmpResolved = this.resolveAddress(pContext, pGuard.address);
		return !!tmpOperator(tmpResolved, pGuard.value);
	}

	/** The flat list of addresses a guard depends on (drives reactive re-evaluation). */
	dependencies(pGuard, pAccumulator)
	{
		let tmpAccumulator = pAccumulator || [];
		if (pGuard == null) { return tmpAccumulator; }
		if (Array.isArray(pGuard.all)) { pGuard.all.forEach((pChild) => this.dependencies(pChild, tmpAccumulator)); }
		else if (Array.isArray(pGuard.any)) { pGuard.any.forEach((pChild) => this.dependencies(pChild, tmpAccumulator)); }
		else if (pGuard.not) { this.dependencies(pGuard.not, tmpAccumulator); }
		else if (pGuard.address && tmpAccumulator.indexOf(pGuard.address) < 0) { tmpAccumulator.push(pGuard.address); }
		return tmpAccumulator;
	}

	/** Structural validation. Returns null when valid, else an error string. */
	validate(pGuard)
	{
		if (pGuard == null) { return null; }
		if (Array.isArray(pGuard.all)) { return _firstError(pGuard.all, (pChild) => this.validate(pChild)); }
		if (Array.isArray(pGuard.any)) { return _firstError(pGuard.any, (pChild) => this.validate(pChild)); }
		if (pGuard.not) { return this.validate(pGuard.not); }
		if (!pGuard.address) { return 'guard leaf is missing an address'; }
		let tmpOperator = pGuard.op || 'truthy';
		if (!_OPERATORS[tmpOperator]) { return 'unknown guard operator "' + tmpOperator + '"'; }
		return null;
	}
}

function _firstError(pArray, fCheck)
{
	for (let i = 0; i < pArray.length; i++)
	{
		let tmpError = fCheck(pArray[i]);
		if (tmpError) { return tmpError; }
	}
	return null;
}

module.exports = WorkflowGuards;
module.exports.OPERATORS = Object.keys(_OPERATORS);

/*
 * skill-audit-registry.test.js
 *
 * Local unit tests for the SkillAuditRegistryContract.
 * No Fabric network required — uses sinon-stubbed ctx.stub and ctx.clientIdentity
 * the same way anchor-registry's test scaffolding works.
 *
 * Run:
 *   npm install
 *   npm test
 */

'use strict';

const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
chai.use(sinonChai);
const { expect } = chai;

const SkillAuditRegistryContract = require('../lib/skill-audit-registry');

// --------------------------------------------------------------------------
// In-memory mock state — mirrors what ctx.stub.putState / getState do.
// --------------------------------------------------------------------------
function makeCtx(mspId = 'Org1MSP', txId = 'tx-fake-0001') {
    const state = new Map();

    const iteratorFor = (prefix) => {
        const keys = Array.from(state.keys()).filter((k) => k.startsWith(prefix)).sort();
        let i = 0;
        return {
            async next() {
                if (i >= keys.length) return { done: true };
                const k = keys[i++];
                return { done: false, value: { key: k, value: state.get(k) } };
            },
            async close() {},
        };
    };

    const stub = {
        _state: state, // expose for assertions
        async getState(key) {
            return state.get(key) || Buffer.alloc(0);
        },
        async putState(key, value) {
            state.set(key, value);
        },
        async deleteState(key) {
            state.delete(key);
        },
        async getStateByRange(start, _end) {
            // emulate range scan by prefix (good enough for the tests)
            // start is e.g. 'PREFIX::', and the call sites pass '~' as the upper bound.
            return iteratorFor(start);
        },
        getTxID() { return txId; },
        getTxTimestamp() {
            return { seconds: { toNumber: () => Math.floor(Date.now() / 1000) }, nanos: 0 };
        },
        setEvent(_name, _payload) { /* no-op for tests */ },
    };

    return {
        stub,
        clientIdentity: {
            getMSPID() { return mspId; },
        },
    };
}

// --------------------------------------------------------------------------
// Helpers — build a valid envelope
// --------------------------------------------------------------------------
const HASH = (seed) => `sha256:${seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a')}`;

function validEnvelope(overrides = {}) {
    return {
        decisionId: 'sd-test-0001',
        skillId: 'spatial-governance-skill',
        skillVersion: '0.1.1',
        skillManifestHash: HASH('d13c'),

        decisionType: 'INVOKE',
        selectedChaincode: 'anchor-registry',
        selectedFunction: 'ProposeAnchor',
        riskLevel: 'WRITE_GOVERNED',
        requiresConfirmation: true,
        shouldInvoke: true,

        llmProvider: 'parley',
        llmModel: 'gpt-5.1',
        llmCallId: 'mock-1',
        llmFinishReason: 'stop',
        llmLatencyMs: 2825,
        llmUsage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },

        intentHash: HASH('abc1'),
        contextHash: HASH('def2'),
        argumentHash: HASH('1234'),

        schemaValidation: 'PASS',
        policyValidation: 'APPROVED',
        policyReasoning: 'ok',

        submittingOrg: 'Org1MSP',
        gatewayId: 'org1-gateway',

        timestamp: '2026-05-18T08:30:22.793Z',

        ...overrides,
    };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------
describe('SkillAuditRegistryContract', () => {
    let contract;

    beforeEach(() => {
        contract = new SkillAuditRegistryContract();
    });

    // -- InitLedger ------------------------------------------------------
    describe('InitLedger', () => {
        it('writes an init event and returns success', async () => {
            const ctx = makeCtx();
            const res = JSON.parse(await contract.InitLedger(ctx));
            expect(res.success).to.equal(true);
            // one event key written
            const eventKeys = Array.from(ctx.stub._state.keys()).filter((k) => k.startsWith('SKILL_EVENT::'));
            expect(eventKeys.length).to.equal(1);
        });
    });

    // -- RecordSkillDecision: validation --------------------------------
    describe('RecordSkillDecision — validation', () => {
        it('rejects an envelope missing required fields', async () => {
            const ctx = makeCtx();
            const env = validEnvelope();
            delete env.skillManifestHash;
            try {
                await contract.RecordSkillDecision(ctx, JSON.stringify(env));
                throw new Error('expected to throw');
            } catch (e) {
                expect(e.message).to.match(/skillManifestHash/);
            }
        });

        it('rejects an envelope with bad hash format', async () => {
            const ctx = makeCtx();
            const env = validEnvelope({ intentHash: 'not-a-hash' });
            await expect(contract.RecordSkillDecision(ctx, JSON.stringify(env)))
                .to.be.rejectedWith(/intentHash/);
        }).timeout(2000);

        it('rejects unknown decisionType', async () => {
            const ctx = makeCtx();
            const env = validEnvelope({ decisionType: 'DESTROY' });
            try {
                await contract.RecordSkillDecision(ctx, JSON.stringify(env));
                throw new Error('expected to throw');
            } catch (e) {
                expect(e.message).to.match(/decisionType/);
            }
        });

        it('rejects unknown submittingOrg', async () => {
            const ctx = makeCtx('Org1MSP');
            const env = validEnvelope({ submittingOrg: 'Org3MSP' });
            try {
                await contract.RecordSkillDecision(ctx, JSON.stringify(env));
                throw new Error('expected to throw');
            } catch (e) {
                expect(e.message).to.match(/submittingOrg/);
            }
        });

        it('rejects cross-org submission (caller MSP != submittingOrg)', async () => {
            const ctx = makeCtx('Org2MSP');                     // caller is Org2
            const env = validEnvelope({ submittingOrg: 'Org1MSP' }); // envelope claims Org1
            try {
                await contract.RecordSkillDecision(ctx, JSON.stringify(env));
                throw new Error('expected to throw');
            } catch (e) {
                expect(e.message).to.match(/does not match caller MSP/);
            }
        });

        it('rejects envelope containing what looks like a private key', async () => {
            const ctx = makeCtx();
            const env = validEnvelope({
                policyReasoning: '-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----',
            });
            try {
                await contract.RecordSkillDecision(ctx, JSON.stringify(env));
                throw new Error('expected to throw');
            } catch (e) {
                expect(e.message).to.match(/private key/);
            }
        });

        it('rejects envelope containing what looks like an API key', async () => {
            const ctx = makeCtx();
            const env = validEnvelope({
                policyReasoning: 'leaked sk-abcdefghijklmnopqrstuvwxyz123456',
            });
            try {
                await contract.RecordSkillDecision(ctx, JSON.stringify(env));
                throw new Error('expected to throw');
            } catch (e) {
                expect(e.message).to.match(/API key/);
            }
        });
    });

    // -- RecordSkillDecision: happy path --------------------------------
    describe('RecordSkillDecision — happy path', () => {
        it('records an INVOKE decision and sets state=RECORDED', async () => {
            const ctx = makeCtx();
            const env = validEnvelope();
            const res = JSON.parse(await contract.RecordSkillDecision(ctx, JSON.stringify(env)));

            expect(res.success).to.equal(true);
            expect(res.decision_id).to.equal(env.decisionId);
            expect(res.state).to.equal('RECORDED');
            expect(res.tx_id).to.equal('tx-fake-0001');
            expect(res.event_id).to.match(/^tx-fake-0001:\d+$/);

            // record persisted
            const stored = JSON.parse((await ctx.stub.getState(`SKILL_DECISION::${env.decisionId}`)).toString());
            expect(stored.decisionId).to.equal(env.decisionId);
            expect(stored.linkedAnchorTxId).to.equal(null);
            expect(stored.callerMsp).to.equal('Org1MSP');

            // event persisted
            const eventKeys = Array.from(ctx.stub._state.keys()).filter((k) => k.startsWith('SKILL_EVENT::'));
            expect(eventKeys.length).to.equal(1);
            const evt = JSON.parse(ctx.stub._state.get(eventKeys[0]).toString());
            expect(evt.type).to.equal('SKILL_DECISION_RECORDED');
            expect(evt.decisionId).to.equal(env.decisionId);
        });

        it('records a REJECT decision with state=RECORDED_REJECT (terminal)', async () => {
            const ctx = makeCtx();
            const env = validEnvelope({
                decisionId: 'sd-reject-0001',
                decisionType: 'REJECT',
                selectedFunction: '',
                shouldInvoke: false,
                riskLevel: 'FORBIDDEN',
                requiresConfirmation: false,
            });
            const res = JSON.parse(await contract.RecordSkillDecision(ctx, JSON.stringify(env)));
            expect(res.state).to.equal('RECORDED_REJECT');
        });

        it('rejects duplicate decisionId (replay protection)', async () => {
            const ctx = makeCtx();
            const env = validEnvelope();
            await contract.RecordSkillDecision(ctx, JSON.stringify(env));
            try {
                await contract.RecordSkillDecision(ctx, JSON.stringify(env));
                throw new Error('expected to throw');
            } catch (e) {
                expect(e.message).to.match(/already recorded/);
            }
        });
    });

    // -- LinkAnchorTx ----------------------------------------------------
    describe('LinkAnchorTx', () => {
        it('attaches an anchorTxId + finalState to a recorded INVOKE decision', async () => {
            const ctx = makeCtx();
            const env = validEnvelope();
            await contract.RecordSkillDecision(ctx, JSON.stringify(env));

            const res = JSON.parse(await contract.LinkAnchorTx(
                ctx,
                env.decisionId,
                'anchor-tx-abc123',
                'PROPOSED',
                'TAG_017'
            ));
            expect(res.success).to.equal(true);
            expect(res.state).to.equal('LINKED');
            expect(res.linked_anchor_tx_id).to.equal('anchor-tx-abc123');

            const stored = JSON.parse((await ctx.stub.getState(`SKILL_DECISION::${env.decisionId}`)).toString());
            expect(stored.state).to.equal('LINKED');
            expect(stored.linkedAnchorTxId).to.equal('anchor-tx-abc123');
            expect(stored.finalState).to.equal('PROPOSED');

            // index by asset
            const indexRaw = await ctx.stub.getState('SKILL_DECISION_BY_ANCHOR::TAG_017');
            expect(JSON.parse(indexRaw.toString())).to.deep.equal([env.decisionId]);
        });

        it('is idempotent: re-linking the same tx returns success', async () => {
            const ctx = makeCtx();
            const env = validEnvelope();
            await contract.RecordSkillDecision(ctx, JSON.stringify(env));
            await contract.LinkAnchorTx(ctx, env.decisionId, 'tx-a', 'PROPOSED', 'TAG_017');
            const res = JSON.parse(await contract.LinkAnchorTx(ctx, env.decisionId, 'tx-a', 'PROPOSED', 'TAG_017'));
            expect(res.success).to.equal(true);
            expect(res.note).to.match(/idempotent/);
        });

        it('rejects re-linking with a contradicting anchorTxId', async () => {
            const ctx = makeCtx();
            const env = validEnvelope();
            await contract.RecordSkillDecision(ctx, JSON.stringify(env));
            await contract.LinkAnchorTx(ctx, env.decisionId, 'tx-a', 'PROPOSED', 'TAG_017');
            try {
                await contract.LinkAnchorTx(ctx, env.decisionId, 'tx-b', 'PROPOSED', 'TAG_017');
                throw new Error('expected to throw');
            } catch (e) {
                expect(e.message).to.match(/already linked/);
            }
        });

        it('rejects linking a REJECT decision (no anchor tx expected)', async () => {
            const ctx = makeCtx();
            const env = validEnvelope({
                decisionId: 'sd-reject-link',
                decisionType: 'REJECT',
                selectedFunction: '',
                shouldInvoke: false,
                riskLevel: 'FORBIDDEN',
                requiresConfirmation: false,
            });
            await contract.RecordSkillDecision(ctx, JSON.stringify(env));
            try {
                await contract.LinkAnchorTx(ctx, env.decisionId, 'tx-a', 'PROPOSED', 'TAG_017');
                throw new Error('expected to throw');
            } catch (e) {
                expect(e.message).to.match(/REJECT/);
            }
        });

        it('rejects linking an unknown decisionId', async () => {
            const ctx = makeCtx();
            try {
                await contract.LinkAnchorTx(ctx, 'sd-missing', 'tx-a', 'PROPOSED', 'TAG_017');
                throw new Error('expected to throw');
            } catch (e) {
                expect(e.message).to.match(/not found/);
            }
        });
    });

    // -- Reads -----------------------------------------------------------
    describe('Reads', () => {
        it('QuerySkillDecision returns the stored record', async () => {
            const ctx = makeCtx();
            const env = validEnvelope();
            await contract.RecordSkillDecision(ctx, JSON.stringify(env));
            const got = JSON.parse(await contract.QuerySkillDecision(ctx, env.decisionId));
            expect(got.decisionId).to.equal(env.decisionId);
            expect(got.skillManifestHash).to.equal(env.skillManifestHash);
        });

        it('QuerySkillDecision throws for missing decisionId', async () => {
            const ctx = makeCtx();
            try {
                await contract.QuerySkillDecision(ctx, 'sd-missing');
                throw new Error('expected to throw');
            } catch (e) {
                expect(e.message).to.match(/not found/);
            }
        });

        it('ListDecisionsByAnchor returns linked decisionIds in order', async () => {
            const ctx = makeCtx();
            const ids = ['sd-1', 'sd-2', 'sd-3'];
            for (const id of ids) {
                const env = validEnvelope({ decisionId: id });
                await contract.RecordSkillDecision(ctx, JSON.stringify(env));
                await contract.LinkAnchorTx(ctx, id, `tx-${id}`, 'PROPOSED', 'TAG_017');
            }
            const got = JSON.parse(await contract.ListDecisionsByAnchor(ctx, 'TAG_017'));
            expect(got.decisionIds).to.deep.equal(ids);
        });

        it('ListDecisionsByAnchor returns empty list for unknown asset', async () => {
            const ctx = makeCtx();
            const got = JSON.parse(await contract.ListDecisionsByAnchor(ctx, 'TAG_UNKNOWN'));
            expect(got.decisionIds).to.deep.equal([]);
        });

        it('ReplayDecision returns decision + all matching events', async () => {
            const ctx = makeCtx();
            const env = validEnvelope();
            await contract.RecordSkillDecision(ctx, JSON.stringify(env));
            await contract.LinkAnchorTx(ctx, env.decisionId, 'tx-anchor-1', 'PROPOSED', 'TAG_017');

            const got = JSON.parse(await contract.ReplayDecision(ctx, env.decisionId));
            expect(got.decisionId).to.equal(env.decisionId);
            expect(got.decision.state).to.equal('LINKED');
            expect(got.decision.linkedAnchorTxId).to.equal('tx-anchor-1');
            expect(got.events.length).to.equal(2); // RECORDED + LINKED
            expect(got.events.map((e) => e.type)).to.deep.equal(['SKILL_DECISION_RECORDED', 'SKILL_DECISION_LINKED']);
            expect(got.replayable).to.equal(true);
        });

        it('ReplayDecision: replayable=true requires all hash fields valid', async () => {
            const ctx = makeCtx();
            const env = validEnvelope();
            await contract.RecordSkillDecision(ctx, JSON.stringify(env));
            const got = JSON.parse(await contract.ReplayDecision(ctx, env.decisionId));
            expect(got.replayable).to.equal(true);
        });

        it('GetAuditStats aggregates by state, decisionType, function, provider', async () => {
            const ctx = makeCtx();
            await contract.RecordSkillDecision(ctx, JSON.stringify(validEnvelope({ decisionId: 'sd-a', decisionType: 'INVOKE', selectedFunction: 'ProposeAnchor' })));
            await contract.RecordSkillDecision(ctx, JSON.stringify(validEnvelope({ decisionId: 'sd-b', decisionType: 'INVOKE', selectedFunction: 'EndorseClaim' })));
            await contract.RecordSkillDecision(ctx, JSON.stringify(validEnvelope({
                decisionId: 'sd-c',
                decisionType: 'REJECT',
                selectedFunction: '',
                shouldInvoke: false,
                riskLevel: 'FORBIDDEN',
                requiresConfirmation: false,
            })));

            const stats = JSON.parse(await contract.GetAuditStats(ctx));
            expect(stats.total).to.equal(3);
            expect(stats.byDecisionType).to.deep.equal({ INVOKE: 2, REJECT: 1 });
            expect(stats.byState).to.deep.equal({ RECORDED: 2, RECORDED_REJECT: 1 });
            expect(stats.bySelectedFunction).to.deep.equal({ ProposeAnchor: 1, EndorseClaim: 1 });
            expect(stats.byProvider).to.deep.equal({ parley: 3 });
        });
    });

    // -- Caller-identity enforcement -------------------------------------
    describe('Identity enforcement', () => {
        it('rejects record/link calls from an unknown MSP', async () => {
            const ctx = makeCtx('Org3MSP');
            try {
                await contract.RecordSkillDecision(ctx, JSON.stringify(validEnvelope()));
                throw new Error('expected to throw');
            } catch (e) {
                expect(e.message).to.match(/Invalid MSP/);
            }
        });
    });
});

// Promise rejection helper for chai (no chai-as-promised dependency).
chai.Assertion.addMethod('rejectedWith', function (re) {
    const promise = this._obj;
    return promise.then(
        () => { throw new Error('expected promise to reject'); },
        (e) => { expect(e.message).to.match(re); }
    );
});

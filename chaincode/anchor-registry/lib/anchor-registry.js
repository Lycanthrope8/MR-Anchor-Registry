/*
 * ==============================================================================
 * anchor-registry.js - MR Anchor Registry Chaincode
 * DUAL ENDORSEMENT MODEL - Both Org1 AND Org2 must explicitly endorse
 * ==============================================================================
 * 
 * PATCH: Removed global EVENT_COUNTER key to eliminate MVCC_READ_CONFLICT.
 * Event IDs now use ctx.stub.getTxID() with an in-memory per-tx suffix.
 * Event records are keyed by TxID, not a counter — zero shared-key writes.
 * Governance is UNCHANGED: BOTH Org1 AND Org2 must endorse.
 * 
 * WORKFLOW (Anchors):
 * 1. Unity/Device proposes anchor    -> PROPOSED (no endorsements yet)
 * 2. Org1 Admin clicks Endorse       -> endorsements.Org1MSP = true
 * 3. Org2 Admin clicks Endorse       -> endorsements.Org2MSP = true
 * 4. When BOTH are true              -> ACTIVE
 * 
 * CLAIM STATES:
 * - PROPOSED: Initial claim, waiting for both org endorsements
 * - ENDORSED_ORG1: Only Org1 has endorsed, waiting for Org2
 * - ENDORSED_ORG2: Only Org2 has endorsed, waiting for Org1
 * - ACTIVE: Both organizations have endorsed
 * - REJECTED: Claim rejected by either organization
 * - REVOKE_PENDING: Revocation initiated, awaiting other org
 * - REVOKED: Anchor revoked and deleted
 *
 * EXTENSION: Governed Object Annotations (v2.1 — Multi-Card)
 * - ADVISORY tier: auto-approve, 0 endorsements
 * - GOVERNED tier: dual endorsement required (same as anchors)
 * - Annotations bind to active governed anchors via anchorClaimId
 * - ONE annotation per (assetId, intentType) pair
 * - Multiple intent types per asset → multiple cards
 * - Valid intent types: ASK_ANCHOR, ACTION_SUGGEST
 * - Content text stored on-chain (max 280 characters)
 * ==============================================================================
 */

'use strict';

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

// State Constants - Anchors
const STATE_PROPOSED = 'PROPOSED';
const STATE_ENDORSED_ORG1 = 'ENDORSED_ORG1';
const STATE_ENDORSED_ORG2 = 'ENDORSED_ORG2';
const STATE_ACTIVE = 'ACTIVE';
const STATE_REJECTED = 'REJECTED';
const STATE_REVOKE_PENDING = 'REVOKE_PENDING';
const STATE_REVOKED = 'REVOKED';

// State Constants - Annotations
const ANN_STATE_PROPOSED = 'ANN_PROPOSED';
const ANN_STATE_ENDORSED_ORG1 = 'ANN_ENDORSED_ORG1';
const ANN_STATE_ENDORSED_ORG2 = 'ANN_ENDORSED_ORG2';
const ANN_STATE_ACTIVE = 'ANN_ACTIVE';
const ANN_STATE_REJECTED = 'ANN_REJECTED';
const ANN_STATE_REVOKED = 'ANN_REVOKED';

// Annotation Tiers
const ANN_TIER_ADVISORY = 'ADVISORY';
const ANN_TIER_GOVERNED = 'GOVERNED';
const VALID_ANN_TIERS = [ANN_TIER_ADVISORY, ANN_TIER_GOVERNED];

// Intent Types (v2.1 multi-card)
const INTENT_ASK_ANCHOR = 'ASK_ANCHOR';
const INTENT_ACTION_SUGGEST = 'ACTION_SUGGEST';
const VALID_INTENT_TYPES = [INTENT_ASK_ANCHOR, INTENT_ACTION_SUGGEST];

// Annotation Content Limit (characters)
const ANN_MAX_CONTENT_LENGTH = 280;

// Key Prefixes - Anchors
const PREFIX_CLAIM = 'CLAIM::';
const PREFIX_ANCHOR_ACTIVE = 'ANCHOR_ACTIVE::';
const PREFIX_EVENT = 'EVENT::';
const PREFIX_REVOKE_REQUEST = 'REVOKE_REQUEST::';

// Key Prefixes - Annotations (v2.1: keys are now assetId:intentType)
const PREFIX_ANNOTATION = 'ANNOTATION::';
const PREFIX_ANNOTATION_ACTIVE = 'ANN_ACTIVE::';

// Valid Organizations
const VALID_MSPS = ['Org1MSP', 'Org2MSP'];

class AnchorRegistryContract extends Contract {

    // ==========================================================================
    // INITIALIZATION
    // ==========================================================================

    async InitLedger(ctx) {
        console.log('============= START : Initialize Ledger ===========');
        console.log('Dual Endorsement Model - Both Org1 AND Org2 must endorse');
        console.log('Event IDs use TxID (no global counter)');
        console.log('Annotation support: ADVISORY (auto-approve) + GOVERNED (dual endorse)');
        console.log('Multi-card model: one annotation per (assetId, intentType)');
        
        const txTimestamp = ctx.stub.getTxTimestamp();
        const timestamp = new Date(txTimestamp.seconds.toNumber() * 1000).toISOString();
        
        const initEvent = {
            type: 'LEDGER_INITIALIZED',
            timestamp: timestamp,
            initiator: ctx.clientIdentity.getMSPID(),
            model: 'dual-endorsement',
            requiredEndorsers: ['Org1MSP', 'Org2MSP'],
            annotationTiers: ['ADVISORY', 'GOVERNED'],
            intentTypes: VALID_INTENT_TYPES,
            annotationMaxContentLength: ANN_MAX_CONTENT_LENGTH
        };
        
        const eventId = this._generateEventId(ctx);
        await ctx.stub.putState(`${PREFIX_EVENT}${eventId}`, Buffer.from(JSON.stringify(initEvent)));
        
        console.log('============= END : Initialize Ledger ===========');
        return JSON.stringify({ success: true, message: 'Ledger initialized with dual endorsement model and multi-card annotation support' });
    }

    // ==========================================================================
    // CLAIM LIFECYCLE - PROPOSE
    // ==========================================================================

    async ProposeAnchor(ctx, assetId, poseSiteJson, qualityMetricsJson) {
        console.log(`============= START : ProposeAnchor for ${assetId} ===========`);
        
        const signingMspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(signingMspId);
        
        const poseSite = JSON.parse(poseSiteJson);
        const qualityMetrics = JSON.parse(qualityMetricsJson);
        
        const existingAnchorKey = `${PREFIX_ANCHOR_ACTIVE}${assetId}`;
        const existingAnchor = await ctx.stub.getState(existingAnchorKey);
        if (existingAnchor && existingAnchor.length > 0) {
            throw new Error(`Active anchor already exists for asset ${assetId}`);
        }
        
        const existingClaimKey = `${PREFIX_CLAIM}${assetId}`;
        const existingClaim = await ctx.stub.getState(existingClaimKey);
        if (existingClaim && existingClaim.length > 0) {
            const claim = JSON.parse(existingClaim.toString());
            if (claim.state === STATE_PROPOSED || 
                claim.state === STATE_ENDORSED_ORG1 || 
                claim.state === STATE_ENDORSED_ORG2 ||
                claim.state === STATE_REVOKE_PENDING) {
                throw new Error(`Pending claim already exists for asset ${assetId} (state: ${claim.state})`);
            }
        }
        
        const claimId = this._generateClaimId(assetId, signingMspId);
        const timestamp = new Date().toISOString();
        
        const payloadHash = this._hashPayload({
            assetId,
            poseSite,
            qualityMetrics,
            timestamp
        });
        
        const claim = {
            claimId,
            assetId,
            state: STATE_PROPOSED,
            poseSite,
            qualityMetrics,
            payloadHash,
            proposedViaOrg: signingMspId,
            proposedAt: timestamp,
            endorsements: {
                Org1MSP: false,
                Org2MSP: false
            },
            endorsedOrg1At: null,
            endorsedOrg2At: null,
            activatedAt: null,
            rejections: [],
            history: [{
                action: 'PROPOSED',
                by: signingMspId,
                at: timestamp,
                note: 'Awaiting endorsement from BOTH Org1 AND Org2'
            }]
        };
        
        await ctx.stub.putState(existingClaimKey, Buffer.from(JSON.stringify(claim)));
        
        const eventId = this._emitEvent(ctx, 'CLAIM_PROPOSED', {
            claimId,
            assetId,
            proposedViaOrg: signingMspId,
            state: STATE_PROPOSED,
            requiredEndorsements: ['Org1MSP', 'Org2MSP']
        });
        
        console.log(`============= END : ProposeAnchor - claimId: ${claimId} ===========`);
        
        return JSON.stringify({
            success: true,
            claim_id: claimId,
            state: STATE_PROPOSED,
            proposed_via_org: signingMspId,
            payload_hash: payloadHash,
            requires_endorsement_from: ['Org1MSP', 'Org2MSP'],
            event_id: eventId
        });
    }

    // ==========================================================================
    // CLAIM LIFECYCLE - ENDORSE (Dual Endorsement)
    // ==========================================================================

    async EndorseClaim(ctx, assetId) {
        console.log(`============= START : EndorseClaim for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const claimData = await ctx.stub.getState(claimKey);
        if (!claimData || claimData.length === 0) {
            throw new Error(`No claim found for asset ${assetId}`);
        }
        
        const claim = JSON.parse(claimData.toString());
        
        const validStates = [STATE_PROPOSED, STATE_ENDORSED_ORG1, STATE_ENDORSED_ORG2];
        if (!validStates.includes(claim.state)) {
            throw new Error(`Claim is in state ${claim.state}, cannot endorse. Valid states: ${validStates.join(', ')}`);
        }
        
        if (claim.endorsements[mspId] === true) {
            throw new Error(`${mspId} has already endorsed this claim`);
        }
        
        const timestamp = new Date().toISOString();
        
        claim.endorsements[mspId] = true;
        
        if (mspId === 'Org1MSP') {
            claim.endorsedOrg1At = timestamp;
        } else {
            claim.endorsedOrg2At = timestamp;
        }
        
        claim.history.push({
            action: 'ENDORSED',
            by: mspId,
            at: timestamp
        });
        
        let eventType;
        let eventData;
        
        if (claim.endorsements.Org1MSP && claim.endorsements.Org2MSP) {
            claim.state = STATE_ACTIVE;
            claim.activatedAt = timestamp;
            
            claim.history.push({
                action: 'ACTIVATED',
                by: 'SYSTEM',
                at: timestamp,
                note: 'Both Org1 and Org2 have endorsed'
            });
            
            const anchorKey = `${PREFIX_ANCHOR_ACTIVE}${assetId}`;
            const activeAnchor = {
                assetId,
                claimId: claim.claimId,
                poseSite: claim.poseSite,
                qualityMetrics: claim.qualityMetrics,
                proposedViaOrg: claim.proposedViaOrg,
                endorsedBy: ['Org1MSP', 'Org2MSP'],
                activatedAt: timestamp
            };
            await ctx.stub.putState(anchorKey, Buffer.from(JSON.stringify(activeAnchor)));
            
            eventType = 'CLAIM_ACTIVATED';
            eventData = {
                claimId: claim.claimId,
                assetId,
                finalEndorser: mspId,
                endorsedBy: ['Org1MSP', 'Org2MSP'],
                activatedAt: timestamp
            };
            
            console.log(`Claim ACTIVATED! Both orgs endorsed.`);
            
        } else {
            if (mspId === 'Org1MSP') {
                claim.state = STATE_ENDORSED_ORG1;
                eventType = 'CLAIM_ENDORSED_ORG1';
            } else {
                claim.state = STATE_ENDORSED_ORG2;
                eventType = 'CLAIM_ENDORSED_ORG2';
            }
            
            const pendingOrg = mspId === 'Org1MSP' ? 'Org2MSP' : 'Org1MSP';
            eventData = {
                claimId: claim.claimId,
                assetId,
                endorsedBy: mspId,
                pendingEndorser: pendingOrg,
                endorsements: claim.endorsements
            };
            
            console.log(`${mspId} endorsed. Waiting for ${pendingOrg}...`);
        }
        
        await ctx.stub.putState(claimKey, Buffer.from(JSON.stringify(claim)));
        
        const eventId = this._emitEvent(ctx, eventType, eventData);
        
        console.log(`============= END : EndorseClaim ===========`);
        
        return JSON.stringify({
            success: true,
            claim_id: claim.claimId,
            state: claim.state,
            endorsed_by: mspId,
            endorsements: claim.endorsements,
            is_fully_endorsed: claim.endorsements.Org1MSP && claim.endorsements.Org2MSP,
            event_id: eventId
        });
    }

    // ==========================================================================
    // CLAIM LIFECYCLE - REJECT
    // ==========================================================================

    async RejectClaim(ctx, assetId, reason) {
        console.log(`============= START : RejectClaim for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const claimData = await ctx.stub.getState(claimKey);
        if (!claimData || claimData.length === 0) {
            throw new Error(`No claim found for asset ${assetId}`);
        }
        
        const claim = JSON.parse(claimData.toString());
        
        const validStates = [STATE_PROPOSED, STATE_ENDORSED_ORG1, STATE_ENDORSED_ORG2];
        if (!validStates.includes(claim.state)) {
            throw new Error(`Claim is in state ${claim.state}, cannot reject`);
        }
        
        const timestamp = new Date().toISOString();
        
        claim.state = STATE_REJECTED;
        claim.rejectedBy = mspId;
        claim.rejectedAt = timestamp;
        claim.rejectionReason = reason || 'No reason provided';
        claim.rejections.push({
            by: mspId,
            at: timestamp,
            reason: reason || 'No reason provided'
        });
        claim.history.push({
            action: 'REJECTED',
            by: mspId,
            at: timestamp,
            reason: reason || 'No reason provided'
        });
        
        await ctx.stub.putState(claimKey, Buffer.from(JSON.stringify(claim)));
        
        const eventId = this._emitEvent(ctx, 'CLAIM_REJECTED', {
            claimId: claim.claimId,
            assetId,
            rejectedBy: mspId,
            reason: reason || 'No reason provided'
        });
        
        console.log(`============= END : RejectClaim ===========`);
        
        return JSON.stringify({
            success: true,
            claim_id: claim.claimId,
            state: STATE_REJECTED,
            rejected_by: mspId,
            reason: reason || 'No reason provided',
            event_id: eventId
        });
    }

    // ==========================================================================
    // REVOCATION LIFECYCLE
    // ==========================================================================

    async RevokeAnchor(ctx, assetId, reason) {
        console.log(`============= START : RevokeAnchor for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const claimData = await ctx.stub.getState(claimKey);
        if (!claimData || claimData.length === 0) {
            throw new Error(`No claim found for asset ${assetId}`);
        }
        
        const claim = JSON.parse(claimData.toString());
        
        if (claim.state !== STATE_ACTIVE) {
            throw new Error(`Claim must be ACTIVE to revoke. Current state: ${claim.state}`);
        }
        
        const timestamp = new Date().toISOString();
        const requiredEndorser = this._getOtherOrg(mspId);
        
        claim.state = STATE_REVOKE_PENDING;
        claim.revokeInitiatedBy = mspId;
        claim.revokeInitiatedAt = timestamp;
        claim.revokeReason = reason || 'No reason provided';
        claim.revokeRequiredEndorser = requiredEndorser;
        claim.history.push({
            action: 'REVOKE_INITIATED',
            by: mspId,
            at: timestamp,
            reason: reason || 'No reason provided',
            requiredEndorser
        });
        
        await ctx.stub.putState(claimKey, Buffer.from(JSON.stringify(claim)));
        
        const revokeKey = `${PREFIX_REVOKE_REQUEST}${assetId}`;
        const revokeRequest = {
            assetId,
            claimId: claim.claimId,
            initiatedBy: mspId,
            initiatedAt: timestamp,
            reason: reason || 'No reason provided',
            requiredEndorser,
            status: 'PENDING'
        };
        await ctx.stub.putState(revokeKey, Buffer.from(JSON.stringify(revokeRequest)));
        
        const eventId = this._emitEvent(ctx, 'REVOKE_INITIATED', {
            claimId: claim.claimId,
            assetId,
            initiatedBy: mspId,
            requiredEndorser,
            reason: reason || 'No reason provided'
        });
        
        console.log(`============= END : RevokeAnchor ===========`);
        
        return JSON.stringify({
            success: true,
            claim_id: claim.claimId,
            state: STATE_REVOKE_PENDING,
            initiated_by: mspId,
            required_endorser: requiredEndorser,
            reason: reason || 'No reason provided',
            event_id: eventId
        });
    }

    async EndorseRevoke(ctx, assetId) {
        console.log(`============= START : EndorseRevoke for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const claimData = await ctx.stub.getState(claimKey);
        if (!claimData || claimData.length === 0) {
            throw new Error(`No claim found for asset ${assetId}`);
        }
        
        const claim = JSON.parse(claimData.toString());
        
        if (claim.state !== STATE_REVOKE_PENDING) {
            throw new Error(`Claim is not pending revocation. Current state: ${claim.state}`);
        }
        
        if (claim.revokeInitiatedBy === mspId) {
            throw new Error('Cannot endorse your own revocation request');
        }
        
        const timestamp = new Date().toISOString();
        
        claim.state = STATE_REVOKED;
        claim.revokeEndorsedBy = mspId;
        claim.revokeEndorsedAt = timestamp;
        claim.revokedAt = timestamp;
        claim.history.push({
            action: 'REVOKE_ENDORSED',
            by: mspId,
            at: timestamp
        });
        claim.history.push({
            action: 'REVOKED',
            by: 'SYSTEM',
            at: timestamp,
            note: `Revocation completed. Initiated by ${claim.revokeInitiatedBy}, endorsed by ${mspId}`
        });
        
        await ctx.stub.putState(claimKey, Buffer.from(JSON.stringify(claim)));
        
        const anchorKey = `${PREFIX_ANCHOR_ACTIVE}${assetId}`;
        await ctx.stub.deleteState(anchorKey);
        
        const revokeKey = `${PREFIX_REVOKE_REQUEST}${assetId}`;
        await ctx.stub.deleteState(revokeKey);
        
        const eventId = this._emitEvent(ctx, 'CLAIM_REVOKED', {
            claimId: claim.claimId,
            assetId,
            initiatedBy: claim.revokeInitiatedBy,
            endorsedBy: mspId,
            anchorDeleted: true
        });
        
        console.log(`============= END : EndorseRevoke ===========`);
        
        return JSON.stringify({
            success: true,
            claim_id: claim.claimId,
            state: STATE_REVOKED,
            initiated_by: claim.revokeInitiatedBy,
            endorsed_by: mspId,
            anchor_deleted: true,
            event_id: eventId
        });
    }

    async RejectRevoke(ctx, assetId, reason) {
        console.log(`============= START : RejectRevoke for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const claimData = await ctx.stub.getState(claimKey);
        if (!claimData || claimData.length === 0) {
            throw new Error(`No claim found for asset ${assetId}`);
        }
        
        const claim = JSON.parse(claimData.toString());
        
        if (claim.state !== STATE_REVOKE_PENDING) {
            throw new Error(`Claim is not pending revocation. Current state: ${claim.state}`);
        }
        
        if (claim.revokeInitiatedBy === mspId) {
            throw new Error('Cannot reject your own revocation request');
        }
        
        const timestamp = new Date().toISOString();
        
        claim.state = STATE_ACTIVE;
        claim.revokeRejectedBy = mspId;
        claim.revokeRejectedAt = timestamp;
        claim.revokeRejectionReason = reason || 'No reason provided';
        claim.history.push({
            action: 'REVOKE_REJECTED',
            by: mspId,
            at: timestamp,
            reason: reason || 'No reason provided'
        });
        
        await ctx.stub.putState(claimKey, Buffer.from(JSON.stringify(claim)));
        
        const revokeKey = `${PREFIX_REVOKE_REQUEST}${assetId}`;
        await ctx.stub.deleteState(revokeKey);
        
        const eventId = this._emitEvent(ctx, 'REVOKE_REJECTED', {
            claimId: claim.claimId,
            assetId,
            initiatedBy: claim.revokeInitiatedBy,
            rejectedBy: mspId,
            reason: reason || 'No reason provided',
            anchorPreserved: true
        });
        
        console.log(`============= END : RejectRevoke ===========`);
        
        return JSON.stringify({
            success: true,
            claim_id: claim.claimId,
            state: STATE_ACTIVE,
            initiated_by: claim.revokeInitiatedBy,
            rejected_by: mspId,
            rejection_reason: reason || 'No reason provided',
            anchor_preserved: true,
            event_id: eventId
        });
    }

    // ==========================================================================
    // ANCHOR QUERY FUNCTIONS
    // ==========================================================================

    async GetClaim(ctx, assetId) {
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const claimData = await ctx.stub.getState(claimKey);
        if (!claimData || claimData.length === 0) {
            return JSON.stringify({ found: false, assetId });
        }
        return claimData.toString();
    }

    async GetActiveAnchor(ctx, assetId) {
        const anchorKey = `${PREFIX_ANCHOR_ACTIVE}${assetId}`;
        const anchorData = await ctx.stub.getState(anchorKey);
        if (!anchorData || anchorData.length === 0) {
            return JSON.stringify({ found: false, assetId });
        }
        const anchor = JSON.parse(anchorData.toString());
        anchor.found = true;
        return JSON.stringify(anchor);
    }

    async GetAllActiveAnchors(ctx) {
        const iterator = await ctx.stub.getStateByRange(PREFIX_ANCHOR_ACTIVE, PREFIX_ANCHOR_ACTIVE + '\uffff');
        const anchors = [];
        
        let result = await iterator.next();
        while (!result.done) {
            if (result.value && result.value.value) {
                const anchor = JSON.parse(result.value.value.toString());
                anchors.push(anchor);
            }
            result = await iterator.next();
        }
        await iterator.close();
        
        return JSON.stringify({ anchors, count: anchors.length });
    }

    async GetPendingRevocations(ctx) {
        const iterator = await ctx.stub.getStateByRange(PREFIX_REVOKE_REQUEST, PREFIX_REVOKE_REQUEST + '\uffff');
        const pending = [];
        
        let result = await iterator.next();
        while (!result.done) {
            if (result.value && result.value.value) {
                const request = JSON.parse(result.value.value.toString());
                if (request.status === 'PENDING') {
                    pending.push(request);
                }
            }
            result = await iterator.next();
        }
        await iterator.close();
        
        return JSON.stringify({ pendingRevocations: pending, count: pending.length });
    }

    async GetPendingRevocationsForOrg(ctx) {
        const mspId = ctx.clientIdentity.getMSPID();
        const iterator = await ctx.stub.getStateByRange(PREFIX_REVOKE_REQUEST, PREFIX_REVOKE_REQUEST + '\uffff');
        const pending = [];
        
        let result = await iterator.next();
        while (!result.done) {
            if (result.value && result.value.value) {
                const request = JSON.parse(result.value.value.toString());
                if (request.status === 'PENDING' && request.requiredEndorser === mspId) {
                    pending.push(request);
                }
            }
            result = await iterator.next();
        }
        await iterator.close();
        
        return JSON.stringify({ 
            pendingRevocations: pending, 
            count: pending.length,
            forOrg: mspId
        });
    }

    /**
     * GetSnapshot - Get current state snapshot for SSE clients
     * v2.1: annotations now include intentType field
     */
    async GetSnapshot(ctx) {
        // Get claims
        const claims = [];
        const claimIterator = await ctx.stub.getStateByRange(PREFIX_CLAIM, PREFIX_CLAIM + '\uffff');
        
        let result = await claimIterator.next();
        while (!result.done) {
            if (result.value && result.value.value) {
                const claim = JSON.parse(result.value.value.toString());
                claims.push({
                    asset_id: claim.assetId,
                    claim_id: claim.claimId,
                    state: claim.state,
                    proposed_via_org: claim.proposedViaOrg,
                    endorsements: claim.endorsements,
                    endorsed_org1: claim.endorsements ? claim.endorsements.Org1MSP : false,
                    endorsed_org2: claim.endorsements ? claim.endorsements.Org2MSP : false
                });
            }
            result = await claimIterator.next();
        }
        await claimIterator.close();

        // Get annotations (v2.1: each annotation now has intentType)
        const annotations = [];
        const annIterator = await ctx.stub.getStateByRange(PREFIX_ANNOTATION, PREFIX_ANNOTATION + '\uffff');
        
        let annResult = await annIterator.next();
        while (!annResult.done) {
            if (annResult.value && annResult.value.value) {
                const ann = JSON.parse(annResult.value.value.toString());
                annotations.push({
                    asset_id: ann.assetId,
                    annotation_id: ann.annotationId,
                    intent_type: ann.intentType,
                    state: ann.state,
                    tier: ann.tier,
                    content_text: ann.contentText,
                    proposed_via_org: ann.proposedViaOrg,
                    endorsements: ann.endorsements,
                    endorsed_org1: ann.endorsements ? ann.endorsements.Org1MSP : false,
                    endorsed_org2: ann.endorsements ? ann.endorsements.Org2MSP : false
                });
            }
            annResult = await annIterator.next();
        }
        await annIterator.close();
        
        return JSON.stringify({
            success: true,
            assets: claims,
            annotations: annotations,
            last_event_id: `txsnap_${ctx.stub.getTxID().substring(0, 8)}`
        });
    }

    async GetClaimHistory(ctx, assetId) {
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const historyIterator = await ctx.stub.getHistoryForKey(claimKey);
        const history = [];
        
        let result = await historyIterator.next();
        while (!result.done) {
            if (result.value) {
                const record = {
                    txId: result.value.txId,
                    timestamp: result.value.timestamp,
                    isDelete: result.value.isDelete
                };
                if (!result.value.isDelete && result.value.value) {
                    record.value = JSON.parse(result.value.value.toString());
                }
                history.push(record);
            }
            result = await historyIterator.next();
        }
        await historyIterator.close();
        
        return JSON.stringify({ assetId, history });
    }

    // ==========================================================================
    // ANNOTATION LIFECYCLE - PROPOSE (v2.1: intentType parameter added)
    // ==========================================================================

    /**
     * ProposeAnnotation - Submit an AI-generated annotation for a governed asset
     * 
     * v2.1: intentType is now a required parameter.
     * The composite key is ANNOTATION::assetId:intentType
     * This allows one annotation per (assetId, intentType) pair.
     * 
     * ADVISORY tier: auto-activates immediately (no endorsement needed)
     * GOVERNED tier: requires dual endorsement from both Org1 and Org2
     * 
     * Precondition: an ACTIVE anchor must exist for the assetId
     * Constraint: one annotation per (assetId, intentType) at a time
     * Constraint: contentText max 280 characters
     */
    async ProposeAnnotation(ctx, assetId, contentText, tier, classContextJson, generatorId, promptHash, intentType) {
        console.log(`============= START : ProposeAnnotation for ${assetId} (tier=${tier}, intentType=${intentType}) ===========`);
        
        const signingMspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(signingMspId);
        
        // Validate tier
        if (!VALID_ANN_TIERS.includes(tier)) {
            throw new Error(`Invalid annotation tier: ${tier}. Must be one of: ${VALID_ANN_TIERS.join(', ')}`);
        }
        
        // Validate intentType (v2.1)
        if (!intentType || !VALID_INTENT_TYPES.includes(intentType)) {
            throw new Error(`Invalid or missing intentType: ${intentType}. Must be one of: ${VALID_INTENT_TYPES.join(', ')}`);
        }
        
        // Validate content text length
        if (!contentText || contentText.length === 0) {
            throw new Error('Annotation contentText is required');
        }
        if (contentText.length > ANN_MAX_CONTENT_LENGTH) {
            throw new Error(`Annotation contentText exceeds ${ANN_MAX_CONTENT_LENGTH} character limit (got ${contentText.length})`);
        }
        
        // Verify an ACTIVE anchor exists for this asset
        const anchorKey = `${PREFIX_ANCHOR_ACTIVE}${assetId}`;
        const anchorData = await ctx.stub.getState(anchorKey);
        if (!anchorData || anchorData.length === 0) {
            throw new Error(`No active anchor for asset ${assetId}. Annotations require an active governed anchor.`);
        }
        const activeAnchor = JSON.parse(anchorData.toString());
        
        // v2.1: Composite key is assetId:intentType
        const annCompositeKey = `${assetId}:${intentType}`;
        
        // Check for existing pending or active annotation for this (asset, intentType) pair
        const existingAnnKey = `${PREFIX_ANNOTATION}${annCompositeKey}`;
        const existingAnn = await ctx.stub.getState(existingAnnKey);
        if (existingAnn && existingAnn.length > 0) {
            const ann = JSON.parse(existingAnn.toString());
            if (ann.state === ANN_STATE_PROPOSED || 
                ann.state === ANN_STATE_ENDORSED_ORG1 || 
                ann.state === ANN_STATE_ENDORSED_ORG2 ||
                ann.state === ANN_STATE_ACTIVE) {
                throw new Error(`Annotation already exists for asset ${assetId} with intentType ${intentType} (state: ${ann.state}). Revoke the existing annotation first.`);
            }
        }
        
        // Parse class context
        const classContext = JSON.parse(classContextJson);
        
        // Generate annotation ID and content hash (v2.1: deterministic from assetId:intentType:txId)
        const txId = ctx.stub.getTxID();
        const annotationId = this._generateAnnotationId(assetId, intentType, txId);
        const contentHash = this._hashPayload({ contentText });
        const timestamp = new Date().toISOString();
        
        // Create annotation record
        const annotation = {
            annotationId,
            assetId,
            intentType,                              // v2.1: intent type stored on-chain
            anchorClaimId: activeAnchor.claimId,
            tier,
            state: ANN_STATE_PROPOSED,
            contentText,
            contentHash,
            classContext,
            generatorId: generatorId || 'unknown',
            promptHash: promptHash || 'unknown',
            
            proposedViaOrg: signingMspId,
            proposedAt: timestamp,
            
            endorsements: {
                Org1MSP: false,
                Org2MSP: false
            },
            
            endorsedOrg1At: null,
            endorsedOrg2At: null,
            activatedAt: null,
            
            rejections: [],
            
            history: [{
                action: 'ANN_PROPOSED',
                by: signingMspId,
                at: timestamp,
                tier: tier,
                intentType: intentType
            }]
        };
        
        // ADVISORY tier: auto-activate immediately
        if (tier === ANN_TIER_ADVISORY) {
            annotation.state = ANN_STATE_ACTIVE;
            annotation.endorsements.Org1MSP = true;
            annotation.endorsements.Org2MSP = true;
            annotation.endorsedOrg1At = timestamp;
            annotation.endorsedOrg2At = timestamp;
            annotation.activatedAt = timestamp;
            annotation.activationMethod = 'AUTO_APPROVE';
            
            annotation.history.push({
                action: 'ANN_AUTO_ACTIVATED',
                by: 'SYSTEM',
                at: timestamp,
                note: 'ADVISORY tier: auto-approved without endorsement'
            });
            
            // Write to active annotations prefix (v2.1: composite key, includes provenance)
            const activeAnnKey = `${PREFIX_ANNOTATION_ACTIVE}${annCompositeKey}`;
            await ctx.stub.putState(activeAnnKey, Buffer.from(JSON.stringify({
                assetId,
                annotationId,
                intentType,
                tier,
                contentText,
                generatorId,
                promptHash: promptHash || 'unknown',
                activatedAt: timestamp
            })));
            
            // Emit ANNOTATION_ACTIVE event
            this._emitEvent(ctx, 'ANNOTATION_ACTIVE', {
                annotationId,
                assetId,
                intentType,
                tier,
                contentText,
                activationMethod: 'AUTO_APPROVE',
                anchorClaimId: activeAnchor.claimId
            });
            
            console.log(`ADVISORY annotation auto-activated for ${assetId}:${intentType}`);
        } else {
            // GOVERNED tier: emit PROPOSED, wait for dual endorsement
            this._emitEvent(ctx, 'ANNOTATION_PROPOSED', {
                annotationId,
                assetId,
                intentType,
                tier,
                contentText,
                proposedViaOrg: signingMspId,
                requiredEndorsements: ['Org1MSP', 'Org2MSP']
            });
            
            console.log(`GOVERNED annotation proposed for ${assetId}:${intentType}, awaiting dual endorsement`);
        }
        
        // Store annotation (v2.1: composite key)
        await ctx.stub.putState(existingAnnKey, Buffer.from(JSON.stringify(annotation)));
        
        console.log(`============= END : ProposeAnnotation - annotationId: ${annotationId} ===========`);
        
        return JSON.stringify({
            success: true,
            annotation_id: annotationId,
            asset_id: assetId,
            intent_type: intentType,
            state: annotation.state,
            tier,
            content_text: contentText,
            anchor_claim_id: activeAnchor.claimId,
            proposed_via_org: signingMspId,
            activation_method: annotation.activationMethod || null
        });
    }

    // ==========================================================================
    // ANNOTATION LIFECYCLE - ENDORSE (v2.1: intentType parameter added)
    // ==========================================================================

    async EndorseAnnotation(ctx, assetId, intentType) {
        console.log(`============= START : EndorseAnnotation for ${assetId}:${intentType} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        // Validate intentType
        if (!intentType || !VALID_INTENT_TYPES.includes(intentType)) {
            throw new Error(`Invalid or missing intentType: ${intentType}. Must be one of: ${VALID_INTENT_TYPES.join(', ')}`);
        }
        
        const annCompositeKey = `${assetId}:${intentType}`;
        const annKey = `${PREFIX_ANNOTATION}${annCompositeKey}`;
        const annData = await ctx.stub.getState(annKey);
        if (!annData || annData.length === 0) {
            throw new Error(`No annotation found for asset ${assetId} with intentType ${intentType}`);
        }
        
        const annotation = JSON.parse(annData.toString());
        
        const validStates = [ANN_STATE_PROPOSED, ANN_STATE_ENDORSED_ORG1, ANN_STATE_ENDORSED_ORG2];
        if (!validStates.includes(annotation.state)) {
            throw new Error(`Annotation is in state ${annotation.state}, cannot endorse. Valid states: ${validStates.join(', ')}`);
        }
        
        if (annotation.endorsements[mspId] === true) {
            throw new Error(`${mspId} has already endorsed this annotation`);
        }
        
        const timestamp = new Date().toISOString();
        
        annotation.endorsements[mspId] = true;
        
        if (mspId === 'Org1MSP') {
            annotation.endorsedOrg1At = timestamp;
        } else {
            annotation.endorsedOrg2At = timestamp;
        }
        
        annotation.history.push({
            action: 'ANN_ENDORSED',
            by: mspId,
            at: timestamp
        });
        
        let eventType;
        let eventData;
        
        if (annotation.endorsements.Org1MSP && annotation.endorsements.Org2MSP) {
            annotation.state = ANN_STATE_ACTIVE;
            annotation.activatedAt = timestamp;
            annotation.activationMethod = 'DUAL_ENDORSEMENT';
            
            annotation.history.push({
                action: 'ANN_ACTIVATED',
                by: 'SYSTEM',
                at: timestamp,
                note: 'Both Org1 and Org2 have endorsed'
            });
            
            const activeAnnKey = `${PREFIX_ANNOTATION_ACTIVE}${annCompositeKey}`;
            await ctx.stub.putState(activeAnnKey, Buffer.from(JSON.stringify({
                assetId,
                annotationId: annotation.annotationId,
                intentType,
                tier: annotation.tier,
                contentText: annotation.contentText,
                generatorId: annotation.generatorId,
                promptHash: annotation.promptHash || 'unknown',
                activatedAt: timestamp
            })));
            
            eventType = 'ANNOTATION_ACTIVE';
            eventData = {
                annotationId: annotation.annotationId,
                assetId,
                intentType,
                tier: annotation.tier,
                contentText: annotation.contentText,
                finalEndorser: mspId,
                endorsedBy: ['Org1MSP', 'Org2MSP'],
                activationMethod: 'DUAL_ENDORSEMENT',
                activatedAt: timestamp
            };
            
            console.log(`Annotation ACTIVATED! Both orgs endorsed. (${assetId}:${intentType})`);
            
        } else {
            if (mspId === 'Org1MSP') {
                annotation.state = ANN_STATE_ENDORSED_ORG1;
                eventType = 'ANNOTATION_ENDORSED_ORG1';
            } else {
                annotation.state = ANN_STATE_ENDORSED_ORG2;
                eventType = 'ANNOTATION_ENDORSED_ORG2';
            }
            
            const pendingOrg = mspId === 'Org1MSP' ? 'Org2MSP' : 'Org1MSP';
            eventData = {
                annotationId: annotation.annotationId,
                assetId,
                intentType,
                endorsedBy: mspId,
                pendingEndorser: pendingOrg,
                endorsements: annotation.endorsements
            };
            
            console.log(`${mspId} endorsed annotation. Waiting for ${pendingOrg}... (${assetId}:${intentType})`);
        }
        
        await ctx.stub.putState(annKey, Buffer.from(JSON.stringify(annotation)));
        
        const eventId = this._emitEvent(ctx, eventType, eventData);
        
        console.log(`============= END : EndorseAnnotation ===========`);
        
        return JSON.stringify({
            success: true,
            annotation_id: annotation.annotationId,
            asset_id: assetId,
            intent_type: intentType,
            state: annotation.state,
            endorsed_by: mspId,
            endorsements: annotation.endorsements,
            is_fully_endorsed: annotation.endorsements.Org1MSP && annotation.endorsements.Org2MSP,
            event_id: eventId
        });
    }

    // ==========================================================================
    // ANNOTATION LIFECYCLE - REJECT (v2.1: intentType parameter added)
    // ==========================================================================

    async RejectAnnotation(ctx, assetId, intentType, reason) {
        console.log(`============= START : RejectAnnotation for ${assetId}:${intentType} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        if (!intentType || !VALID_INTENT_TYPES.includes(intentType)) {
            throw new Error(`Invalid or missing intentType: ${intentType}. Must be one of: ${VALID_INTENT_TYPES.join(', ')}`);
        }
        
        const annCompositeKey = `${assetId}:${intentType}`;
        const annKey = `${PREFIX_ANNOTATION}${annCompositeKey}`;
        const annData = await ctx.stub.getState(annKey);
        if (!annData || annData.length === 0) {
            throw new Error(`No annotation found for asset ${assetId} with intentType ${intentType}`);
        }
        
        const annotation = JSON.parse(annData.toString());
        
        const validStates = [ANN_STATE_PROPOSED, ANN_STATE_ENDORSED_ORG1, ANN_STATE_ENDORSED_ORG2];
        if (!validStates.includes(annotation.state)) {
            throw new Error(`Annotation is in state ${annotation.state}, cannot reject`);
        }
        
        const timestamp = new Date().toISOString();
        
        annotation.state = ANN_STATE_REJECTED;
        annotation.rejectedBy = mspId;
        annotation.rejectedAt = timestamp;
        annotation.rejectionReason = reason || 'No reason provided';
        annotation.rejections.push({
            by: mspId,
            at: timestamp,
            reason: reason || 'No reason provided'
        });
        annotation.history.push({
            action: 'ANN_REJECTED',
            by: mspId,
            at: timestamp,
            reason: reason || 'No reason provided'
        });
        
        await ctx.stub.putState(annKey, Buffer.from(JSON.stringify(annotation)));
        
        const eventId = this._emitEvent(ctx, 'ANNOTATION_REJECTED', {
            annotationId: annotation.annotationId,
            assetId,
            intentType,
            rejectedBy: mspId,
            reason: reason || 'No reason provided'
        });
        
        console.log(`============= END : RejectAnnotation ===========`);
        
        return JSON.stringify({
            success: true,
            annotation_id: annotation.annotationId,
            asset_id: assetId,
            intent_type: intentType,
            state: ANN_STATE_REJECTED,
            rejected_by: mspId,
            reason: reason || 'No reason provided',
            event_id: eventId
        });
    }

    // ==========================================================================
    // ANNOTATION LIFECYCLE - REVOKE (v2.1: intentType parameter added)
    // ==========================================================================

    async RevokeAnnotation(ctx, assetId, intentType, reason) {
        console.log(`============= START : RevokeAnnotation for ${assetId}:${intentType} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        if (!intentType || !VALID_INTENT_TYPES.includes(intentType)) {
            throw new Error(`Invalid or missing intentType: ${intentType}. Must be one of: ${VALID_INTENT_TYPES.join(', ')}`);
        }
        
        const annCompositeKey = `${assetId}:${intentType}`;
        const annKey = `${PREFIX_ANNOTATION}${annCompositeKey}`;
        const annData = await ctx.stub.getState(annKey);
        if (!annData || annData.length === 0) {
            throw new Error(`No annotation found for asset ${assetId} with intentType ${intentType}`);
        }
        
        const annotation = JSON.parse(annData.toString());
        
        if (annotation.state !== ANN_STATE_ACTIVE) {
            throw new Error(`Annotation must be ANN_ACTIVE to revoke. Current state: ${annotation.state}`);
        }
        
        const timestamp = new Date().toISOString();
        
        annotation.state = ANN_STATE_REVOKED;
        annotation.revokedBy = mspId;
        annotation.revokedAt = timestamp;
        annotation.revocationReason = reason || 'No reason provided';
        annotation.history.push({
            action: 'ANN_REVOKED',
            by: mspId,
            at: timestamp,
            reason: reason || 'No reason provided'
        });
        
        await ctx.stub.putState(annKey, Buffer.from(JSON.stringify(annotation)));
        
        // Delete from active annotations
        const activeAnnKey = `${PREFIX_ANNOTATION_ACTIVE}${annCompositeKey}`;
        await ctx.stub.deleteState(activeAnnKey);
        
        const eventId = this._emitEvent(ctx, 'ANNOTATION_REVOKED', {
            annotationId: annotation.annotationId,
            assetId,
            intentType,
            revokedBy: mspId,
            reason: reason || 'No reason provided'
        });
        
        console.log(`============= END : RevokeAnnotation ===========`);
        
        return JSON.stringify({
            success: true,
            annotation_id: annotation.annotationId,
            asset_id: assetId,
            intent_type: intentType,
            state: ANN_STATE_REVOKED,
            revoked_by: mspId,
            reason: reason || 'No reason provided',
            event_id: eventId
        });
    }

    // ==========================================================================
    // ANNOTATION QUERY FUNCTIONS (v2.1: intentType parameter added)
    // ==========================================================================

    async GetAnnotation(ctx, assetId, intentType) {
        if (!intentType || !VALID_INTENT_TYPES.includes(intentType)) {
            throw new Error(`Invalid or missing intentType: ${intentType}. Must be one of: ${VALID_INTENT_TYPES.join(', ')}`);
        }
        const annCompositeKey = `${assetId}:${intentType}`;
        const annKey = `${PREFIX_ANNOTATION}${annCompositeKey}`;
        const annData = await ctx.stub.getState(annKey);
        if (!annData || annData.length === 0) {
            return JSON.stringify({ found: false, assetId, intentType });
        }
        const annotation = JSON.parse(annData.toString());
        annotation.found = true;
        return JSON.stringify(annotation);
    }

    async GetActiveAnnotation(ctx, assetId, intentType) {
        if (!intentType || !VALID_INTENT_TYPES.includes(intentType)) {
            throw new Error(`Invalid or missing intentType: ${intentType}. Must be one of: ${VALID_INTENT_TYPES.join(', ')}`);
        }
        const annCompositeKey = `${assetId}:${intentType}`;
        const activeAnnKey = `${PREFIX_ANNOTATION_ACTIVE}${annCompositeKey}`;
        const annData = await ctx.stub.getState(activeAnnKey);
        if (!annData || annData.length === 0) {
            return JSON.stringify({ found: false, assetId, intentType });
        }
        const annotation = JSON.parse(annData.toString());
        annotation.found = true;
        return JSON.stringify(annotation);
    }

    async GetAllActiveAnnotations(ctx) {
        const iterator = await ctx.stub.getStateByRange(PREFIX_ANNOTATION_ACTIVE, PREFIX_ANNOTATION_ACTIVE + '\uffff');
        const annotations = [];
        
        let result = await iterator.next();
        while (!result.done) {
            if (result.value && result.value.value) {
                const ann = JSON.parse(result.value.value.toString());
                annotations.push(ann);
            }
            result = await iterator.next();
        }
        await iterator.close();
        
        return JSON.stringify({ annotations, count: annotations.length });
    }

    /**
     * GetActiveAnnotationsForAsset — returns all active annotation cards for a given asset.
     * Range query over ANN_ACTIVE::{assetId}: prefix to find both ASK_ANCHOR and ACTION_SUGGEST.
     */
    async GetActiveAnnotationsForAsset(ctx, assetId) {
        if (!assetId) {
            throw new Error('assetId is required');
        }
        const startKey = `${PREFIX_ANNOTATION_ACTIVE}${assetId}:`;
        const endKey = `${PREFIX_ANNOTATION_ACTIVE}${assetId}:\uffff`;
        const iterator = await ctx.stub.getStateByRange(startKey, endKey);
        const annotations = [];
        
        let result = await iterator.next();
        while (!result.done) {
            if (result.value && result.value.value) {
                const ann = JSON.parse(result.value.value.toString());
                annotations.push(ann);
            }
            result = await iterator.next();
        }
        await iterator.close();
        
        return JSON.stringify({ assetId, annotations, count: annotations.length });
    }

    async GetAnnotationHistory(ctx, assetId, intentType) {
        if (!intentType || !VALID_INTENT_TYPES.includes(intentType)) {
            throw new Error(`Invalid or missing intentType: ${intentType}. Must be one of: ${VALID_INTENT_TYPES.join(', ')}`);
        }
        const annCompositeKey = `${assetId}:${intentType}`;
        const annKey = `${PREFIX_ANNOTATION}${annCompositeKey}`;
        const historyIterator = await ctx.stub.getHistoryForKey(annKey);
        const history = [];
        
        let result = await historyIterator.next();
        while (!result.done) {
            if (result.value) {
                const record = {
                    txId: result.value.txId,
                    timestamp: result.value.timestamp,
                    isDelete: result.value.isDelete
                };
                if (!result.value.isDelete && result.value.value) {
                    record.value = JSON.parse(result.value.value.toString());
                }
                history.push(record);
            }
            result = await historyIterator.next();
        }
        await historyIterator.close();
        
        return JSON.stringify({ assetId, intentType, history });
    }

    // ==========================================================================
    // HELPER FUNCTIONS
    // ==========================================================================

    _validateMSP(mspId) {
        if (!VALID_MSPS.includes(mspId)) {
            throw new Error(`Invalid MSP: ${mspId}. Must be one of: ${VALID_MSPS.join(', ')}`);
        }
    }

    _getOtherOrg(mspId) {
        return mspId === 'Org1MSP' ? 'Org2MSP' : 'Org1MSP';
    }

    _generateClaimId(assetId, mspId) {
        const timestamp = Date.now();
        const data = `${assetId}-${mspId}-${timestamp}`;
        return 'claim_' + crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
    }

    _generateAnnotationId(assetId, intentType, txId) {
        const data = `${assetId}:${intentType}:${txId}`;
        return 'ann_' + crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
    }

    _hashPayload(payload) {
        return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    }

    _generateEventId(ctx) {
        const txId = ctx.stub.getTxID();
        if (!ctx._eventSuffix) {
            ctx._eventSuffix = 0;
        }
        ctx._eventSuffix++;
        return `${txId}:${ctx._eventSuffix}`;
    }

    _emitEvent(ctx, eventType, data) {
        const eventId = this._generateEventId(ctx);
        const timestamp = new Date().toISOString();
        
        const event = {
            eventId,
            type: eventType,
            timestamp,
            ...data
        };
        
        ctx.stub.putState(`${PREFIX_EVENT}${eventId}`, Buffer.from(JSON.stringify(event)));
        ctx.stub.setEvent(eventType, Buffer.from(JSON.stringify(event)));
        
        return eventId;
    }
}

module.exports = AnchorRegistryContract;
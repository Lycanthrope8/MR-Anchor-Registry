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
 * EXTENSION: Governed Object Annotations (v2.0)
 * - ADVISORY tier: auto-approve, 0 endorsements
 * - GOVERNED tier: dual endorsement required (same as anchors)
 * - Annotations bind to active governed anchors via anchorClaimId
 * - One active annotation per asset at a time
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

// Annotation Content Limit (characters)
const ANN_MAX_CONTENT_LENGTH = 280;

// Key Prefixes - Anchors
const PREFIX_CLAIM = 'CLAIM::';
const PREFIX_ANCHOR_ACTIVE = 'ANCHOR_ACTIVE::';
const PREFIX_EVENT = 'EVENT::';
const PREFIX_REVOKE_REQUEST = 'REVOKE_REQUEST::';

// Key Prefixes - Annotations
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
        
        const txTimestamp = ctx.stub.getTxTimestamp();
        const timestamp = new Date(txTimestamp.seconds.toNumber() * 1000).toISOString();
        
        const initEvent = {
            type: 'LEDGER_INITIALIZED',
            timestamp: timestamp,
            initiator: ctx.clientIdentity.getMSPID(),
            model: 'dual-endorsement',
            requiredEndorsers: ['Org1MSP', 'Org2MSP'],
            annotationTiers: ['ADVISORY', 'GOVERNED'],
            annotationMaxContentLength: ANN_MAX_CONTENT_LENGTH
        };
        
        const eventId = this._generateEventId(ctx);
        await ctx.stub.putState(`${PREFIX_EVENT}${eventId}`, Buffer.from(JSON.stringify(initEvent)));
        
        console.log('============= END : Initialize Ledger ===========');
        return JSON.stringify({ success: true, message: 'Ledger initialized with dual endorsement model and annotation support' });
    }

    // ==========================================================================
    // CLAIM LIFECYCLE - PROPOSE
    // ==========================================================================

    /**
     * ProposeAnchor - Submit a new anchor claim
     * The proposal is signed by one org but requires BOTH orgs to explicitly endorse
     */
    async ProposeAnchor(ctx, assetId, poseSiteJson, qualityMetricsJson) {
        console.log(`============= START : ProposeAnchor for ${assetId} ===========`);
        
        const signingMspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(signingMspId);
        
        // Parse inputs
        const poseSite = JSON.parse(poseSiteJson);
        const qualityMetrics = JSON.parse(qualityMetricsJson);
        
        // Check for existing active anchor
        const existingAnchorKey = `${PREFIX_ANCHOR_ACTIVE}${assetId}`;
        const existingAnchor = await ctx.stub.getState(existingAnchorKey);
        if (existingAnchor && existingAnchor.length > 0) {
            throw new Error(`Active anchor already exists for asset ${assetId}`);
        }
        
        // Check for existing pending claim
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
        
        // Generate claim ID
        const claimId = this._generateClaimId(assetId, signingMspId);
        const timestamp = new Date().toISOString();
        
        // Create payload hash for integrity
        const payloadHash = this._hashPayload({
            assetId,
            poseSite,
            qualityMetrics,
            timestamp
        });
        
        // Create claim object with DUAL ENDORSEMENT tracking
        const claim = {
            claimId,
            assetId,
            state: STATE_PROPOSED,
            poseSite,
            qualityMetrics,
            payloadHash,
            
            // Proposal info
            proposedViaOrg: signingMspId,  // Which org's credentials were used to submit
            proposedAt: timestamp,
            
            // DUAL ENDORSEMENT: Both must be true for ACTIVE
            endorsements: {
                Org1MSP: false,
                Org2MSP: false
            },
            
            // Timestamps for each endorsement
            endorsedOrg1At: null,
            endorsedOrg2At: null,
            activatedAt: null,
            
            // Track who rejected (if any)
            rejections: [],
            
            // Full history
            history: [{
                action: 'PROPOSED',
                by: signingMspId,
                at: timestamp,
                note: 'Awaiting endorsement from BOTH Org1 AND Org2'
            }]
        };
        
        // Store claim
        await ctx.stub.putState(existingClaimKey, Buffer.from(JSON.stringify(claim)));
        
        // Emit event
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

    /**
     * EndorseClaim - Add this organization's endorsement
     * Claim becomes ACTIVE only when BOTH Org1 AND Org2 have endorsed
     */
    async EndorseClaim(ctx, assetId) {
        console.log(`============= START : EndorseClaim for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        // Get existing claim
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const claimData = await ctx.stub.getState(claimKey);
        if (!claimData || claimData.length === 0) {
            throw new Error(`No claim found for asset ${assetId}`);
        }
        
        const claim = JSON.parse(claimData.toString());
        
        // Validate state allows endorsement
        const validStates = [STATE_PROPOSED, STATE_ENDORSED_ORG1, STATE_ENDORSED_ORG2];
        if (!validStates.includes(claim.state)) {
            throw new Error(`Claim is in state ${claim.state}, cannot endorse. Valid states: ${validStates.join(', ')}`);
        }
        
        // Check if this org already endorsed
        if (claim.endorsements[mspId] === true) {
            throw new Error(`${mspId} has already endorsed this claim`);
        }
        
        const timestamp = new Date().toISOString();
        
        // Record this org's endorsement
        claim.endorsements[mspId] = true;
        
        if (mspId === 'Org1MSP') {
            claim.endorsedOrg1At = timestamp;
        } else {
            claim.endorsedOrg2At = timestamp;
        }
        
        // Add to history
        claim.history.push({
            action: 'ENDORSED',
            by: mspId,
            at: timestamp
        });
        
        let eventType;
        let eventData;
        
        // Check if BOTH orgs have now endorsed
        if (claim.endorsements.Org1MSP && claim.endorsements.Org2MSP) {
            // BOTH endorsed - ACTIVATE!
            claim.state = STATE_ACTIVE;
            claim.activatedAt = timestamp;
            
            claim.history.push({
                action: 'ACTIVATED',
                by: 'SYSTEM',
                at: timestamp,
                note: 'Both Org1 and Org2 have endorsed'
            });
            
            // Create active anchor entry
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
            // Only one org has endorsed - update state accordingly
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
        
        // Store updated claim
        await ctx.stub.putState(claimKey, Buffer.from(JSON.stringify(claim)));
        
        // Emit event
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

    /**
     * RejectClaim - Reject a pending claim (either org can reject)
     */
    async RejectClaim(ctx, assetId, reason) {
        console.log(`============= START : RejectClaim for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        // Get existing claim
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const claimData = await ctx.stub.getState(claimKey);
        if (!claimData || claimData.length === 0) {
            throw new Error(`No claim found for asset ${assetId}`);
        }
        
        const claim = JSON.parse(claimData.toString());
        
        // Validate state
        const validStates = [STATE_PROPOSED, STATE_ENDORSED_ORG1, STATE_ENDORSED_ORG2];
        if (!validStates.includes(claim.state)) {
            throw new Error(`Claim is in state ${claim.state}, cannot reject`);
        }
        
        const timestamp = new Date().toISOString();
        
        // Update claim
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
        
        // Store updated claim
        await ctx.stub.putState(claimKey, Buffer.from(JSON.stringify(claim)));
        
        // Emit event
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

    /**
     * RevokeAnchor - Initiate revocation (requires other org to endorse)
     */
    async RevokeAnchor(ctx, assetId, reason) {
        console.log(`============= START : RevokeAnchor for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        // Get existing claim
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const claimData = await ctx.stub.getState(claimKey);
        if (!claimData || claimData.length === 0) {
            throw new Error(`No claim found for asset ${assetId}`);
        }
        
        const claim = JSON.parse(claimData.toString());
        
        // Validate state
        if (claim.state !== STATE_ACTIVE) {
            throw new Error(`Claim must be ACTIVE to revoke. Current state: ${claim.state}`);
        }
        
        const timestamp = new Date().toISOString();
        const requiredEndorser = this._getOtherOrg(mspId);
        
        // Update claim
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
        
        // Store updated claim
        await ctx.stub.putState(claimKey, Buffer.from(JSON.stringify(claim)));
        
        // Store revoke request for easy querying
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
        
        // Emit event
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

    /**
     * EndorseRevoke - Endorse a pending revocation (completes the revocation)
     */
    async EndorseRevoke(ctx, assetId) {
        console.log(`============= START : EndorseRevoke for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        // Get existing claim
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const claimData = await ctx.stub.getState(claimKey);
        if (!claimData || claimData.length === 0) {
            throw new Error(`No claim found for asset ${assetId}`);
        }
        
        const claim = JSON.parse(claimData.toString());
        
        // Validate state
        if (claim.state !== STATE_REVOKE_PENDING) {
            throw new Error(`Claim is not pending revocation. Current state: ${claim.state}`);
        }
        
        // Validate endorser
        if (claim.revokeInitiatedBy === mspId) {
            throw new Error('Cannot endorse your own revocation request');
        }
        
        const timestamp = new Date().toISOString();
        
        // Update claim
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
        
        // Store updated claim
        await ctx.stub.putState(claimKey, Buffer.from(JSON.stringify(claim)));
        
        // Delete active anchor
        const anchorKey = `${PREFIX_ANCHOR_ACTIVE}${assetId}`;
        await ctx.stub.deleteState(anchorKey);
        
        // Delete revoke request
        const revokeKey = `${PREFIX_REVOKE_REQUEST}${assetId}`;
        await ctx.stub.deleteState(revokeKey);
        
        // Emit event
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

    /**
     * RejectRevoke - Reject a pending revocation (keeps anchor active)
     */
    async RejectRevoke(ctx, assetId, reason) {
        console.log(`============= START : RejectRevoke for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        // Get existing claim
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const claimData = await ctx.stub.getState(claimKey);
        if (!claimData || claimData.length === 0) {
            throw new Error(`No claim found for asset ${assetId}`);
        }
        
        const claim = JSON.parse(claimData.toString());
        
        // Validate state
        if (claim.state !== STATE_REVOKE_PENDING) {
            throw new Error(`Claim is not pending revocation. Current state: ${claim.state}`);
        }
        
        // Validate rejector
        if (claim.revokeInitiatedBy === mspId) {
            throw new Error('Cannot reject your own revocation request');
        }
        
        const timestamp = new Date().toISOString();
        
        // Update claim - revert to ACTIVE
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
        
        // Store updated claim
        await ctx.stub.putState(claimKey, Buffer.from(JSON.stringify(claim)));
        
        // Delete revoke request
        const revokeKey = `${PREFIX_REVOKE_REQUEST}${assetId}`;
        await ctx.stub.deleteState(revokeKey);
        
        // Emit event
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

    /**
     * GetClaim - Get claim details
     */
    async GetClaim(ctx, assetId) {
        const claimKey = `${PREFIX_CLAIM}${assetId}`;
        const claimData = await ctx.stub.getState(claimKey);
        if (!claimData || claimData.length === 0) {
            return JSON.stringify({ found: false, assetId });
        }
        return claimData.toString();
    }

    /**
     * GetActiveAnchor - Get active anchor for asset
     */
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

    /**
     * GetAllActiveAnchors - Get all active anchors
     */
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

    /**
     * GetPendingRevocations - Get all pending revocation requests
     */
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

    /**
     * GetPendingRevocationsForOrg - Get pending revocations that require this org's action
     */
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
     * EXTENDED: Now includes active annotations alongside claims
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

        // Get annotations
        const annotations = [];
        const annIterator = await ctx.stub.getStateByRange(PREFIX_ANNOTATION, PREFIX_ANNOTATION + '\uffff');
        
        let annResult = await annIterator.next();
        while (!annResult.done) {
            if (annResult.value && annResult.value.value) {
                const ann = JSON.parse(annResult.value.value.toString());
                annotations.push({
                    asset_id: ann.assetId,
                    annotation_id: ann.annotationId,
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

    /**
     * GetClaimHistory - Get full history for a claim
     */
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
    // ANNOTATION LIFECYCLE - PROPOSE
    // ==========================================================================

    /**
     * ProposeAnnotation - Submit an AI-generated annotation for a governed asset
     * 
     * ADVISORY tier: auto-activates immediately (no endorsement needed)
     * GOVERNED tier: requires dual endorsement from both Org1 and Org2
     * 
     * Precondition: an ACTIVE anchor must exist for the assetId
     * Constraint: one annotation per asset at a time
     * Constraint: contentText max 280 characters
     */
    async ProposeAnnotation(ctx, assetId, contentText, tier, classContextJson, generatorId, promptHash) {
        console.log(`============= START : ProposeAnnotation for ${assetId} (tier=${tier}) ===========`);
        
        const signingMspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(signingMspId);
        
        // Validate tier
        if (!VALID_ANN_TIERS.includes(tier)) {
            throw new Error(`Invalid annotation tier: ${tier}. Must be one of: ${VALID_ANN_TIERS.join(', ')}`);
        }
        
        // Validate content text length
        if (!contentText || contentText.length === 0) {
            throw new Error('Annotation contentText is required');
        }
        if (contentText.length > ANN_MAX_CONTENT_LENGTH) {
            throw new Error(`Annotation contentText exceeds ${ANN_MAX_CONTENT_LENGTH} character limit (got ${contentText.length})`);
        }
        
        // Verify an ACTIVE anchor exists for this asset (annotations bind to governed assets)
        const anchorKey = `${PREFIX_ANCHOR_ACTIVE}${assetId}`;
        const anchorData = await ctx.stub.getState(anchorKey);
        if (!anchorData || anchorData.length === 0) {
            throw new Error(`No active anchor for asset ${assetId}. Annotations require an active governed anchor.`);
        }
        const activeAnchor = JSON.parse(anchorData.toString());
        
        // Check for existing pending or active annotation (one per asset at a time)
        const existingAnnKey = `${PREFIX_ANNOTATION}${assetId}`;
        const existingAnn = await ctx.stub.getState(existingAnnKey);
        if (existingAnn && existingAnn.length > 0) {
            const ann = JSON.parse(existingAnn.toString());
            if (ann.state === ANN_STATE_PROPOSED || 
                ann.state === ANN_STATE_ENDORSED_ORG1 || 
                ann.state === ANN_STATE_ENDORSED_ORG2 ||
                ann.state === ANN_STATE_ACTIVE) {
                throw new Error(`Annotation already exists for asset ${assetId} (state: ${ann.state}). Revoke the existing annotation first.`);
            }
        }
        
        // Parse class context
        const classContext = JSON.parse(classContextJson);
        
        // Generate annotation ID and content hash
        const annotationId = this._generateAnnotationId(assetId, signingMspId);
        const contentHash = this._hashPayload({ contentText });
        const timestamp = new Date().toISOString();
        
        // Create annotation record
        const annotation = {
            annotationId,
            assetId,
            anchorClaimId: activeAnchor.claimId,    // provenance: which anchor claim
            tier,
            state: ANN_STATE_PROPOSED,
            contentText,                             // stored on-chain (max 280 chars)
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
                tier: tier
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
            
            // Write to active annotations prefix
            const activeAnnKey = `${PREFIX_ANNOTATION_ACTIVE}${assetId}`;
            await ctx.stub.putState(activeAnnKey, Buffer.from(JSON.stringify({
                assetId,
                annotationId,
                tier,
                contentText,
                activatedAt: timestamp
            })));
            
            // Emit ANNOTATION_ACTIVE event
            this._emitEvent(ctx, 'ANNOTATION_ACTIVE', {
                annotationId,
                assetId,
                tier,
                contentText,
                activationMethod: 'AUTO_APPROVE',
                anchorClaimId: activeAnchor.claimId
            });
            
            console.log(`ADVISORY annotation auto-activated for ${assetId}`);
        } else {
            // GOVERNED tier: emit PROPOSED, wait for dual endorsement
            this._emitEvent(ctx, 'ANNOTATION_PROPOSED', {
                annotationId,
                assetId,
                tier,
                contentText,
                proposedViaOrg: signingMspId,
                requiredEndorsements: ['Org1MSP', 'Org2MSP']
            });
            
            console.log(`GOVERNED annotation proposed for ${assetId}, awaiting dual endorsement`);
        }
        
        // Store annotation
        await ctx.stub.putState(existingAnnKey, Buffer.from(JSON.stringify(annotation)));
        
        console.log(`============= END : ProposeAnnotation - annotationId: ${annotationId} ===========`);
        
        return JSON.stringify({
            success: true,
            annotation_id: annotationId,
            asset_id: assetId,
            state: annotation.state,
            tier,
            content_text: contentText,
            anchor_claim_id: activeAnchor.claimId,
            proposed_via_org: signingMspId,
            activation_method: annotation.activationMethod || null
        });
    }

    // ==========================================================================
    // ANNOTATION LIFECYCLE - ENDORSE (Dual Endorsement for GOVERNED tier)
    // ==========================================================================

    /**
     * EndorseAnnotation - Add this organization's endorsement to a GOVERNED annotation
     * Annotation becomes ANN_ACTIVE only when BOTH Org1 AND Org2 have endorsed
     */
    async EndorseAnnotation(ctx, assetId) {
        console.log(`============= START : EndorseAnnotation for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        // Get existing annotation
        const annKey = `${PREFIX_ANNOTATION}${assetId}`;
        const annData = await ctx.stub.getState(annKey);
        if (!annData || annData.length === 0) {
            throw new Error(`No annotation found for asset ${assetId}`);
        }
        
        const annotation = JSON.parse(annData.toString());
        
        // Validate state allows endorsement
        const validStates = [ANN_STATE_PROPOSED, ANN_STATE_ENDORSED_ORG1, ANN_STATE_ENDORSED_ORG2];
        if (!validStates.includes(annotation.state)) {
            throw new Error(`Annotation is in state ${annotation.state}, cannot endorse. Valid states: ${validStates.join(', ')}`);
        }
        
        // Check if this org already endorsed
        if (annotation.endorsements[mspId] === true) {
            throw new Error(`${mspId} has already endorsed this annotation`);
        }
        
        const timestamp = new Date().toISOString();
        
        // Record this org's endorsement
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
        
        // Check if BOTH orgs have now endorsed
        if (annotation.endorsements.Org1MSP && annotation.endorsements.Org2MSP) {
            // BOTH endorsed - ACTIVATE!
            annotation.state = ANN_STATE_ACTIVE;
            annotation.activatedAt = timestamp;
            annotation.activationMethod = 'DUAL_ENDORSEMENT';
            
            annotation.history.push({
                action: 'ANN_ACTIVATED',
                by: 'SYSTEM',
                at: timestamp,
                note: 'Both Org1 and Org2 have endorsed'
            });
            
            // Write to active annotations prefix
            const activeAnnKey = `${PREFIX_ANNOTATION_ACTIVE}${assetId}`;
            await ctx.stub.putState(activeAnnKey, Buffer.from(JSON.stringify({
                assetId,
                annotationId: annotation.annotationId,
                tier: annotation.tier,
                contentText: annotation.contentText,
                activatedAt: timestamp
            })));
            
            eventType = 'ANNOTATION_ACTIVE';
            eventData = {
                annotationId: annotation.annotationId,
                assetId,
                tier: annotation.tier,
                contentText: annotation.contentText,
                finalEndorser: mspId,
                endorsedBy: ['Org1MSP', 'Org2MSP'],
                activationMethod: 'DUAL_ENDORSEMENT',
                activatedAt: timestamp
            };
            
            console.log(`Annotation ACTIVATED! Both orgs endorsed.`);
            
        } else {
            // Only one org has endorsed
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
                endorsedBy: mspId,
                pendingEndorser: pendingOrg,
                endorsements: annotation.endorsements
            };
            
            console.log(`${mspId} endorsed annotation. Waiting for ${pendingOrg}...`);
        }
        
        // Store updated annotation
        await ctx.stub.putState(annKey, Buffer.from(JSON.stringify(annotation)));
        
        // Emit event
        const eventId = this._emitEvent(ctx, eventType, eventData);
        
        console.log(`============= END : EndorseAnnotation ===========`);
        
        return JSON.stringify({
            success: true,
            annotation_id: annotation.annotationId,
            asset_id: assetId,
            state: annotation.state,
            endorsed_by: mspId,
            endorsements: annotation.endorsements,
            is_fully_endorsed: annotation.endorsements.Org1MSP && annotation.endorsements.Org2MSP,
            event_id: eventId
        });
    }

    // ==========================================================================
    // ANNOTATION LIFECYCLE - REJECT
    // ==========================================================================

    /**
     * RejectAnnotation - Reject a pending annotation (either org can reject)
     */
    async RejectAnnotation(ctx, assetId, reason) {
        console.log(`============= START : RejectAnnotation for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        const annKey = `${PREFIX_ANNOTATION}${assetId}`;
        const annData = await ctx.stub.getState(annKey);
        if (!annData || annData.length === 0) {
            throw new Error(`No annotation found for asset ${assetId}`);
        }
        
        const annotation = JSON.parse(annData.toString());
        
        // Validate state
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
            rejectedBy: mspId,
            reason: reason || 'No reason provided'
        });
        
        console.log(`============= END : RejectAnnotation ===========`);
        
        return JSON.stringify({
            success: true,
            annotation_id: annotation.annotationId,
            asset_id: assetId,
            state: ANN_STATE_REJECTED,
            rejected_by: mspId,
            reason: reason || 'No reason provided',
            event_id: eventId
        });
    }

    // ==========================================================================
    // ANNOTATION LIFECYCLE - REVOKE (Simplified: single-org for prototype)
    // ==========================================================================

    /**
     * RevokeAnnotation - Revoke an active annotation (either org can revoke)
     * NOTE: Simplified single-org revoke for prototype. Does not require
     * dual endorsement like anchor revocation. This is a documented
     * prototype simplification.
     */
    async RevokeAnnotation(ctx, assetId, reason) {
        console.log(`============= START : RevokeAnnotation for ${assetId} ===========`);
        
        const mspId = ctx.clientIdentity.getMSPID();
        this._validateMSP(mspId);
        
        const annKey = `${PREFIX_ANNOTATION}${assetId}`;
        const annData = await ctx.stub.getState(annKey);
        if (!annData || annData.length === 0) {
            throw new Error(`No annotation found for asset ${assetId}`);
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
        const activeAnnKey = `${PREFIX_ANNOTATION_ACTIVE}${assetId}`;
        await ctx.stub.deleteState(activeAnnKey);
        
        const eventId = this._emitEvent(ctx, 'ANNOTATION_REVOKED', {
            annotationId: annotation.annotationId,
            assetId,
            revokedBy: mspId,
            reason: reason || 'No reason provided'
        });
        
        console.log(`============= END : RevokeAnnotation ===========`);
        
        return JSON.stringify({
            success: true,
            annotation_id: annotation.annotationId,
            asset_id: assetId,
            state: ANN_STATE_REVOKED,
            revoked_by: mspId,
            reason: reason || 'No reason provided',
            event_id: eventId
        });
    }

    // ==========================================================================
    // ANNOTATION QUERY FUNCTIONS
    // ==========================================================================

    /**
     * GetAnnotation - Get full annotation record for an asset
     */
    async GetAnnotation(ctx, assetId) {
        const annKey = `${PREFIX_ANNOTATION}${assetId}`;
        const annData = await ctx.stub.getState(annKey);
        if (!annData || annData.length === 0) {
            return JSON.stringify({ found: false, assetId });
        }
        const annotation = JSON.parse(annData.toString());
        annotation.found = true;
        return JSON.stringify(annotation);
    }

    /**
     * GetActiveAnnotation - Get the active annotation for an asset
     */
    async GetActiveAnnotation(ctx, assetId) {
        const activeAnnKey = `${PREFIX_ANNOTATION_ACTIVE}${assetId}`;
        const annData = await ctx.stub.getState(activeAnnKey);
        if (!annData || annData.length === 0) {
            return JSON.stringify({ found: false, assetId });
        }
        const annotation = JSON.parse(annData.toString());
        annotation.found = true;
        return JSON.stringify(annotation);
    }

    /**
     * GetAllActiveAnnotations - Get all active annotations (for snapshot/reconnect)
     */
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
     * GetAnnotationHistory - Get full ledger history for an annotation
     */
    async GetAnnotationHistory(ctx, assetId) {
        const annKey = `${PREFIX_ANNOTATION}${assetId}`;
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
        
        return JSON.stringify({ assetId, history });
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

    _generateAnnotationId(assetId, mspId) {
        const timestamp = Date.now();
        const data = `ann-${assetId}-${mspId}-${timestamp}`;
        return 'ann_' + crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
    }

    _hashPayload(payload) {
        return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    }

    /**
     * Generate a conflict-free event ID using the Fabric TxID.
     * Multiple events within the same tx get an in-memory suffix.
     * NO ledger writes to any shared key — eliminates MVCC_READ_CONFLICT.
     *
     * NOTE: This is now a synchronous method (no await needed).
     */
    _generateEventId(ctx) {
        const txId = ctx.stub.getTxID();
        // Track per-tx suffix in a simple property on ctx (safe within one tx)
        if (!ctx._eventSuffix) {
            ctx._eventSuffix = 0;
        }
        ctx._eventSuffix++;
        return `${txId}:${ctx._eventSuffix}`;
    }

    /**
     * Emit a chaincode event and store an event record.
     * Event record is keyed by TxID-based ID — no shared counter writes.
     *
     * NOTE: This is now a synchronous method (returns eventId, not a Promise).
     * The putState for event storage is still async but we use the per-tx unique key.
     */
    _emitEvent(ctx, eventType, data) {
        const eventId = this._generateEventId(ctx);
        const timestamp = new Date().toISOString();
        
        const event = {
            eventId,
            type: eventType,
            timestamp,
            ...data
        };
        
        // Store event for replay (keyed by txId-based ID, no contention)
        ctx.stub.putState(`${PREFIX_EVENT}${eventId}`, Buffer.from(JSON.stringify(event)));
        
        // Emit chaincode event
        ctx.stub.setEvent(eventType, Buffer.from(JSON.stringify(event)));
        
        return eventId;
    }
}

module.exports = AnchorRegistryContract;
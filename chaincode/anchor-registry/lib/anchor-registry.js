/*
 * ==============================================================================
 * anchor-registry.js - MR Anchor Registry Chaincode
 * DUAL ENDORSEMENT MODEL - Both Org1 AND Org2 must explicitly endorse
 * ==============================================================================
 * 
 * WORKFLOW:
 * 1. Unity/Device proposes anchor → PROPOSED (no endorsements yet)
 * 2. Org1 Admin clicks Endorse → endorsements.Org1MSP = true
 * 3. Org2 Admin clicks Endorse → endorsements.Org2MSP = true
 * 4. When BOTH are true → ACTIVE
 * 
 * CLAIM STATES:
 * - PROPOSED: Initial claim, waiting for both org endorsements
 * - ENDORSED_ORG1: Only Org1 has endorsed, waiting for Org2
 * - ENDORSED_ORG2: Only Org2 has endorsed, waiting for Org1
 * - ACTIVE: Both organizations have endorsed
 * - REJECTED: Claim rejected by either organization
 * - REVOKE_PENDING: Revocation initiated, awaiting other org
 * - REVOKED: Anchor revoked and deleted
 * ==============================================================================
 */

'use strict';

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

// State Constants
const STATE_PROPOSED = 'PROPOSED';
const STATE_ENDORSED_ORG1 = 'ENDORSED_ORG1';
const STATE_ENDORSED_ORG2 = 'ENDORSED_ORG2';
const STATE_ACTIVE = 'ACTIVE';
const STATE_REJECTED = 'REJECTED';
const STATE_REVOKE_PENDING = 'REVOKE_PENDING';
const STATE_REVOKED = 'REVOKED';

// Key Prefixes
const PREFIX_CLAIM = 'CLAIM::';
const PREFIX_ANCHOR_ACTIVE = 'ANCHOR_ACTIVE::';
const PREFIX_EVENT = 'EVENT::';
const PREFIX_REVOKE_REQUEST = 'REVOKE_REQUEST::';

// Valid Organizations
const VALID_MSPS = ['Org1MSP', 'Org2MSP'];

class AnchorRegistryContract extends Contract {

    // ==========================================================================
    // INITIALIZATION
    // ==========================================================================

    async InitLedger(ctx) {
        console.log('============= START : Initialize Ledger ===========');
        console.log('Dual Endorsement Model - Both Org1 AND Org2 must endorse');
        
        await ctx.stub.putState('EVENT_COUNTER', Buffer.from('0'));
        
        const txTimestamp = ctx.stub.getTxTimestamp();
        const timestamp = new Date(txTimestamp.seconds.toNumber() * 1000).toISOString();
        
        const initEvent = {
            type: 'LEDGER_INITIALIZED',
            timestamp: timestamp,
            initiator: ctx.clientIdentity.getMSPID(),
            model: 'dual-endorsement',
            requiredEndorsers: ['Org1MSP', 'Org2MSP']
        };
        
        const eventId = await this._generateEventId(ctx);
        await ctx.stub.putState(`${PREFIX_EVENT}${eventId}`, Buffer.from(JSON.stringify(initEvent)));
        
        console.log('============= END : Initialize Ledger ===========');
        return JSON.stringify({ success: true, message: 'Ledger initialized with dual endorsement model' });
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
        const eventId = await this._emitEvent(ctx, 'CLAIM_PROPOSED', {
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
        const eventId = await this._emitEvent(ctx, eventType, eventData);
        
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
        const eventId = await this._emitEvent(ctx, 'CLAIM_REJECTED', {
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
        const eventId = await this._emitEvent(ctx, 'REVOKE_INITIATED', {
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
        const eventId = await this._emitEvent(ctx, 'CLAIM_REVOKED', {
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
        const eventId = await this._emitEvent(ctx, 'REVOKE_REJECTED', {
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
    // QUERY FUNCTIONS
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
     */
    async GetSnapshot(ctx) {
        const claims = [];
        const iterator = await ctx.stub.getStateByRange(PREFIX_CLAIM, PREFIX_CLAIM + '\uffff');
        
        let result = await iterator.next();
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
            result = await iterator.next();
        }
        await iterator.close();
        
        // Get last event ID
        const eventCounter = await ctx.stub.getState('EVENT_COUNTER');
        const lastEventId = eventCounter ? eventCounter.toString() : '0';
        
        return JSON.stringify({
            success: true,
            assets: claims,
            last_event_id: `evt_${lastEventId}`
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

    _hashPayload(payload) {
        return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    }

    async _generateEventId(ctx) {
        const counterKey = 'EVENT_COUNTER';
        let counterData = await ctx.stub.getState(counterKey);
        let counter = counterData ? parseInt(counterData.toString()) : 0;
        counter++;
        await ctx.stub.putState(counterKey, Buffer.from(counter.toString()));
        return `evt_${counter}`;
    }

    async _emitEvent(ctx, eventType, data) {
        const eventId = await this._generateEventId(ctx);
        const timestamp = new Date().toISOString();
        
        const event = {
            eventId,
            type: eventType,
            timestamp,
            ...data
        };
        
        // Store event for replay
        await ctx.stub.putState(`${PREFIX_EVENT}${eventId}`, Buffer.from(JSON.stringify(event)));
        
        // Emit chaincode event
        ctx.stub.setEvent(eventType, Buffer.from(JSON.stringify(event)));
        
        return eventId;
    }
}

module.exports = AnchorRegistryContract;
'use strict';

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

const States = { PROPOSED: 'PROPOSED', ACTIVE: 'ACTIVE', REVOKED: 'REVOKED', SUPERSEDED: 'SUPERSEDED', CONFLICT: 'CONFLICT' };
const ConflictClass = { NONE: 'NONE', REFINEMENT: 'REFINEMENT', SUSPICIOUS: 'SUSPICIOUS', CONFLICT: 'CONFLICT' };
const KeyPrefix = { ANCHOR_ACTIVE: 'ANCHOR_ACTIVE', CLAIM: 'CLAIM', ENDORSE: 'ENDORSE', CONFIG: 'CONFIG' };

class AnchorRegistryContract extends Contract {
    constructor() { super('AnchorRegistryContract'); }

    async InitLedger(ctx) {
        const config = { endorsementThreshold: 1, thresholdRefinement: 0.05, thresholdSuspicious: 0.25 };
        await ctx.stub.putState(KeyPrefix.CONFIG, Buffer.from(JSON.stringify(config)));
        return JSON.stringify({ success: true, config });
    }

    async GetConfig(ctx) {
        const data = await ctx.stub.getState(KeyPrefix.CONFIG);
        return data.toString();
    }

    async ProposeAnchor(ctx, assetId, payloadHash, payloadPtr, poseSummaryJson, qualitySummaryJson, publisherId) {
        if (!assetId || !payloadHash || !publisherId) throw new Error('VALIDATION: required fields missing');
        
        const poseSummary = JSON.parse(poseSummaryJson);
        const qualitySummary = JSON.parse(qualitySummaryJson);
        const configData = await ctx.stub.getState(KeyPrefix.CONFIG);
        const config = JSON.parse(configData.toString());
        
        let conflictClassification = ConflictClass.NONE, conflictDistance = 0, conflictWithClaimId = '';
        const activeData = await ctx.stub.getState(`${KeyPrefix.ANCHOR_ACTIVE}::${assetId}`);
        if (activeData && activeData.length > 0) {
            const active = JSON.parse(activeData.toString());
            const claimData = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${active.claimId}`);
            if (claimData && claimData.length > 0) {
                const claim = JSON.parse(claimData.toString());
                if (claim.poseSummary) {
                    const dx = poseSummary.x - claim.poseSummary.x;
                    const dy = poseSummary.y - claim.poseSummary.y;
                    const dz = poseSummary.z - claim.poseSummary.z;
                    conflictDistance = Math.sqrt(dx*dx + dy*dy + dz*dz);
                    if (conflictDistance < config.thresholdRefinement) conflictClassification = ConflictClass.REFINEMENT;
                    else if (conflictDistance < config.thresholdSuspicious) conflictClassification = ConflictClass.SUSPICIOUS;
                    else conflictClassification = ConflictClass.CONFLICT;
                    conflictWithClaimId = claim.claimId;
                }
            }
        }

        // FIXED: Use ONLY deterministic values - txId is the same on all peers
        const txId = ctx.stub.getTxID();
        const claimId = `claim-${crypto.createHash('sha256').update(`${assetId}-${txId}`).digest('hex').substring(0, 16)}`;
        
        // FIXED: Use transaction timestamp instead of Date.now()
        const txTimestamp = ctx.stub.getTxTimestamp();
        const now = new Date(txTimestamp.seconds.low * 1000).toISOString();
        
        const claim = { 
            claimId, 
            assetId, 
            state: States.PROPOSED, 
            payloadHash, 
            payloadPtr, 
            poseSummary, 
            qualitySummary, 
            publisherId, 
            endorsementCount: 0, 
            endorsers: [], 
            conflictClassification, 
            conflictWithClaimId, 
            conflictDistance, 
            createdAt: now 
        };
        
        await ctx.stub.putState(`${KeyPrefix.CLAIM}::${claimId}`, Buffer.from(JSON.stringify(claim)));
        return JSON.stringify(claim);
    }

    async EndorseAnchor(ctx, claimId, endorserId) {
        const claimData = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${claimId}`);
        if (!claimData || claimData.length === 0) throw new Error(`NOT_FOUND: ${claimId}`);
        const claim = JSON.parse(claimData.toString());
        
        if (claim.state !== States.PROPOSED && claim.state !== States.CONFLICT) throw new Error(`INVALID_STATE: ${claim.state}`);
        
        const endorseKey = `${KeyPrefix.ENDORSE}::${claimId}::${endorserId}`;
        const existing = await ctx.stub.getState(endorseKey);
        if (existing && existing.length > 0) throw new Error(`DUPLICATE: ${endorserId} already endorsed`);
        if (claim.endorsers.includes(endorserId)) throw new Error(`DUPLICATE: in list`);
        
        // FIXED: Use transaction timestamp
        const txTimestamp = ctx.stub.getTxTimestamp();
        const now = new Date(txTimestamp.seconds.low * 1000).toISOString();
        
        await ctx.stub.putState(endorseKey, Buffer.from(JSON.stringify({ claimId, endorserId, timestamp: now })));
        claim.endorsementCount++;
        claim.endorsers.push(endorserId);
        
        const configData = await ctx.stub.getState(KeyPrefix.CONFIG);
        const config = JSON.parse(configData.toString());
        let required = config.endorsementThreshold;
        if (claim.conflictClassification === ConflictClass.SUSPICIOUS) required++;
        else if (claim.conflictClassification === ConflictClass.CONFLICT) {
            claim.state = States.CONFLICT;
            await ctx.stub.putState(`${KeyPrefix.CLAIM}::${claimId}`, Buffer.from(JSON.stringify(claim)));
            return JSON.stringify(claim);
        }
        
        if (claim.endorsementCount >= required) {
            const activeData = await ctx.stub.getState(`${KeyPrefix.ANCHOR_ACTIVE}::${claim.assetId}`);
            if (activeData && activeData.length > 0) {
                const old = JSON.parse(activeData.toString());
                const oldClaimData = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${old.claimId}`);
                if (oldClaimData && oldClaimData.length > 0) {
                    const oldClaim = JSON.parse(oldClaimData.toString());
                    oldClaim.state = States.SUPERSEDED;
                    oldClaim.supersededAt = now;
                    oldClaim.supersededBy = claimId;
                    await ctx.stub.putState(`${KeyPrefix.CLAIM}::${old.claimId}`, Buffer.from(JSON.stringify(oldClaim)));
                }
            }
            claim.state = States.ACTIVE;
            claim.activatedAt = now;
            await ctx.stub.putState(`${KeyPrefix.ANCHOR_ACTIVE}::${claim.assetId}`, Buffer.from(JSON.stringify({ assetId: claim.assetId, claimId, activatedAt: now })));
        }
        
        await ctx.stub.putState(`${KeyPrefix.CLAIM}::${claimId}`, Buffer.from(JSON.stringify(claim)));
        return JSON.stringify(claim);
    }

    async ResolveAnchor(ctx, assetId) {
        const activeData = await ctx.stub.getState(`${KeyPrefix.ANCHOR_ACTIVE}::${assetId}`);
        if (!activeData || activeData.length === 0) return JSON.stringify(null);
        const active = JSON.parse(activeData.toString());
        const claimData = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${active.claimId}`);
        return claimData.toString();
    }

    async RevokeAnchor(ctx, assetId, claimId, reason, supervisorId) {
        let targetId = claimId;
        if (!targetId || targetId === '') {
            const activeData = await ctx.stub.getState(`${KeyPrefix.ANCHOR_ACTIVE}::${assetId}`);
            if (!activeData || activeData.length === 0) throw new Error(`NOT_FOUND: no active for ${assetId}`);
            targetId = JSON.parse(activeData.toString()).claimId;
        }
        
        const claimData = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${targetId}`);
        if (!claimData || claimData.length === 0) throw new Error(`NOT_FOUND: ${targetId}`);
        const claim = JSON.parse(claimData.toString());
        if (claim.state !== States.ACTIVE) throw new Error(`INVALID_STATE: ${claim.state}`);
        
        // FIXED: Use transaction timestamp
        const txTimestamp = ctx.stub.getTxTimestamp();
        const now = new Date(txTimestamp.seconds.low * 1000).toISOString();
        
        claim.state = States.REVOKED;
        claim.revokedAt = now;
        claim.revokedBy = supervisorId;
        claim.revocationReason = reason;
        
        await ctx.stub.putState(`${KeyPrefix.CLAIM}::${targetId}`, Buffer.from(JSON.stringify(claim)));
        await ctx.stub.deleteState(`${KeyPrefix.ANCHOR_ACTIVE}::${claim.assetId}`);
        return JSON.stringify(claim);
    }

    async GetClaim(ctx, claimId) {
        const data = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${claimId}`);
        return data && data.length > 0 ? data.toString() : JSON.stringify(null);
    }

    async ListClaims(ctx, assetId) {
        const claims = [];
        const iterator = await ctx.stub.getStateByRange('', '');
        let result = await iterator.next();
        while (!result.done) {
            if (result.value.key.startsWith(KeyPrefix.CLAIM)) {
                try {
                    const claim = JSON.parse(result.value.value.toString());
                    if (claim.assetId === assetId) claims.push(claim);
                } catch (e) {}
            }
            result = await iterator.next();
        }
        await iterator.close();
        return JSON.stringify(claims);
    }
}

module.exports = AnchorRegistryContract;

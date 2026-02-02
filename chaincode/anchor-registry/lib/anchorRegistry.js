'use strict';

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

// Claim lifecycle states
const States = {
    PROPOSED: 'PROPOSED',
    ACTIVE: 'ACTIVE',
    REVOKED: 'REVOKED',
    SUPERSEDED: 'SUPERSEDED',
    CONFLICT: 'CONFLICT',
    REJECTED: 'REJECTED'  // NEW: On-chain rejection state
};

const ConflictClass = {
    NONE: 'NONE',
    REFINEMENT: 'REFINEMENT',
    SUSPICIOUS: 'SUSPICIOUS',
    CONFLICT: 'CONFLICT'
};

const KeyPrefix = {
    ANCHOR_ACTIVE: 'ANCHOR_ACTIVE',
    CLAIM: 'CLAIM',
    ENDORSE: 'ENDORSE',
    CONFIG: 'CONFIG',
    AUDIT: 'AUDIT'  // NEW: Audit trail prefix
};

class AnchorRegistryContract extends Contract {
    constructor() {
        super('AnchorRegistryContract');
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async InitLedger(ctx) {
        const config = {
            endorsementThreshold: 1,
            thresholdRefinement: 0.05,
            thresholdSuspicious: 0.25,
            version: '2.0.0',  // Updated version with REJECT support
            createdAt: this._getTxTimestamp(ctx)
        };
        await ctx.stub.putState(KeyPrefix.CONFIG, Buffer.from(JSON.stringify(config)));
        
        // Create initial audit entry
        const auditEntry = {
            type: 'SYSTEM_INIT',
            timestamp: this._getTxTimestamp(ctx),
            txId: ctx.stub.getTxID(),
            details: { config }
        };
        await this._addAuditEntry(ctx, auditEntry);
        
        return JSON.stringify({ success: true, config });
    }

    async GetConfig(ctx) {
        const data = await ctx.stub.getState(KeyPrefix.CONFIG);
        return data.toString();
    }

    // =========================================================================
    // PROPOSE ANCHOR
    // =========================================================================

    async ProposeAnchor(ctx, assetId, payloadHash, payloadPtr, poseSummaryJson, qualitySummaryJson, publisherId) {
        if (!assetId || !payloadHash || !publisherId) {
            throw new Error('VALIDATION: required fields missing (assetId, payloadHash, publisherId)');
        }

        const poseSummary = JSON.parse(poseSummaryJson);
        const qualitySummary = JSON.parse(qualitySummaryJson);
        const configData = await ctx.stub.getState(KeyPrefix.CONFIG);
        const config = JSON.parse(configData.toString());

        // Check for conflicts with existing active anchor
        let conflictClassification = ConflictClass.NONE;
        let conflictDistance = 0;
        let conflictWithClaimId = '';

        const activeData = await ctx.stub.getState(`${KeyPrefix.ANCHOR_ACTIVE}::${assetId}`);
        if (activeData && activeData.length > 0) {
            const active = JSON.parse(activeData.toString());
            const claimData = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${active.claimId}`);
            if (claimData && claimData.length > 0) {
                const existingClaim = JSON.parse(claimData.toString());
                if (existingClaim.poseSummary) {
                    const dx = poseSummary.x - existingClaim.poseSummary.x;
                    const dy = poseSummary.y - existingClaim.poseSummary.y;
                    const dz = poseSummary.z - existingClaim.poseSummary.z;
                    conflictDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    
                    if (conflictDistance < config.thresholdRefinement) {
                        conflictClassification = ConflictClass.REFINEMENT;
                    } else if (conflictDistance < config.thresholdSuspicious) {
                        conflictClassification = ConflictClass.SUSPICIOUS;
                    } else {
                        conflictClassification = ConflictClass.CONFLICT;
                    }
                    conflictWithClaimId = existingClaim.claimId;
                }
            }
        }

        // Generate deterministic claim ID using transaction ID
        const txId = ctx.stub.getTxID();
        const claimId = `claim-${crypto.createHash('sha256').update(`${assetId}-${txId}`).digest('hex').substring(0, 16)}`;
        const now = this._getTxTimestamp(ctx);

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
            createdAt: now,
            txId
        };

        await ctx.stub.putState(`${KeyPrefix.CLAIM}::${claimId}`, Buffer.from(JSON.stringify(claim)));

        // Audit trail
        await this._addAuditEntry(ctx, {
            type: 'CLAIM_PROPOSED',
            claimId,
            assetId,
            publisherId,
            timestamp: now,
            txId,
            details: { conflictClassification, conflictDistance }
        });

        return JSON.stringify(claim);
    }

    // =========================================================================
    // ENDORSE ANCHOR
    // =========================================================================

    async EndorseAnchor(ctx, claimId, endorserId) {
        const claimData = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${claimId}`);
        if (!claimData || claimData.length === 0) {
            throw new Error(`NOT_FOUND: claim ${claimId} does not exist`);
        }

        const claim = JSON.parse(claimData.toString());

        // Can only endorse PROPOSED or CONFLICT claims (NOT REJECTED)
        if (claim.state !== States.PROPOSED && claim.state !== States.CONFLICT) {
            throw new Error(`INVALID_STATE: cannot endorse claim in state ${claim.state}`);
        }

        // Check for duplicate endorsement
        const endorseKey = `${KeyPrefix.ENDORSE}::${claimId}::${endorserId}`;
        const existing = await ctx.stub.getState(endorseKey);
        if (existing && existing.length > 0) {
            throw new Error(`DUPLICATE: ${endorserId} has already endorsed this claim`);
        }
        if (claim.endorsers.includes(endorserId)) {
            throw new Error(`DUPLICATE: endorser already in list`);
        }

        const now = this._getTxTimestamp(ctx);
        const txId = ctx.stub.getTxID();

        // Record endorsement
        await ctx.stub.putState(endorseKey, Buffer.from(JSON.stringify({
            claimId,
            endorserId,
            timestamp: now,
            txId
        })));

        claim.endorsementCount++;
        claim.endorsers.push(endorserId);

        // Check endorsement threshold
        const configData = await ctx.stub.getState(KeyPrefix.CONFIG);
        const config = JSON.parse(configData.toString());

        let requiredEndorsements = config.endorsementThreshold;
        if (claim.conflictClassification === ConflictClass.SUSPICIOUS) {
            requiredEndorsements++;
        } else if (claim.conflictClassification === ConflictClass.CONFLICT) {
            claim.state = States.CONFLICT;
            await ctx.stub.putState(`${KeyPrefix.CLAIM}::${claimId}`, Buffer.from(JSON.stringify(claim)));
            
            await this._addAuditEntry(ctx, {
                type: 'CLAIM_CONFLICT',
                claimId,
                assetId: claim.assetId,
                endorserId,
                timestamp: now,
                txId
            });
            
            return JSON.stringify(claim);
        }

        // Check if threshold met - activate claim
        if (claim.endorsementCount >= requiredEndorsements) {
            // Supersede existing active anchor if present
            const activeData = await ctx.stub.getState(`${KeyPrefix.ANCHOR_ACTIVE}::${claim.assetId}`);
            if (activeData && activeData.length > 0) {
                const oldActive = JSON.parse(activeData.toString());
                const oldClaimData = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${oldActive.claimId}`);
                if (oldClaimData && oldClaimData.length > 0) {
                    const oldClaim = JSON.parse(oldClaimData.toString());
                    oldClaim.state = States.SUPERSEDED;
                    oldClaim.supersededAt = now;
                    oldClaim.supersededBy = claimId;
                    await ctx.stub.putState(`${KeyPrefix.CLAIM}::${oldActive.claimId}`, Buffer.from(JSON.stringify(oldClaim)));
                    
                    await this._addAuditEntry(ctx, {
                        type: 'CLAIM_SUPERSEDED',
                        claimId: oldActive.claimId,
                        assetId: claim.assetId,
                        supersededBy: claimId,
                        timestamp: now,
                        txId
                    });
                }
            }

            claim.state = States.ACTIVE;
            claim.activatedAt = now;
            claim.activatedTxId = txId;

            await ctx.stub.putState(`${KeyPrefix.ANCHOR_ACTIVE}::${claim.assetId}`, Buffer.from(JSON.stringify({
                assetId: claim.assetId,
                claimId,
                activatedAt: now
            })));

            await this._addAuditEntry(ctx, {
                type: 'CLAIM_ACTIVATED',
                claimId,
                assetId: claim.assetId,
                endorserId,
                totalEndorsements: claim.endorsementCount,
                timestamp: now,
                txId
            });
        } else {
            await this._addAuditEntry(ctx, {
                type: 'CLAIM_ENDORSED',
                claimId,
                assetId: claim.assetId,
                endorserId,
                endorsementCount: claim.endorsementCount,
                requiredEndorsements,
                timestamp: now,
                txId
            });
        }

        await ctx.stub.putState(`${KeyPrefix.CLAIM}::${claimId}`, Buffer.from(JSON.stringify(claim)));
        return JSON.stringify(claim);
    }

    // =========================================================================
    // REJECT ANCHOR (NEW - ON-CHAIN)
    // =========================================================================

    /**
     * Reject a proposed claim. Only supervisor role should call this.
     * Records rejection reason, timestamp, and supervisor identity on-chain.
     * Once rejected, a claim cannot become ACTIVE unless explicitly reopened.
     */
    async RejectClaim(ctx, claimId, reason, supervisorId) {
        if (!claimId) {
            throw new Error('VALIDATION: claimId is required');
        }
        if (!reason || reason.trim() === '') {
            throw new Error('VALIDATION: rejection reason is required');
        }
        if (!supervisorId) {
            throw new Error('VALIDATION: supervisorId is required');
        }

        const claimData = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${claimId}`);
        if (!claimData || claimData.length === 0) {
            throw new Error(`NOT_FOUND: claim ${claimId} does not exist`);
        }

        const claim = JSON.parse(claimData.toString());

        // Can only reject PROPOSED or CONFLICT claims
        if (claim.state !== States.PROPOSED && claim.state !== States.CONFLICT) {
            throw new Error(`INVALID_STATE: cannot reject claim in state ${claim.state}. Only PROPOSED or CONFLICT claims can be rejected.`);
        }

        const now = this._getTxTimestamp(ctx);
        const txId = ctx.stub.getTxID();

        // Update claim to REJECTED state
        claim.state = States.REJECTED;
        claim.rejectedAt = now;
        claim.rejectedBy = supervisorId;
        claim.rejectionReason = reason.trim();
        claim.rejectionTxId = txId;

        await ctx.stub.putState(`${KeyPrefix.CLAIM}::${claimId}`, Buffer.from(JSON.stringify(claim)));

        // Create detailed audit entry
        await this._addAuditEntry(ctx, {
            type: 'CLAIM_REJECTED',
            claimId,
            assetId: claim.assetId,
            supervisorId,
            reason: reason.trim(),
            previousState: claim.state === States.REJECTED ? 'PROPOSED' : claim.state, // Will be old state before update
            timestamp: now,
            txId
        });

        return JSON.stringify(claim);
    }

    // =========================================================================
    // REOPEN REJECTED CLAIM (OPTIONAL)
    // =========================================================================

    /**
     * Reopen a previously rejected claim back to PROPOSED state.
     * This allows for a second review after addressing rejection concerns.
     */
    async ReopenClaim(ctx, claimId, reason, supervisorId) {
        if (!claimId) {
            throw new Error('VALIDATION: claimId is required');
        }
        if (!supervisorId) {
            throw new Error('VALIDATION: supervisorId is required');
        }

        const claimData = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${claimId}`);
        if (!claimData || claimData.length === 0) {
            throw new Error(`NOT_FOUND: claim ${claimId} does not exist`);
        }

        const claim = JSON.parse(claimData.toString());

        // Can only reopen REJECTED claims
        if (claim.state !== States.REJECTED) {
            throw new Error(`INVALID_STATE: can only reopen REJECTED claims, current state is ${claim.state}`);
        }

        const now = this._getTxTimestamp(ctx);
        const txId = ctx.stub.getTxID();

        // Store rejection history before reopening
        if (!claim.rejectionHistory) {
            claim.rejectionHistory = [];
        }
        claim.rejectionHistory.push({
            rejectedAt: claim.rejectedAt,
            rejectedBy: claim.rejectedBy,
            reason: claim.rejectionReason,
            reopenedAt: now,
            reopenedBy: supervisorId,
            reopenReason: reason || ''
        });

        // Reopen to PROPOSED state
        claim.state = States.PROPOSED;
        claim.reopenedAt = now;
        claim.reopenedBy = supervisorId;
        claim.reopenReason = reason || '';

        // Clear rejection fields (but keep history)
        delete claim.rejectedAt;
        delete claim.rejectedBy;
        delete claim.rejectionReason;
        delete claim.rejectionTxId;

        await ctx.stub.putState(`${KeyPrefix.CLAIM}::${claimId}`, Buffer.from(JSON.stringify(claim)));

        await this._addAuditEntry(ctx, {
            type: 'CLAIM_REOPENED',
            claimId,
            assetId: claim.assetId,
            supervisorId,
            reason: reason || '',
            timestamp: now,
            txId
        });

        return JSON.stringify(claim);
    }

    // =========================================================================
    // REVOKE ANCHOR
    // =========================================================================

    async RevokeAnchor(ctx, assetId, claimId, reason, supervisorId) {
        if (!reason || reason.trim() === '') {
            throw new Error('VALIDATION: revocation reason is required');
        }
        if (!supervisorId) {
            throw new Error('VALIDATION: supervisorId is required');
        }

        let targetClaimId = claimId;

        // If no specific claim ID, revoke the active anchor
        if (!targetClaimId || targetClaimId === '') {
            const activeData = await ctx.stub.getState(`${KeyPrefix.ANCHOR_ACTIVE}::${assetId}`);
            if (!activeData || activeData.length === 0) {
                throw new Error(`NOT_FOUND: no active anchor for asset ${assetId}`);
            }
            targetClaimId = JSON.parse(activeData.toString()).claimId;
        }

        const claimData = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${targetClaimId}`);
        if (!claimData || claimData.length === 0) {
            throw new Error(`NOT_FOUND: claim ${targetClaimId} does not exist`);
        }

        const claim = JSON.parse(claimData.toString());

        // Can only revoke ACTIVE claims
        if (claim.state !== States.ACTIVE) {
            throw new Error(`INVALID_STATE: cannot revoke claim in state ${claim.state}. Only ACTIVE claims can be revoked.`);
        }

        const now = this._getTxTimestamp(ctx);
        const txId = ctx.stub.getTxID();

        claim.state = States.REVOKED;
        claim.revokedAt = now;
        claim.revokedBy = supervisorId;
        claim.revocationReason = reason.trim();
        claim.revocationTxId = txId;

        await ctx.stub.putState(`${KeyPrefix.CLAIM}::${targetClaimId}`, Buffer.from(JSON.stringify(claim)));

        // Remove from active anchors
        await ctx.stub.deleteState(`${KeyPrefix.ANCHOR_ACTIVE}::${claim.assetId}`);

        await this._addAuditEntry(ctx, {
            type: 'CLAIM_REVOKED',
            claimId: targetClaimId,
            assetId: claim.assetId,
            supervisorId,
            reason: reason.trim(),
            timestamp: now,
            txId
        });

        return JSON.stringify(claim);
    }

    // =========================================================================
    // QUERY FUNCTIONS
    // =========================================================================

    async ResolveAnchor(ctx, assetId) {
        const activeData = await ctx.stub.getState(`${KeyPrefix.ANCHOR_ACTIVE}::${assetId}`);
        if (!activeData || activeData.length === 0) {
            return JSON.stringify(null);
        }

        const active = JSON.parse(activeData.toString());
        const claimData = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${active.claimId}`);

        if (!claimData || claimData.length === 0) {
            return JSON.stringify(null);
        }

        return claimData.toString();
    }

    async GetClaim(ctx, claimId) {
        const data = await ctx.stub.getState(`${KeyPrefix.CLAIM}::${claimId}`);
        if (!data || data.length === 0) {
            return JSON.stringify(null);
        }
        return data.toString();
    }

    async ListClaims(ctx, assetId) {
        const claims = [];
        const iterator = await ctx.stub.getStateByRange('', '');

        let result = await iterator.next();
        while (!result.done) {
            if (result.value.key.startsWith(KeyPrefix.CLAIM)) {
                try {
                    const claim = JSON.parse(result.value.value.toString());
                    if (claim.assetId === assetId) {
                        claims.push(claim);
                    }
                } catch (e) {
                    // Skip malformed entries
                }
            }
            result = await iterator.next();
        }
        await iterator.close();

        // Sort by createdAt descending (newest first)
        claims.sort((a, b) => {
            const ta = new Date(a.createdAt || 0).getTime();
            const tb = new Date(b.createdAt || 0).getTime();
            return tb - ta;
        });

        return JSON.stringify(claims);
    }

    // =========================================================================
    // AUDIT FUNCTIONS
    // =========================================================================

    async GetClaimHistory(ctx, claimId) {
        const history = [];
        const iterator = await ctx.stub.getHistoryForKey(`${KeyPrefix.CLAIM}::${claimId}`);

        let result = await iterator.next();
        while (!result.done) {
            try {
                const record = {
                    txId: result.value.txId,
                    timestamp: new Date(result.value.timestamp.seconds.low * 1000).toISOString(),
                    isDelete: result.value.isDelete
                };
                if (!result.value.isDelete && result.value.value) {
                    record.value = JSON.parse(result.value.value.toString());
                }
                history.push(record);
            } catch (e) {
                // Skip malformed entries
            }
            result = await iterator.next();
        }
        await iterator.close();

        return JSON.stringify(history);
    }

    async GetAuditLog(ctx, assetId, limit) {
        const maxLimit = Math.min(parseInt(limit) || 100, 500);
        const auditEntries = [];
        const iterator = await ctx.stub.getStateByRange('', '');

        let result = await iterator.next();
        while (!result.done) {
            if (result.value.key.startsWith(KeyPrefix.AUDIT)) {
                try {
                    const entry = JSON.parse(result.value.value.toString());
                    if (!assetId || entry.assetId === assetId) {
                        auditEntries.push(entry);
                    }
                } catch (e) {
                    // Skip malformed entries
                }
            }
            result = await iterator.next();
        }
        await iterator.close();

        // Sort by timestamp descending
        auditEntries.sort((a, b) => {
            const ta = new Date(a.timestamp || 0).getTime();
            const tb = new Date(b.timestamp || 0).getTime();
            return tb - ta;
        });

        return JSON.stringify(auditEntries.slice(0, maxLimit));
    }

    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================

    _getTxTimestamp(ctx) {
        const txTimestamp = ctx.stub.getTxTimestamp();
        return new Date(txTimestamp.seconds.low * 1000).toISOString();
    }

    async _addAuditEntry(ctx, entry) {
        const txId = ctx.stub.getTxID();
        const entryHash = crypto.createHash('sha256')
            .update(JSON.stringify(entry))
            .digest('hex')
            .substring(0, 8);
        const auditKey = `${KeyPrefix.AUDIT}::${txId}::${entryHash}`;
        await ctx.stub.putState(auditKey, Buffer.from(JSON.stringify(entry)));
    }
}

module.exports = AnchorRegistryContract;

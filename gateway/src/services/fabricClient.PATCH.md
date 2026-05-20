/**
 * ============================================================================
 * fabricClient.js — PATCH INSTRUCTIONS for Phase 4
 *
 * Add the audit-chaincode contract handle and two new methods to your existing
 * FabricClient class. Do NOT replace the file — insert the marked blocks at
 * the locations shown below.
 * ============================================================================
 */

// ─── INSERT 1: Add a second chaincode constant near the top, alongside CHAINCODE_NAME ───
// LOCATION: replace this block in fabricClient.js (around line 24-26):
//
//   const CHANNEL_NAME = 'anchorchannel';
//   const CHAINCODE_NAME = 'anchor-registry';
//
// WITH:

const CHANNEL_NAME = 'anchorchannel';
const CHAINCODE_NAME = 'anchor-registry';
const AUDIT_CHAINCODE_NAME = 'skill-audit-registry';   // NEW (Phase 4)

// ─── INSERT 2: Add an `auditContract` field to the FabricClient constructor ───
// LOCATION: in the constructor (around line 55-65), after `this.contract = null;`
//
// ADD:

        this.auditContract = null;     // NEW (Phase 4): skill-audit-registry handle

// ─── INSERT 3: Bind the audit contract right after this.contract is set in connect() ───
// LOCATION: in connect() (around line 154-155), after this line:
//
//   this.contract = this.network.getContract(CHAINCODE_NAME);
//
// ADD:

            this.auditContract = this.network.getContract(AUDIT_CHAINCODE_NAME);
            logger.info(`[${this.org}] ✓ skill-audit-registry contract handle obtained`);

// ─── INSERT 4: Two new methods at the END of the FabricClient class ───
// LOCATION: just before the closing `}` of the FabricClient class
// (around line 415, after the last annotation method).
//
// ADD:

    // =========================================================================
    // SKILL-AUDIT-REGISTRY METHODS (Phase 4)
    // =========================================================================

    /**
     * Record a skill decision envelope on-chain. The chaincode validates
     * the envelope (required fields, hash formats, caller-msp == submittingOrg)
     * and refuses duplicates. Returns the persisted record's identifiers.
     *
     * @param {object} envelope - audit envelope built by the gateway
     * @returns {Promise<object>} { success, decision_id, tx_id, state, recorded_at, event_id }
     */
    async recordSkillDecision(envelope) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        if (!this.auditContract) throw new Error('audit contract not bound (connect first)');
        logger.info(`[${this.org}] RecordSkillDecision: ${envelope.decisionId}`);
        const result = await this.auditContract.submitTransaction(
            'RecordSkillDecision',
            JSON.stringify(envelope)
        );
        return resultToJson(result);
    }

    /**
     * After a successful anchor-registry invocation, link the audit record
     * to the anchor tx id (and the final state the anchor reached).
     *
     * Idempotent: re-linking the same tx is OK; linking a different tx fails.
     *
     * @param {string} decisionId
     * @param {string} anchorTxId
     * @param {string} finalState   - e.g. 'PROPOSED', 'ENDORSED_ORG1', 'ACTIVE'
     * @param {string} assetId      - for the per-anchor decision index
     */
    async linkAnchorTx(decisionId, anchorTxId, finalState, assetId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        if (!this.auditContract) throw new Error('audit contract not bound');
        logger.info(`[${this.org}] LinkAnchorTx: ${decisionId} -> ${anchorTxId}`);
        const result = await this.auditContract.submitTransaction(
            'LinkAnchorTx',
            decisionId,
            anchorTxId,
            finalState,
            assetId || ''
        );
        return resultToJson(result);
    }

    /**
     * Read-only: fetch a single audit record by decisionId.
     */
    async querySkillDecision(decisionId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        if (!this.auditContract) throw new Error('audit contract not bound');
        const result = await this.auditContract.evaluateTransaction(
            'QuerySkillDecision',
            decisionId
        );
        return resultToJson(result);
    }

    /**
     * Read-only: full causal chain (decision + all linked events) for replay.
     */
    async replayDecision(decisionId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        if (!this.auditContract) throw new Error('audit contract not bound');
        const result = await this.auditContract.evaluateTransaction(
            'ReplayDecision',
            decisionId
        );
        return resultToJson(result);
    }

    /**
     * Read-only: all decisionIds linked to an asset.
     */
    async listDecisionsByAnchor(assetId) {
        if (!this.connected) throw new Error('Not connected to Fabric network');
        if (!this.auditContract) throw new Error('audit contract not bound');
        const result = await this.auditContract.evaluateTransaction(
            'ListDecisionsByAnchor',
            assetId
        );
        return resultToJson(result);
    }

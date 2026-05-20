/**
 * ==============================================================================
 * fabricFunctionMap.js
 *
 * Maps skill-side function names (v0.1.2: matches anchor-registry chaincode)
 * to FabricClient method invocations.
 *
 * The mapping table is the AUTHORITATIVE list of what the gateway will execute.
 * If the policy validator says a function is allowed and this mapper has no
 * entry for it, that's a bug — fail closed.
 *
 * Each entry returns:
 *   {
 *     fabricMethod: '<method-name-on-FabricClient>',
 *     mapArgs:      (args) => [<positional args for that method>],
 *     captureState: (result) => '<finalState string for LinkAnchorTx>',
 *   }
 *
 * `captureState` reads the chaincode response and extracts the resulting
 * lifecycle state for the audit record. For reads, returns 'READ'.
 * ==============================================================================
 */

function pickState(result, fallback = 'UNKNOWN') {
    if (!result || typeof result !== 'object') return fallback;
    if (typeof result.state === 'string') return result.state;
    if (typeof result.asset_state === 'string') return result.asset_state;
    if (typeof result.status === 'string') return result.status;
    return fallback;
}

const MAP = {
    ProposeAnchor: {
        fabricMethod: 'proposeAnchor',
        mapArgs: (args) => {
            // ProposeAnchor on the chaincode accepts (assetId, poseSite, qualityMetrics).
            // The skill returns assetId + poseHash + metadataHash; the gateway wraps
            // those into the existing chaincode-side shapes (pose_site holds the hash,
            // quality_metrics holds metadata). For Phase 4 we keep the LLM-driven
            // path opaque to existing schemas — Phase 5 will negotiate richer shapes.
            return [
                args.assetId,
                { pose_hash: args.poseHash },
                { metadata_hash: args.metadataHash },
            ];
        },
        captureState: (result) => pickState(result, 'PROPOSED'),
        write: true,
    },
    EndorseClaim: {
        fabricMethod: 'endorseClaim',
        mapArgs: (args) => [args.assetId],
        captureState: (result) => pickState(result, 'ENDORSED'),
        write: true,
    },
    RevokeAnchor: {
        fabricMethod: 'revokeAnchor',
        mapArgs: (args) => [args.assetId, args.reason],
        captureState: (result) => pickState(result, 'REVOKE_PENDING'),
        write: true,
    },
    EndorseRevoke: {
        fabricMethod: 'endorseRevoke',
        mapArgs: (args) => [args.assetId],
        captureState: (result) => pickState(result, 'REVOKED'),
        write: true,
    },
    GetClaim: {
        fabricMethod: 'getClaim',
        mapArgs: (args) => [args.assetId],
        captureState: () => 'READ',
        write: false,
    },
    GetClaimHistory: {
        fabricMethod: 'getClaimHistory',
        mapArgs: (args) => [args.assetId],
        captureState: () => 'READ',
        write: false,
    },
    GetSnapshot: {
        fabricMethod: 'getSnapshot',
        mapArgs: () => [],
        captureState: () => 'READ',
        write: false,
    },
};

function resolve(functionName) {
    return MAP[functionName] || null;
}

function knownNames() {
    return Object.keys(MAP);
}

module.exports = { resolve, knownNames, MAP };

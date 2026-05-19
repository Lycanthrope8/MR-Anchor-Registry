/*
 * SPDX-License-Identifier: Apache-2.0
 * MR Skill Audit Registry Chaincode
 *
 * Records on-chain provenance of LLM-mediated governance decisions.
 * Sibling to anchor-registry; same channel (anchorchannel).
 */

'use strict';

const SkillAuditRegistryContract = require('./lib/skill-audit-registry');

module.exports.SkillAuditRegistryContract = SkillAuditRegistryContract;
module.exports.contracts = [SkillAuditRegistryContract];

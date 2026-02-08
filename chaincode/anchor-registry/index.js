/*
 * SPDX-License-Identifier: Apache-2.0
 * MR Anchor Registry Chaincode
 */

'use strict';

const AnchorRegistryContract = require('./lib/anchor-registry');

module.exports.AnchorRegistryContract = AnchorRegistryContract;
module.exports.contracts = [AnchorRegistryContract];

const config = require('../config');

function authMiddleware(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ success: false, error: 'API key required' });
    const keyInfo = config.apiKeys[apiKey];
    if (!keyInfo) return res.status(401).json({ success: false, error: 'Invalid API key' });
    req.auth = { apiKey, role: keyInfo.role, name: keyInfo.name, isSupervisor: config.supervisorIds.includes(apiKey) };
    next();
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.auth.role) && !req.auth.isSupervisor) {
            return res.status(403).json({ success: false, error: `Requires: ${roles.join(' or ')}` });
        }
        next();
    };
}

function requireSupervisor(req, res, next) {
    if (!req.auth?.isSupervisor) return res.status(403).json({ success: false, error: 'Supervisor required' });
    next();
}

module.exports = authMiddleware;
module.exports.requireRole = requireRole;
module.exports.requireSupervisor = requireSupervisor;

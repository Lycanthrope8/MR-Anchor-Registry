const logger = require('../utils/logger');

module.exports = (err, req, res, next) => {
    logger.error('Error:', { message: err.message, path: req.path });
    let status = 500;
    if (err.message.includes('ACCESS_DENIED')) status = 403;
    else if (err.message.includes('NOT_FOUND')) status = 404;
    else if (err.message.includes('DUPLICATE')) status = 409;
    else if (err.message.includes('INVALID_STATE') || err.message.includes('VALIDATION')) status = 400;
    res.status(status).json({ success: false, error: err.message });
};

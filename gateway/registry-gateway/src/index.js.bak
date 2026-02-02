const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const logger = require('./utils/logger');
const config = require('./config');
const { initializePostgres, closePostgres } = require('./db/postgres');
const { initializeFabric, closeFabric } = require('./fabric/client');
const authMiddleware = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');
const claimsRoutes = require('./routes/claims');
const assetsRoutes = require('./routes/assets');
const healthRoutes = require('./routes/health');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

app.use('/health', healthRoutes);
app.use('/claims', authMiddleware, claimsRoutes);
app.use('/assets', authMiddleware, assetsRoutes);
app.get('/', (req, res) => res.json({ service: 'MR-Anchor-Registry', version: '1.0.0' }));
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));
app.use(errorHandler);

async function start() {
    logger.info('Starting gateway...');
    logger.info(`FABRIC_MOCK=${config.fabricMock}`);
    await initializePostgres();
    await initializeFabric();
    app.listen(config.port, '0.0.0.0', () => logger.info(`Listening on port ${config.port}`));
}

process.on('SIGTERM', async () => { await closeFabric(); await closePostgres(); process.exit(0); });
process.on('SIGINT', async () => { await closeFabric(); await closePostgres(); process.exit(0); });
start().catch(err => { logger.error('Startup failed:', err); process.exit(1); });

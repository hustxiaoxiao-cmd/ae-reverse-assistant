import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'info';

const logger = pino({
    level: logLevel,
    transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
});

export function logInfo(message: string): void {
    logger.info(message);
}

export function logError(message: string): void {
    logger.error(message);
}

export function logWarn(message: string): void {
    logger.warn(message);
}

export function logDebug(message: string): void {
    logger.debug(message);
}
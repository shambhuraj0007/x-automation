/**
 * src/logger.js
 * Winston-based logger with console + rotating file output.
 */

'use strict';

const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const { combine, timestamp, printf, colorize, errors } = format;

// Custom log format
const logFormat = printf(({ level, message, timestamp: ts, stack }) => {
  const base = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}`;
  return stack ? `${base}\n${stack}` : base;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    // Console — with colour
    new transports.Console({
      format: combine(
        colorize({ all: true }),
        errors({ stack: true }),
        timestamp({ format: 'HH:mm:ss' }),
        printf(({ level, message, timestamp: ts, stack }) => {
          const base = `[${ts}] ${level} ${message}`;
          return stack ? `${base}\n${stack}` : base;
        })
      ),
    }),

    // Daily rotating file — all levels
    new DailyRotateFile({
      filename: path.join(logsDir, 'automation-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      zippedArchive: true,
    }),

    // Separate error log
    new DailyRotateFile({
      level: 'error',
      filename: path.join(logsDir, 'errors-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      zippedArchive: true,
    }),
  ],
});

module.exports = logger;

const winston = require('winston');
const path = require('path');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(__dirname,'../logs/monitor.log'), maxsize: 10*1024*1024, maxFiles: 5 }),
    new winston.transports.File({ filename: path.join(__dirname,'../logs/trades.log'), level: 'warn', maxsize: 5*1024*1024, maxFiles: 5 }),
  ],
});
module.exports = logger;

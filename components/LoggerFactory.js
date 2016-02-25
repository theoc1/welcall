'use strict';

let os = require('os'),
	util = require('util'),
	winston = require('winston');

let formatterOpts = {
	hour12: false,
	weekday: 'short',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit'
};

/**
 * Returns a configured Winston logger instance.
 * @param path filename
 */
module.exports = path => new (winston.Logger)({
	level: 'silly',
	transports: [
		new (winston.transports.DailyRotateFile)({
			name: 'file',
			filename: path
		}),
		new (winston.transports.Console)({
			name: 'cli',
			colorize: true,
			timestamp: () => Intl.DateTimeFormat('en-GB', formatterOpts).format(),
			prettyPrint: data => os.EOL + util.inspect(data, false, 1, true).replace(/\n\s*/g, ' ')
		})
	]
});
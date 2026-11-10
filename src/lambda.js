// AWS Lambda entry point (Function URL -> Express).
const serverless = require('serverless-http');
module.exports.handler = serverless(require('./server'));

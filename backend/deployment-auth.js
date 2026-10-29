const { timingSafeEqual } = require('crypto');

function createBasicAuthMiddleware({ username, password }) {
  if (!username || !password) throw new Error('Deployment Basic Auth requires both a username and password.');
  const expected = Buffer.from(`${username}:${password}`);

  return function deploymentBasicAuth(req, res, next) {
    if (req.path === '/api/health') return next();

    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
    if (match) {
      const supplied = Buffer.from(match[1], 'base64');
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
        req.angchatDeploymentAuthenticated = true;
        return next();
      }
    }

    res.set('WWW-Authenticate', 'Basic realm="AngChat demo", charset="UTF-8"');
    res.set('Cache-Control', 'no-store');
    return res.status(401).type('text/plain').send('Authentication required.');
  };
}

module.exports = { createBasicAuthMiddleware };

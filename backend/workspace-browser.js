const fs = require('fs');
const os = require('os');
const path = require('path');

const DIRECTORY_LIMIT = 1000;

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function browseDirectories(requestedPath, { allowedRoot } = {}) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim() || requestedPath.length > 4096) {
    throw new Error('Choose a directory to browse.');
  }
  if (!path.isAbsolute(requestedPath)) throw new Error('The directory path must be absolute.');

  const resolvedPath = fs.realpathSync(path.resolve(requestedPath.trim()));
  if (!fs.statSync(resolvedPath).isDirectory()) throw new Error('The selected path is not a directory.');

  const resolvedAllowedRoot = allowedRoot ? fs.realpathSync(allowedRoot) : null;
  if (resolvedAllowedRoot && !isWithin(resolvedAllowedRoot, resolvedPath)) {
    throw new Error(`Directory browsing is restricted to ${resolvedAllowedRoot}.`);
  }

  const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, path: path.join(resolvedPath, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));

  const filesystemRoot = path.parse(resolvedPath).root;
  const parentPath = resolvedPath === filesystemRoot || resolvedPath === resolvedAllowedRoot
    ? null
    : path.dirname(resolvedPath);
  const homePath = os.homedir();

  return {
    path: resolvedPath,
    parentPath,
    homePath: !resolvedAllowedRoot || isWithin(resolvedAllowedRoot, homePath) ? homePath : null,
    canSelect: resolvedPath !== filesystemRoot,
    directories: entries.slice(0, DIRECTORY_LIMIT),
    truncated: entries.length > DIRECTORY_LIMIT
  };
}

module.exports = { browseDirectories };

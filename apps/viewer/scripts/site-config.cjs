const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
const repositoryDir = path.resolve(projectDir, '../..');

function normalizeBasePath(value = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || /[?#\\\s]/.test(value)) {
    throw new Error('PUBLIC_BASE_PATH must be an absolute path, such as / or /caiso-market-desk/.');
  }
  if (value.includes('//')) throw new Error('PUBLIC_BASE_PATH cannot contain empty path segments.');
  const parts = value.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error('PUBLIC_BASE_PATH must contain URL-safe repository path segments.');
  }
  return parts.length ? `/${parts.join('/')}/` : '/';
}

function basePathFromArgs(args = process.argv.slice(2)) {
  const i = args.indexOf('--base');
  if (i >= 0 && !args[i + 1]) throw new Error('--base needs a path.');
  return normalizeBasePath(i >= 0 ? args[i + 1] : process.env.PUBLIC_BASE_PATH || '/');
}

function siteUrl(basePath, value) {
  if (!value.startsWith('/') || value.startsWith('//')) return value;
  return basePath === '/' || value.startsWith(basePath) ? value : basePath + value.slice(1);
}

module.exports = {
  projectDir,
  repositoryDir,
  outputDir: path.join(projectDir, 'dist'),
  publishedDataDir: path.join(repositoryDir, 'data/published'),
  downloadsDir: path.join(repositoryDir, 'data/downloads'),
  normalizeBasePath,
  basePathFromArgs,
  siteUrl,
};

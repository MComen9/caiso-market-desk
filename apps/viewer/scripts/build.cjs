const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const {
  projectDir, outputDir, publishedDataDir, downloadsDir, basePathFromArgs,
} = require('./site-config.cjs');
const generateCsvView = require('./csv-view.cjs');
const generateQuickViews = require('./quick-view.cjs');

function requirePublishedInputs() {
  for (const file of [
    'prices-bootstrap.json', 'outlook_snapshot_2026-10-28_2026-10-29.json',
    'fundamentals-snapshot.json', 'data-gaps/catalog.json',
    'forecast-lab/v4/report.json', 'forecast-lab/v4/forecast-forward.json',
    'forecast-lab/v4/simulation-summary.json', 'forecast-lab/v4/forward-predictions.csv',
  ]) {
    if (!fs.statSync(path.join(publishedDataDir, file), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing published input: data/published/${file}. Restore the versioned data before building.`);
    }
  }
}

function copyPublishedFiles(source, target) {
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, target, {
    recursive: true,
    filter: candidate => {
      if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error(`Published files cannot be symbolic links: ${candidate}`);
      return candidate === source || !path.basename(candidate).startsWith('.');
    },
  });
}

async function buildSite({ basePath = basePathFromArgs(), watch = false } = {}) {
  requirePublishedInputs();
  // Output is always this app's dist directory; no environment variable can
  // redirect the cleanup into source or into the frozen shared data directory.
  fs.rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(path.join(outputDir, 'assets'), { recursive: true });
  copyPublishedFiles(path.join(projectDir, 'public'), outputDir);
  copyPublishedFiles(publishedDataDir, path.join(outputDir, 'data'));
  copyPublishedFiles(downloadsDir, path.join(outputDir, 'downloads'));

  generateCsvView({ dist: outputDir, basePath });
  generateQuickViews({ dist: outputDir, basePath });
  fs.writeFileSync(path.join(outputDir, '.nojekyll'), '');
  const report = JSON.parse(fs.readFileSync(path.join(publishedDataDir, 'forecast-lab/v4/report.json'), 'utf8'));
  fs.writeFileSync(path.join(outputDir, 'site-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    basePath,
    mode: 'published_read_only_snapshot',
    modelVersion: report.modelVersion,
    targetDate: report.forecast.targetDate,
    trainingThrough: report.forecast.trainingThrough,
    forecastIssuedAt: report.forecast.issuedAt,
  }, null, 2) + '\n');

  const options = {
    absWorkingDir: projectDir,
    entryPoints: ['visitor-entry.tsx'],
    outfile: 'dist/assets/viewer.js',
    bundle: true,
    minify: !watch,
    target: ['es2022'],
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
      '__PUBLIC_BASE_PATH__': JSON.stringify(basePath),
    },
    legalComments: 'eof',
    logLevel: 'info',
  };
  if (watch) {
    const context = await esbuild.context(options);
    await context.rebuild();
    await context.watch();
    return { outputDir, basePath, context };
  }
  await esbuild.build(options);
  console.log(`Built read-only viewer at ${basePath} from data/published.`);
  return { outputDir, basePath };
}

module.exports = { buildSite };
if (require.main === module) {
  buildSite().catch(error => { console.error(error.message); process.exitCode = 1; });
}

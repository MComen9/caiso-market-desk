const { buildSite } = require('./build.cjs');
const { startServer } = require('./serve.cjs');

buildSite({ watch: true }).then(({ basePath, context }) => {
  const server = startServer({ basePath });
  console.log('Source changes rebuild automatically. Refresh the page after rebuilding. Re-run dev after changing shared data.');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await context.dispose();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}).catch(error => { console.error(error.message); process.exitCode = 1; });

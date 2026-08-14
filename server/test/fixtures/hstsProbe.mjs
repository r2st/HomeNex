// Prints the headers securityHeaders() sets for a TLS request, as a fresh process
// sees them.
//
// HSTS_MAX_AGE is read once, at module load, which is the honest shape for a config
// value: the deploy sets it and the process lives with it. Testing that in-process
// therefore needs a *second* instance of the module, and the obvious way to get one
// — `import('../middleware.js?hsts=off')` — quietly wrecks the coverage report.
//
// V8 keys coverage by script URL, so the query string makes a second script; the
// test runner's reporter then folds both entries onto the same path and the last one
// wins rather than merging. The last one is this probe's instance, which only ever
// calls securityHeaders, so middleware.js reported 7.69% function coverage for a
// module the suite exercises end to end on every request. The numbers were wrong,
// not the tests, and a wrong number is worse than a missing one — it hid a real gap
// for as long as it took someone to check.
//
// A child process gives the same fresh module with no second URL, so the file stays
// counted once and this stays a test of what the deploy actually reads.
import { securityHeaders } from '../../middleware.js'

const set = {}
securityHeaders({ secure: true }, { setHeader: (k, v) => (set[k] = v) }, () => {})
process.stdout.write(JSON.stringify(set))

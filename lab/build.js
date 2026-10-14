// Inline core.js into a single-file page for publishing.
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const core = fs.readFileSync(__dirname + '/core.js', 'utf8');
fs.mkdirSync(__dirname + '/dist', { recursive: true });
fs.writeFileSync(__dirname + '/dist/tab-thrashing.html', html.replace('<script src="core.js"></script>', () => '<script>\n' + core + '\n</script>'));
console.log('built dist/tab-thrashing.html');

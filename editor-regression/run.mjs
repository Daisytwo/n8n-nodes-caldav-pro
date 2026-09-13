// Test-only: execute complete, hash-pinned upstream frontend modules, not copied algorithms.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import * as vue from 'vue';

const require = createRequire(import.meta.url);
const ts = require('typescript'); // use the node package's existing dev dependency
const workflow = require('n8n-workflow');
const { CalDav } = require(process.env.CALDAV_NODE_PATH ?? '../dist/nodes/CalDav/CalDav.node.js');
const manifest = JSON.parse(await readFile(new URL('./upstream.json', import.meta.url), 'utf8'));
const cache = new URL('./.cache/', import.meta.url);
await mkdir(cache, { recursive: true });

async function upstream(version, file) {
 const target = new URL(`${version.commit}-${file.name}.ts`, cache);
 let source;
 try { source = await readFile(target, 'utf8'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const url = `https://raw.githubusercontent.com/n8n-io/n8n/${version.commit}/${file.path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `Cannot download pinned source: ${url}`);
  source = await response.text();
  assert.equal(createHash('sha256').update(source).digest('hex'), file.sha256);
  await writeFile(target, source);
 }
 assert.equal(createHash('sha256').update(source).digest('hex'), file.sha256, 'Upstream source hash mismatch');
 return source;
}

function load(source, filename, imports) {
 const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: filename,
 }).outputText;
 const module = { exports: {} };
 const injectedRequire = (name) => {
  assert.ok(Object.hasOwn(imports, name), `Unstubbed import ${name} in ${filename}`);
  return imports[name];
 };
 // Trusted upstream code is pinned above; the VM is an import adapter, not a security sandbox.
 new Script('(function(require,module,exports){' + output + '\n})', { filename })
  .runInThisContext()(injectedRequire, module, module.exports);
 return module.exports;
}

for (const version of manifest) {
 const sources = Object.fromEntries(await Promise.all(version.files.map(async (file) => [file.name, await upstream(version, file)])));
 const description = new CalDav().description;
 let activeDescription = description;
 const credentialsStore = {
  getCredentialTypesNodeDescriptions: (_override, type) => type?.credentials ?? [],
  allUsableCredentialsByType: {
   calDavApi: [{ id: 'dav-fixture', name: 'Test CalDAV', type: 'calDavApi' }],
   icsFeedApi: [{ id: 'ics-fixture', name: 'Test Feed', type: 'icsFeedApi' }],
  },
  getCredentialTypeByName: (name) => ({ displayName: name }),
  hasFetchedUsableCredentials: true,
 };
 const unexpected = () => { throw new Error('Out-of-scope dependency called'); };
 const imports = {
  'n8n-workflow': workflow,
  'vue': vue,
  '@/app/constants': {
   MAIN_AUTH_FIELD_NAME: 'authentication', KEEP_AUTH_IN_NDV_FOR_NODES: [],
   CORE_NODES_CATEGORY: '', MAPPING_PARAMS: [], NON_ACTIVATABLE_TRIGGER_NODE_TYPES: [],
   PLACEHOLDER_FILLED_AT_EXECUTION_TIME: '', TEMPLATES_NODES_FILTER: [],
  },
  '@n8n/i18n': { i18n: { baseText: unexpected } },
  '@/features/credentials/credentials.store': { useCredentialsStore: () => credentialsStore },
  '../credentials.store': { useCredentialsStore: () => credentialsStore },
  '@/app/stores/nodeTypes.store': { useNodeTypesStore: () => ({ getNodeType: () => activeDescription }) },
  '@/app/utils/typesUtils': { isJsonKeyObject: unexpected },
  '@/app/composables/useNodeHelpers': { useNodeHelpers: () => ({ displayParameter: unexpected }) },
 };
 const utils = load(sources.nodeTypesUtils, `n8n-${version.version}/nodeTypesUtils.ts`, imports);
 imports['@/app/utils/nodeTypesUtils'] = utils;
 const { useNodeCredentialOptions } = load(sources.useNodeCredentialOptions, `n8n-${version.version}/useNodeCredentialOptions.ts`, imports);

 test(`n8n ${version.version}: negative control exposes resource-as-auth regression`, () => {
  const gated = structuredClone(description);
  gated.credentials[0].displayOptions = { show: { resource: ['calendar', 'event'] } };
  gated.credentials[1].displayOptions = { show: { resource: ['icsFeed'] } };
  assert.equal(utils.getMainAuthField(gated)?.name, 'resource');
  activeDescription = gated;
  let update;
  utils.updateNodeAuthType((info) => { update = info; }, { name: 'Test', type: 'calDav', typeVersion: 1, parameters: { resource: 'event', operation: 'getAll' } }, 'calendar');
  assert.equal(update.properties.parameters.resource, 'calendar');
  activeDescription = description;
 });

 for (const resource of ['calendar', 'event', 'icsFeed']) {
  test(`n8n ${version.version}: ${resource} selectors stay independent of resource`, () => {
   const node = vue.ref({ name: 'Test', type: 'calDav', typeVersion: 1, parameters: { resource, operation: 'getAll' } });
   const scope = vue.effectScope();
   try {
    const options = scope.run(() => useNodeCredentialOptions(vue.computed(() => node.value), vue.computed(() => description), ''));
    assert.equal(utils.getMainAuthField(description), null);
    assert.deepEqual(options.credentialTypesNodeDescriptionDisplayed.value.map(({ type }) => type.name), ['calDavApi', 'icsFeedApi']);
    const before = JSON.stringify(node.value.parameters);
    utils.updateNodeAuthType(() => assert.fail('Credential setup must not rewrite resource'), node.value, 'calendar');
    assert.equal(JSON.stringify(node.value.parameters), before);
    // In-memory credential/store fixture, NOT the component's selection or persistence handler.
    const credentialType = resource === 'icsFeed' ? 'icsFeedApi' : 'calDavApi';
    node.value.credentials = { [credentialType]: { id: resource === 'icsFeed' ? 'ics-fixture' : 'dav-fixture', name: 'Fixture' } };
    assert.equal(options.isCredentialExisting(description.credentials.find((c) => c.name === credentialType)), true);
    node.value = JSON.parse(JSON.stringify(node.value));
    assert.equal(node.value.parameters.resource, resource);
    assert.equal(options.credentialTypesNodeDescriptionDisplayed.value.length, 2);
   } finally { scope.stop(); }
  });
 }
}

for (const resource of ['calendar', 'event', 'icsFeed']) {
 test(`workflow display helper: one credential notice for ${resource}`, () => {
  const description = new CalDav().description;
  const node = { typeVersion: 1 };
  const visible = description.properties.filter((p) => p.type === 'notice' && workflow.NodeHelpers.displayParameter({ resource }, p, node, description));
  assert.equal(visible.length, 1);
  assert.match(visible[0].displayName, /can be left empty/);
 });
}
console.log('Scope: pinned frontend auth utilities + Vue credential-options composable; workflow notice filtering. No mounted editor, backend persistence, credential modal or network execution.');

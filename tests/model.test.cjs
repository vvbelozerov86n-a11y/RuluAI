// Model regression tests: run the shipped scripts with only their DOM shell stubbed.
// No browser automation, external packages, network, or real localStorage is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const storageKey = 'ruly-bento-draft-v1';
const sourceDirectory = path.join(__dirname, '..', 'designs');
const scripts = ['hierarchy.js', 'builder.js'].map(name => ({
  name,
  source: fs.readFileSync(path.join(sourceDirectory, name), 'utf8'),
}));

function memoryStorage(initial) {
  const values = new Map(initial === undefined ? [] : [[storageKey, initial]]);
  return {
    writes: 0,
    failWrites: false,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (this.failWrites) throw new Error('Storage quota exceeded');
      this.writes++;
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
  };
}

function loadApp(storage = memoryStorage()) {
  const elements = new Map();
  const listeners = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        innerHTML: '', textContent: '', disabled: false, offsetWidth: 100,
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector() { return null; },
        addEventListener() {}, focus() {},
      });
    }
    return elements.get(id);
  }
  const location = { pathname: '/hierarchy.html', search: '', hash: '' };
  const updateLocation = (_state, _title, url) => {
    const parsed = new URL(url, 'https://example.test');
    Object.assign(location, { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash });
  };
  const document = {
    title: '', body: element('body'),
    getElementById: element,
    querySelector() { return null; },
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
  };
  const context = vm.createContext({
    document, location, localStorage: storage,
    history: { pushState: updateLocation, replaceState: updateLocation },
    window: { addEventListener() {}, scrollTo() {} },
    crypto: webcrypto, console, URL,
    setTimeout() { return 1; }, clearTimeout() {},
  });
  for (const script of scripts) vm.runInContext(script.source, context, { filename: script.name });
  return {
    storage, elements,
    run(source) { return vm.runInContext(source, context); },
    json(expression) { return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)); },
  };
}

function task(id, extra = {}) {
  return { id, title: id, owner: 'me', status: 'todo', size: 'small', theme: 'teal', ...extra };
}

function tree(children = []) {
  return { id: 'root', title: 'Все задачи', children };
}

function chain(depth) {
  let node = task(`depth-${depth}`);
  for (let level = depth - 1; level >= 1; level--) {
    node = { id: `depth-${level}`, title: `Уровень ${level}`, owner: 'me', children: [node] };
  }
  return tree([node]);
}

test('participant counts include owners and deduplicate people and bots across descendants', () => {
  const app = loadApp();
  const result = app.json(`builderPeople({
    owner:'anna', participants:['anna','analyst'], children:[
      {owner:'analyst', participants:['anna','writer']},
      {owner:'me', participants:['writer','me']},
      {owner:'max', participants:[]}
    ]
  })`);
  assert.deepEqual(result.human.sort(), ['anna', 'max', 'me']);
  assert.deepEqual(result.bot.sort(), ['analyst', 'writer']);
  assert.deepEqual(app.json("builderPeople({owner:'analyst',participants:[]})"), {
    human: [], bot: ['analyst'],
  });
});

test('progress rolls up leaf results and excludes completed tasks from overdue totals', () => {
  const app = loadApp();
  app.run(`root.children = [{id:'project',title:'Проект',owner:'me',children:[
    {id:'phase',title:'Этап',owner:'anna',children:[
      {id:'done',title:'Готово',owner:'anna',status:'done',overdue:true},
      {id:'review',title:'Проверка',owner:'analyst',status:'review'}
    ]},
    {id:'doing',title:'Работа',owner:'max',status:'doing',overdue:true}
  ]}];`);
  assert.deepEqual(app.json('stats(root)'), { total: 3, done: 1, review: 1, late: 1 });
  assert.equal(app.run('progress(stats(root))'), 33);
  app.run("findPath('review').at(-1).status='done'; findPath('doing').at(-1).status='done';");
  assert.deepEqual(app.json('stats(root)'), { total: 3, done: 3, review: 0, late: 0 });
  assert.equal(app.run('progress(stats(root))'), 100);
});

test('empty groups stay valid, have zero progress, and render an add-task state', () => {
  const app = loadApp(memoryStorage(JSON.stringify(tree())));
  assert.equal(app.run('builderValidTree(root)'), true);
  assert.deepEqual(app.json('stats(root)'), { total: 0, done: 0, review: 0, late: 0 });
  assert.equal(app.run('progress(stats(root))'), 0);
  assert.match(app.elements.get('content').innerHTML, /Добавить подзадачу/);
  assert.equal(app.run('builderCanAdd(root)'), true);
});

test('validation rejects duplicate IDs, unknown members and malformed structure', () => {
  const app = loadApp();
  const invalid = [
    tree([task('duplicate'), task('duplicate')]),
    tree([task('unknown-owner', { owner: 'missing' })]),
    tree([task('unknown-participant', { participants: ['missing'] })]),
    tree([task('bad-status', { status: 'not-a-status' })]),
    tree([task('bad-children', { children: {} })]),
    tree([task('empty-title', { title: '  ' })]),
    tree([task('bad-size', { size: 'huge' })]),
    { id: 'root', title: 'Не группа', status: 'todo' },
  ];
  for (const value of invalid) {
    assert.equal(app.run(`builderValidTree(${JSON.stringify(value)})`), false, JSON.stringify(value));
  }
});

test('node and depth limits accept the boundary and reject the next addition', () => {
  const maxNodes = tree(Array.from({ length: 499 }, (_, i) => task(`node-${i}`)));
  const app = loadApp(memoryStorage(JSON.stringify(maxNodes)));
  assert.equal(app.run('builderValidTree(root)'), true);
  assert.equal(app.run('builderCanAdd(root)'), false);
  app.run('root.children.pop()');
  assert.equal(app.run('builderCanAdd(root)'), true);
  assert.equal(app.run('builderCanAdd(root,2)'), false);
  maxNodes.children.push(task('one-too-many'));
  assert.equal(app.run(`builderValidTree(${JSON.stringify(maxNodes)})`), false);

  const deep = loadApp(memoryStorage(JSON.stringify(chain(20))));
  assert.equal(deep.run('builderValidTree(root)'), true);
  assert.equal(deep.run("builderCanAdd(findPath('depth-20').at(-1))"), false);
  assert.equal(deep.run("builderCanAdd(findPath('depth-19').at(-1))"), true);
  assert.equal(deep.run(`builderValidTree(${JSON.stringify(chain(21))})`), false);
});

test('malformed saved drafts are preserved instead of overwritten by demo data', () => {
  for (const raw of ['{broken JSON', JSON.stringify(tree([task('bad', { owner: 'missing' })]))]) {
    const storage = memoryStorage(raw);
    const app = loadApp(storage);
    app.run("root.title='Changed in memory'; render();");
    assert.equal(storage.getItem(storageKey), raw);
    assert.equal(storage.writes, 0);
  }
});

test('edited titles, participants, sizes, colors and nested tasks survive reloading', () => {
  const storage = memoryStorage();
  const first = loadApp(storage);
  first.run(`const launch=findPath('launch').at(-1);
    Object.assign(launch,{title:'Новый запуск',size:'large',theme:'blue',participants:['anna','writer']});
    launch.children.push({id:'new-task',title:'Новая задача',owner:'analyst',participants:[],status:'todo',size:'small',theme:'cream'});
    render();`);
  const reloaded = loadApp(storage);
  assert.deepEqual(reloaded.json("findPath('launch').at(-1)"), first.json("findPath('launch').at(-1)"));
  assert.equal(reloaded.run("findPath('new-task').at(-1).owner"), 'analyst');
});

test('rendering or navigating without model changes does not rewrite the draft', () => {
  const app = loadApp();
  const before = app.storage.writes;
  app.run("render(); go('launch'); go('root'); builderMode=false; render();");
  assert.equal(app.storage.writes, before);
});

test('a stale tab cannot overwrite a newer draft from another tab', () => {
  const storage = memoryStorage();
  const olderTab = loadApp(storage);
  const newerTab = loadApp(storage);
  newerTab.run("findPath('launch').at(-1).title='Saved in another tab'; render();");
  const latest = storage.getItem(storageKey);
  const writes = storage.writes;
  olderTab.run("go('launch'); go('root'); findPath('sales').at(-1).title='Stale edit'; render();");
  assert.equal(storage.getItem(storageKey), latest);
  assert.equal(storage.writes, writes);
  assert.equal(olderTab.run('builderStorageBlocked'), true);
  assert.equal(loadApp(storage).run("findPath('launch').at(-1).title"), 'Saved in another tab');
});

test('storage write failure preserves the previous draft and reports an unsaved change', () => {
  const storage = memoryStorage();
  const app = loadApp(storage);
  const previous = storage.getItem(storageKey);
  storage.failWrites = true;
  app.run("findPath('launch').at(-1).title='Cannot save this'; render();");
  assert.equal(storage.getItem(storageKey), previous);
  const hint = app.elements.get('saveHint');
  assert.match(`${hint.textContent} ${hint.innerHTML}`, /до обновления|не сохран|не удалось/i);
});

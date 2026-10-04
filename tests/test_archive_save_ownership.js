"use strict";

// 前端存档请求归属的回归测试。
//
// 背景一：首次保存（尚未取得版本）会先发 GET /api/archive 预读取槽内版本，再据此 PUT。
// 若预读取延迟期间确认重新导入（或随后恢复存档并修改），旧保存动作必须失效：
// 迟到的预读取无论成功、失败还是收尾，都不得触发后续 PUT，也不得改动新稿的版本、
// 未存档标记、提示或新一次保存的等待状态。
//
// 背景二：保存遇 409 后，冲突横幅上的「读取最新版本」会发 GET /api/archive。
// 若该读取等待期间确认重新导入或成功恢复存档（草稿世代推进），旧读取的成功、失败与
// 收尾同样必须落空——成功响应不得把新稿有效取得的版本顶回旧版本（否则再次保存会遭遇
// 无谓的 409），失败响应也不得在新稿上显示错误；同稿读取则只更新版本与提示，不替换
// 正文、不自动保存。
//
// 本文件用最小 DOM 桩在 Node 虚拟机中加载真实的 app/static/app.js（不修改它），
// 直接驱动「保存存档 / 读取最新版本 / 重新导入 / 恢复存档」的真实事件处理器，
// fetch 由测试逐个收尾。
// 运行：node --test tests/test_archive_save_ownership.js（无第三方依赖）

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS = path.join(__dirname, "..", "app", "static", "app.js");

// --------------------------------------------------------------------------- //
// 最小 DOM 桩：只实现 app.js 在上述流程中真正触达的元素能力
// --------------------------------------------------------------------------- //
function makeElement(name) {
  const listeners = new Map();
  const classes = new Set();
  return {
    name,
    hidden: false,
    disabled: false,
    checked: false,
    textContent: "",
    innerHTML: "",
    value: "",
    title: "",
    dataset: {},
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    // 触发已注册监听器并返回其 Promise（调用方自行决定何时 await）
    fire(type, event = {}) {
      return Promise.all((listeners.get(type) || []).map((fn) => fn(event)));
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: () => {},
    scrollIntoView: () => {},
    focus: () => {},
    setSelectionRange: () => {},
    closest: () => null,
  };
}

// fetch 桩：记录每一次请求，响应时机与结果完全由测试控制
function makeFetchStub() {
  const calls = [];
  const fetch = (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const call = {
        url,
        method: opts.method || "GET",
        body: opts.body ? JSON.parse(opts.body) : null,
        settled: false,
        respond(status, data) {
          call.settled = true;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => data,
          });
        },
        fail(err) {
          call.settled = true;
          reject(err || new TypeError("fetch failed"));
        },
      };
      calls.push(call);
    });
  fetch.calls = calls;
  fetch.archiveGets = () =>
    calls.filter((c) => c.url === "/api/archive" && c.method === "GET");
  fetch.archivePuts = () =>
    calls.filter((c) => c.url === "/api/archive" && c.method === "PUT");
  return fetch;
}

// 在虚拟机中加载 app.js，并借追加的测试钩子把模块内部状态暴露出来（app.js 本身不改动）
function loadApp() {
  const elements = new Map();
  const $el = (sel) => {
    if (!elements.has(sel)) elements.set(sel, makeElement(sel));
    return elements.get(sel);
  };
  const fetch = makeFetchStub();
  const confirms = [];
  const sandbox = {
    document: {
      querySelector: $el,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: (tag) => makeElement(tag),
      createDocumentFragment: () => makeElement("fragment"),
    },
    fetch,
    confirm: (...args) => {
      confirms.push(args);
      return true; // 测试一律确认（重新导入 / 恢复存档）
    },
    alert: () => {},
    console,
  };
  const source = fs.readFileSync(APP_JS, "utf8");
  const hook = "\n;globalThis.__app = { state, touch };\n";
  vm.createContext(sandbox);
  vm.runInContext(source + hook, sandbox, { filename: "app.js" });
  return { sandbox, fetch, $el, confirms, state: sandbox.__app.state, touch: sandbox.__app.touch };
}

// 让虚拟机中的 Promise 链推进一轮
const flush = () => new Promise((resolve) => setImmediate(resolve));

const IMPORT_OK = {
  clauses: [
    { id: "c1", original: 1, body: "甲方在七日内交付设备", ref_ids: [] },
    { id: "c2", original: 2, body: "乙方按 [[c1]] 验收后付款", ref_ids: ["c1"] },
  ],
};

// 通过页面真实入口完成一次导入（随后的预览请求保持挂起，不影响存档流程）
async function importDoc(app, text) {
  app.$el("#import-text").value = text;
  const done = app.$el("#import-btn").fire("click");
  await flush();
  const call = app.fetch.calls.find((c) => c.url === "/api/import" && !c.settled);
  assert.ok(call, "导入应发出 /api/import 请求");
  call.respond(200, IMPORT_OK);
  await done;
  await flush();
}

// 服务端存档中的既有快照（供恢复）
const STORED_SNAPSHOT = {
  baseline: {
    order_ids: ["c1", "c2"],
    clauses: [
      { id: "c1", body: "存档第一条" },
      { id: "c2", body: "存档第二条见 [[c1]]" },
    ],
  },
  order_ids: ["c1", "c2"],
  clauses: [
    { id: "c1", body: "存档第一条" },
    { id: "c2", body: "存档第二条见 [[c1]]" },
  ],
  id_counter: 2,
};

// --------------------------------------------------------------------------- //
// 迟到预读取成功：重新导入 → 恢复已有存档并修改 → 旧读取才返回
// --------------------------------------------------------------------------- //
test("换稿后迟到的预读取成功：不触发 PUT，不改新稿版本/未存档标记/提示", async () => {
  const app = loadApp();
  await importDoc(app, "1|第一条\n2|第二条 [[1]]");

  // 首次保存：尚未取得版本，先发 GET 预读取（保持挂起，模拟读取延迟）
  const saveDone = app.$el("#archive-save-btn").fire("click");
  await flush();
  assert.equal(app.state.archiving, true);
  assert.equal(app.fetch.archiveGets().length, 1, "首次保存应先发 GET 预读取");
  const staleGet = app.fetch.archiveGets()[0];

  // 读取延迟期间确认重新导入：旧保存动作随即失效
  await app.$el("#reimport-btn").fire("click");
  await flush();
  assert.equal(app.state.archiving, false);

  // 随后恢复已有存档（恢复自身的读取正常返回）并修改草稿
  const restoreDone = app.$el("#archive-restore-import-btn").fire("click");
  await flush();
  assert.equal(app.fetch.archiveGets().length, 2, "恢复会发出自己的 GET");
  app.fetch.archiveGets()[1].respond(200, { version: 3, snapshot: STORED_SNAPSHOT });
  await restoreDone;
  await flush();
  assert.equal(app.state.archiveVersion, 3);
  assert.equal(app.state.archiveDirty, false);
  app.touch(); // 恢复后修改草稿：标为未存档
  assert.equal(app.state.archiveDirty, true);

  // 旧保存的预读取此时才返回：不得发 PUT 保存恢复后的稿件，
  // 也不得改动新稿的版本、未存档标记、提示或等待状态
  staleGet.respond(200, { version: 3, snapshot: null });
  await flush();
  // 若（错误地）发出了 PUT，先让它收尾，使下面的断言能以明确的失败信息结束
  for (const put of app.fetch.archivePuts()) put.respond(200, { version: 4 });
  await saveDone;
  await flush();

  assert.equal(app.fetch.archivePuts().length, 0, "迟到读取不得触发后续 PUT");
  assert.equal(app.state.archiveVersion, 3, "不得改动新稿已取得的版本");
  assert.equal(app.state.archiveDirty, true, "不得清掉新稿的未存档标记");
  assert.equal(app.state.archiving, false);
  assert.equal(app.state.archiveError, null, "不得在新稿上留下错误提示");
  assert.equal(app.state.archiveNotice, null, "不得在新稿上留下提示");
});

// --------------------------------------------------------------------------- //
// 迟到预读取失败：换稿后再次保存已在途，旧读取失败不得干扰
// --------------------------------------------------------------------------- //
test("换稿后迟到的预读取失败：不提示、不解除新保存的等待状态；新保存完整走通", async () => {
  const app = loadApp();
  await importDoc(app, "1|第一条\n2|第二条 [[1]]");

  // 首次保存：预读取挂起
  const save1 = app.$el("#archive-save-btn").fire("click");
  await flush();
  assert.equal(app.fetch.archiveGets().length, 1);
  const staleGet = app.fetch.archiveGets()[0];

  // 重新导入并导入新稿
  await app.$el("#reimport-btn").fire("click");
  await flush();
  await importDoc(app, "1|新稿一\n2|新稿二 [[1]]");

  // 换稿后再次保存：仍未取得版本，发出自己的预读取并进入等待
  const save2 = app.$el("#archive-save-btn").fire("click");
  await flush();
  assert.equal(app.fetch.archiveGets().length, 2, "新保存应发出自己的预读取");
  assert.equal(app.state.archiving, true);

  // 旧预读取迟到失败：不得在新稿上提示，也不得解除新保存的等待状态
  staleGet.fail(new TypeError("network down"));
  await save1;
  await flush();
  assert.equal(app.state.archiving, true, "旧读取失败不得解除新保存的等待状态");
  assert.equal(app.state.archiveError, null, "旧读取失败不得在新稿上提示");
  assert.equal(app.fetch.archivePuts().length, 0, "旧读取失败不得触发 PUT");

  // 新保存的预读取正常返回：据此发出 PUT，成功后清掉未存档标记
  app.fetch.archiveGets()[1].respond(200, { version: 0, snapshot: null });
  await flush();
  assert.equal(app.fetch.archivePuts().length, 1, "新保存应在预读取成功后发出 PUT");
  const put = app.fetch.archivePuts()[0];
  assert.equal(put.body.version, 0);
  assert.deepEqual(put.body.snapshot.order_ids, ["c1", "c2"]);
  assert.equal(put.body.snapshot.id_counter, 2);
  put.respond(200, { version: 1 });
  await save2;
  await flush();
  assert.equal(app.state.archiveVersion, 1);
  assert.equal(app.state.archiveDirty, false, "有效保存成功后清掉未存档标记");
  assert.equal(app.state.archiving, false);
  assert.equal(app.state.archiveError, null);
});

// --------------------------------------------------------------------------- //
// 保存期间改稿：允许；回执只确认发出 PUT 时的快照，此后的修改仍标为未存档
// --------------------------------------------------------------------------- //
test("保存期间改稿：回执只确认提交时的快照，此后修改仍标未存档", async () => {
  const app = loadApp();
  await importDoc(app, "1|第一条\n2|第二条 [[1]]");

  // 首次保存：预读取 → PUT 依次发出
  const saveDone = app.$el("#archive-save-btn").fire("click");
  await flush();
  app.fetch.archiveGets()[0].respond(200, { version: 0, snapshot: null });
  await flush();
  assert.equal(app.fetch.archivePuts().length, 1);
  const put = app.fetch.archivePuts()[0];

  // PUT 在途期间改稿：允许，且不影响已发出的请求
  app.touch();
  assert.equal(app.state.archiveDirty, true);

  // 回执只确认提交时的快照：版本知识推进，但此后的修改仍标为未存档
  put.respond(200, { version: 1 });
  await saveDone;
  await flush();
  assert.equal(app.state.archiveVersion, 1);
  assert.equal(app.state.archiveDirty, true, "保存期间的修改仍标为未存档");
  assert.match(app.state.archiveNotice, /提交时的快照/);
  assert.equal(app.state.archiving, false);
});

// --------------------------------------------------------------------------- //
// 「读取最新版本」的驱动助手
// --------------------------------------------------------------------------- //
// 首次保存完整走通一次（预读取空槽 → PUT），随后制造一次保存冲突（409），
// 返回冲突横幅的「读取最新版本」点击处理器被触发后的 Promise（其 GET 保持挂起）。
async function saveOnceThenConflict(app) {
  let save = app.$el("#archive-save-btn").fire("click");
  await flush();
  app.fetch.archiveGets()[0].respond(200, { version: 0, snapshot: null });
  await flush();
  app.fetch.archivePuts()[0].respond(200, { version: 1 });
  await save;
  await flush();
  assert.equal(app.state.archiveVersion, 1);

  app.touch(); // 改稿后再次保存：携带 v1 但服务端已到 v2，触发 409 冲突横幅
  const putsBefore = app.fetch.archivePuts().length;
  save = app.$el("#archive-save-btn").fire("click");
  await flush();
  assert.equal(app.fetch.archivePuts().length, putsBefore + 1);
  app.fetch
    .archivePuts()
    [putsBefore].respond(409, { detail: { errors: ["存档版本冲突"], version: 2 } });
  await save;
  await flush();
  assert.equal(app.state.archiveConflict, 2);
  assert.equal(app.state.archiveVersion, 1, "409 不改动本地版本知识");
}

// 点击冲突横幅上的「读取最新版本」（DOM 桩中 closest 返回按钮自身）
function clickReadLatest(app) {
  const banner = app.$el("#archive-banner");
  const btn = { closest: (sel) => (sel === '[data-action="archive-read-latest"]' ? btn : null) };
  return banner.fire("click", { target: btn });
}

// --------------------------------------------------------------------------- //
// 「读取最新版本」迟到成功：换稿（重新导入 → 恢复并修改）后旧成功不得回退新稿版本
// --------------------------------------------------------------------------- //
test("读取最新版本迟到成功：换稿后旧成功不改新稿任何存档状态，再保存用新稿版本且无无谓 409", async () => {
  const app = loadApp();
  await importDoc(app, "1|第一条\n2|第二条 [[1]]");
  await saveOnceThenConflict(app);

  // 点「读取最新版本」：GET 保持挂起（模拟读取延迟）
  const readDone = clickReadLatest(app);
  await flush();
  const staleGet = app.fetch.archiveGets()[app.fetch.archiveGets().length - 1];

  // 等待期间确认重新导入：世代推进
  await app.$el("#reimport-btn").fire("click");
  await flush();

  // 再恢复较新存档（恢复自身的读取正常返回），随后修改新稿
  const restoreDone = app.$el("#archive-restore-import-btn").fire("click");
  await flush();
  app.fetch.archiveGets()[app.fetch.archiveGets().length - 1].respond(200, {
    version: 4,
    snapshot: STORED_SNAPSHOT,
  });
  await restoreDone;
  await flush();
  assert.equal(app.state.archiveVersion, 4);
  assert.equal(app.state.archiveDirty, false);
  assert.deepEqual(app.state.orderIds, ["c1", "c2"]);
  assert.equal(app.state.clauses[0].body, "存档第一条");
  app.touch(); // 恢复后修改：标为未存档
  assert.equal(app.state.archiveDirty, true);

  // 旧读取此时才成功（返回旧版本 2）：成功与收尾一律落空
  staleGet.respond(200, { version: 2, snapshot: null });
  await readDone;
  await flush();

  assert.equal(app.state.archiveVersion, 4, "旧成功不得回退新稿有效取得的版本");
  assert.equal(app.state.archiveDirty, true, "不得清掉新稿的未存档标记");
  assert.equal(app.state.archiveConflict, null, "不得在新稿上设置冲突");
  assert.equal(app.state.archiveError, null, "不得在新稿上留下错误");
  assert.equal(app.state.archiveNotice, null, "不得在新稿上留下提示");
  assert.equal(app.state.clauses[0].body, "存档第一条", "不得替换新稿正文");
  const banner = app.$el("#archive-banner");
  assert.equal(banner.hidden, true, "不得重绘新稿横幅");

  // 再次保存必须沿用新稿版本 4：一次成功（旧代码会因版本被顶成 2 而先吃一次 409）
  const putsBefore = app.fetch.archivePuts().length;
  const resave = app.$el("#archive-save-btn").fire("click");
  await flush();
  assert.equal(
    app.fetch.archivePuts().length,
    putsBefore + 1,
    "再次保存应直接 PUT（沿用版本 4），不重复预读取",
  );
  const resavePut = app.fetch.archivePuts()[putsBefore];
  assert.equal(resavePut.body.version, 4);
  resavePut.respond(200, { version: 5 });
  await resave;
  await flush();
  assert.equal(app.state.archiveVersion, 5);
  assert.equal(app.state.archiveDirty, false, "再次保存成功，未遭遇无谓 409");
});

// --------------------------------------------------------------------------- //
// 「读取最新版本」迟到失败：换稿后旧失败不得在新稿上显示错误
// --------------------------------------------------------------------------- //
test("读取最新版本迟到失败：换稿后旧失败不提示、不改新稿任何存档状态", async () => {
  const app = loadApp();
  await importDoc(app, "1|第一条\n2|第二条 [[1]]");
  await saveOnceThenConflict(app);

  const readDone = clickReadLatest(app);
  await flush();
  const staleGet = app.fetch.archiveGets()[app.fetch.archiveGets().length - 1];

  await app.$el("#reimport-btn").fire("click");
  await flush();
  const restoreDone = app.$el("#archive-restore-import-btn").fire("click");
  await flush();
  app.fetch.archiveGets()[app.fetch.archiveGets().length - 1].respond(200, {
    version: 4,
    snapshot: STORED_SNAPSHOT,
  });
  await restoreDone;
  await flush();
  app.touch(); // 恢复后修改新稿

  // 旧读取此时才失败：失败与收尾一律落空
  staleGet.fail(new TypeError("network down"));
  await readDone;
  await flush();

  assert.equal(app.state.archiveVersion, 4, "旧失败不得改动新稿版本");
  assert.equal(app.state.archiveDirty, true, "旧失败不得改动未存档标记");
  assert.equal(app.state.archiveConflict, null);
  assert.equal(app.state.archiveError, null, "旧失败不得在新稿上显示错误");
  assert.equal(app.state.archiveNotice, null);
  assert.equal(app.$el("#archive-banner").hidden, true, "不得重绘新稿横幅");
});

// --------------------------------------------------------------------------- //
// 新保存等待期间旧读取返回（成功 / 失败）：不得解除新保存的等待状态
// --------------------------------------------------------------------------- //
test("换稿后再次保存等待中：旧读取成功不回退版本、不解除新保存等待，新保存正常成功", async () => {
  const app = loadApp();
  await importDoc(app, "1|第一条\n2|第二条 [[1]]");
  await saveOnceThenConflict(app);

  const readDone = clickReadLatest(app);
  await flush();
  const staleGet = app.fetch.archiveGets()[app.fetch.archiveGets().length - 1];

  // 等待期间重新导入并导入新稿（新稿无需预读取：换稿复位后由恢复建立版本知识）
  await app.$el("#reimport-btn").fire("click");
  await flush();
  const restoreDone = app.$el("#archive-restore-import-btn").fire("click");
  await flush();
  app.fetch.archiveGets()[app.fetch.archiveGets().length - 1].respond(200, {
    version: 2,
    snapshot: STORED_SNAPSHOT,
  });
  await restoreDone;
  await flush();
  app.touch(); // 修改新稿后再次保存：直接携带新稿版本 2 发 PUT
  const putsBefore = app.fetch.archivePuts().length;
  const save = app.$el("#archive-save-btn").fire("click");
  await flush();
  assert.equal(app.state.archiving, true);
  assert.equal(app.fetch.archivePuts().length, putsBefore + 1);
  const newPut = app.fetch.archivePuts()[putsBefore];
  assert.equal(newPut.body.version, 2);

  // 旧读取此时才成功（旧版本）：不得解除新保存等待、不得回退版本
  staleGet.respond(200, { version: 2, snapshot: null });
  await readDone;
  await flush();
  assert.equal(app.state.archiving, true, "旧读取成功不得解除新保存的等待状态");
  assert.equal(app.state.archiveVersion, 2, "旧读取不得回退新稿版本");
  assert.equal(app.state.archiveError, null);
  assert.equal(app.state.archiveNotice, null);

  // 新保存沿用版本 2 一次成功，无无谓 409
  newPut.respond(200, { version: 3 });
  await save;
  await flush();
  assert.equal(app.state.archiveVersion, 3);
  assert.equal(app.state.archiveDirty, false);
  assert.equal(app.state.archiving, false);
});

test("换稿后再次保存等待中：旧读取失败不提示、不解除新保存等待", async () => {
  const app = loadApp();
  await importDoc(app, "1|第一条\n2|第二条 [[1]]");
  await saveOnceThenConflict(app);

  const readDone = clickReadLatest(app);
  await flush();
  const staleGet = app.fetch.archiveGets()[app.fetch.archiveGets().length - 1];

  await app.$el("#reimport-btn").fire("click");
  await flush();
  const restoreDone = app.$el("#archive-restore-import-btn").fire("click");
  await flush();
  app.fetch.archiveGets()[app.fetch.archiveGets().length - 1].respond(200, {
    version: 2,
    snapshot: STORED_SNAPSHOT,
  });
  await restoreDone;
  await flush();
  app.touch();
  const putsBefore = app.fetch.archivePuts().length;
  const save = app.$el("#archive-save-btn").fire("click");
  await flush();
  assert.equal(app.state.archiving, true);
  const newPut = app.fetch.archivePuts()[putsBefore];

  // 旧读取此时才失败：不在新稿提示，也不解除新保存的等待状态
  staleGet.fail(new TypeError("network down"));
  await readDone;
  await flush();
  assert.equal(app.state.archiving, true, "旧读取失败不得解除新保存的等待状态");
  assert.equal(app.state.archiveError, null, "旧读取失败不得在新稿上提示");
  assert.equal(app.state.archiveVersion, 2);

  newPut.respond(200, { version: 3 });
  await save;
  await flush();
  assert.equal(app.state.archiveVersion, 3);
  assert.equal(app.state.archiveDirty, false);
});

// --------------------------------------------------------------------------- //
// 同稿读取（正常冲突流程）：只更新版本与提示，不替换正文、不自动保存；再保存沿用新读版本
// --------------------------------------------------------------------------- //
test("正常冲突后读取最新版本再保存：不替换正文、不自动保存，PUT 沿用读到的版本", async () => {
  const app = loadApp();
  await importDoc(app, "1|第一条\n2|第二条 [[1]]");
  await saveOnceThenConflict(app);
  assert.equal(app.state.clauses[0].body, "甲方在七日内交付设备");
  const putsAfterConflict = app.fetch.archivePuts().length;

  // 同稿读取成功（服务端 v2 有快照）：只更新版本与提示
  const readDone = clickReadLatest(app);
  await flush();
  app.fetch
    .archiveGets()
    [app.fetch.archiveGets().length - 1].respond(200, { version: 2, snapshot: STORED_SNAPSHOT });
  await readDone;
  await flush();

  assert.equal(app.state.archiveVersion, 2, "同稿读取更新版本知识");
  assert.equal(app.state.archiveConflict, null, "读取后冲突解除");
  assert.equal(app.state.archiveError, null);
  assert.match(app.state.archiveNotice, /版本 2/);
  assert.equal(
    app.state.clauses[0].body,
    "甲方在七日内交付设备",
    "读取不替换本地正文",
  );
  assert.equal(app.state.archiveDirty, true, "读取不改变未存档标记");
  assert.equal(
    app.fetch.archivePuts().length,
    putsAfterConflict,
    "读取不触发自动保存",
  );

  // 再保存沿用读到的版本 2，一次成功
  const save = app.$el("#archive-save-btn").fire("click");
  await flush();
  assert.equal(app.fetch.archivePuts().length, putsAfterConflict + 1);
  const put = app.fetch.archivePuts()[putsAfterConflict];
  assert.equal(put.body.version, 2);
  put.respond(200, { version: 3 });
  await save;
  await flush();
  assert.equal(app.state.archiveVersion, 3);
  assert.equal(app.state.archiveDirty, false);
});

test("正常冲突后读取失败：错误显示在横幅上，本地稿与版本知识不变，可再次操作", async () => {
  const app = loadApp();
  await importDoc(app, "1|第一条\n2|第二条 [[1]]");
  await saveOnceThenConflict(app);

  const readDone = clickReadLatest(app);
  await flush();
  app.fetch.archiveGets()[app.fetch.archiveGets().length - 1].fail(new TypeError("network down"));
  await readDone;
  await flush();

  assert.equal(app.state.archiveVersion, 1, "读取失败不改动版本知识");
  assert.equal(app.state.archiveConflict, 2, "读取失败不清掉冲突（仍可再点读取）");
  assert.ok(app.state.archiveError, "同稿读取失败应显示错误");
  assert.equal(app.state.archiveDirty, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  readSessionFile,
  readSessionFileAsync,
  discoverSessionLogs,
  writeSessionLog,
} from "../src/session-file.js";

const HEADER = (version) => ({ type: "session", version, id: "11111111-2222-3333-4444-555555555555", createdAt: 1 });
const EV = (i) => ({ type: "user/message", seq: i, data: { message: { role: "user", content: [{ type: "text", text: `msg-${i}` }] } } });

test("v4 multiframe log reads (v3-identical frame structure)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-v4-"));
  const { logPath } = writeSessionLog(dir, HEADER(4), [EV(1), EV(2), EV(3)], "v4");
  const { header, events } = readSessionFile(logPath);
  assert.equal(header.version, 4);
  assert.equal(events.length, 3);
  assert.equal(events[2].data.message.content[0].text, "msg-3");
});

test("v4 multiframe async read equals sync read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-v4a-"));
  const { logPath } = writeSessionLog(dir, HEADER(4), [EV(1), EV(2)], "v4");
  const a = await readSessionFileAsync(logPath);
  assert.equal(a.header.version, 4);
  assert.equal(a.events.length, 2);
  assert.equal(a.frameCount, 1); // header 帧 + 1 事件帧
});

test("legacy single-frame session.jsonl.zstd reads (header first line + events)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-legacy-"));
  const { logPath } = writeSessionLog(dir, HEADER(3), [EV(1), EV(2)], "legacy");
  assert.ok(logPath.endsWith("session.jsonl.zstd"));
  const { header, events } = readSessionFile(logPath);
  assert.equal(header.version, 3);
  assert.equal(events.length, 2);
  assert.equal(events[1].seq, 2);
});

test("legacy single-frame async read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-la-"));
  const { logPath } = writeSessionLog(dir, HEADER(3), [EV(9)], "legacy");
  const r = await readSessionFileAsync(logPath);
  assert.equal(r.events.length, 1);
  assert.equal(r.frameCount, 1);
});

test("unknown version fails loud with clear message", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-v9-"));
  const { logPath } = writeSessionLog(dir, HEADER(9), [EV(1)], "v4");
  assert.throws(() => readSessionFile(logPath), /unsupported session log version: 9/);
});

test("legacy single-frame with historical version 0 reads (real-world legacy)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-v0-"));
  const { logPath } = writeSessionLog(dir, { ...HEADER(0), id: "session-152323f4-128f-4ebc-936a-c378b69a42f7" }, [EV(1)], "legacy");
  const { header, events } = readSessionFile(logPath);
  assert.equal(header.version, 0);
  assert.equal(events.length, 1);
});

test("discoverSessionLogs prefers v4 then v3 then legacy", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ss-home-"));
  const root = path.join(home, "sessions");
  const id = "session-11111111-2222-3333-4444-555555555555";
  // v4 与 v3 并存：只报 v4
  writeSessionLog(path.join(root, "proj-a", id), HEADER(4), [EV(1)], "v4");
  writeSessionLog(path.join(root, "proj-a", id), HEADER(3), [EV(2)], "v3");
  // 只有 legacy：报 legacy
  const id2 = "session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  writeSessionLog(path.join(root, "proj-b", id2), HEADER(3), [EV(3)], "legacy");
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const logs = discoverSessionLogs();
    assert.equal(logs.length, 2);
    assert.equal(logs[0].format, "v4-multiframe");
    assert.ok(logs[0].logPath.endsWith("session.v4.jsonl.zstd"));
    assert.equal(logs[1].format, "legacy-single-frame");
    // 读回 legacy 发现项
    const { events } = readSessionFile(logs[1].logPath);
    assert.equal(events.length, 1);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  }
});

// Cliente do núcleo: limite de tempo, erro do worker, cancelamento e coalescência — nada fica pendurado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KernelClient, KernelRestartError, type RestartInfo, type WorkerLike } from "../src/app/kernel-client.ts";
import type { CadDocument } from "../src/doc/types.ts";

/** Worker falso: guarda as mensagens recebidas e responde só quando o teste mandar. */
class FakeWorker implements WorkerLike {
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  onmessageerror: WorkerLike["onmessageerror"] = null;
  posted: { id: number; type: string; force?: boolean }[] = [];
  terminated = false;
  postMessage(msg: unknown) { this.posted.push(msg as { id: number; type: string }); }
  terminate() { this.terminated = true; }
  reply(id: number, result: unknown = { ok: id }) { this.onmessage?.({ data: { id, ok: true, result } } as MessageEvent); }
  fail(id: number, error: string) { this.onmessage?.({ data: { id, ok: false, error } } as MessageEvent); }
  crash(message: string) { this.onerror?.({ message, preventDefault() {} } as ErrorEvent); }
}

function setup(timeoutMs = 60_000) {
  const workers: FakeWorker[] = [];
  const restarts: RestartInfo[] = [];
  const busy: boolean[] = [];
  const k = new KernelClient({
    create: () => { const w = new FakeWorker(); workers.push(w); return w; },
    timeoutMs: () => timeoutMs,
    onRestart: (i) => restarts.push(i),
    onBusy: (b) => busy.push(b),
  });
  return { k, workers, restarts, busy, last: () => workers[workers.length - 1] };
}

const doc = { name: "p" } as unknown as CadDocument;
const tick = () => new Promise((r) => setTimeout(r, 0));
const silence = () => { const orig = console.error; console.error = () => {}; return () => { console.error = orig; }; };

test("pedido simples resolve e onBusy marca ocupado → livre", async () => {
  const { k, last, busy } = setup();
  const p = k.interference();
  assert.equal(k.busy, true);
  last().reply(last().posted[0].id, { pairs: [] });
  assert.deepEqual(await p, { pairs: [] });
  assert.equal(k.busy, false);
  assert.deepEqual(busy, [true, false]);
});

test("erro devolvido pelo worker rejeita com Error normal, sem reiniciar", async () => {
  const { k, last, restarts } = setup();
  const p = k.normals();
  last().fail(last().posted[0].id, "sem modelo");
  await assert.rejects(p, (e: Error) => !(e instanceof KernelRestartError) && e.message === "sem modelo");
  assert.equal(restarts.length, 0);
  assert.equal(k.restarts, 0);
});

test("limite de tempo: reinicia o worker e rejeita com KernelRestartError", async () => {
  const restore = silence();
  try {
    const { k, workers, restarts, busy } = setup(20);
    const p = k.export("step", "p");
    await assert.rejects(p, (e: unknown) => e instanceof KernelRestartError && !e.aborted && /sem resposta/.test(e.message));
    assert.equal(workers.length, 2);
    assert.equal(workers[0].terminated, true);
    assert.equal(k.restarts, 1);
    assert.deepEqual(restarts.map((r) => [r.during, r.aborted]), [[["export"], false]]);
    assert.deepEqual(busy, [true, false]);
  } finally { restore(); }
});

test("a vigia recomeça a cada resposta (fila longa não expira se o worker vai respondendo)", async () => {
  const { k, last } = setup(40);
  const a = k.normals(), b = k.continuity();
  await new Promise((r) => setTimeout(r, 25));
  last().reply(last().posted[0].id);
  await new Promise((r) => setTimeout(r, 25)); // 50 ms desde o início, mas só 25 desde a última resposta
  last().reply(last().posted[1].id);
  await Promise.all([a, b]);
  assert.equal(k.restarts, 0);
});

test("erro do worker (aborto do WASM) rejeita todos os pendentes e cria worker novo", async () => {
  const restore = silence();
  try {
    const { k, workers, restarts } = setup();
    const a = k.normals(), b = k.curvature("gauss" as never);
    workers[0].crash("RuntimeError: unreachable");
    await assert.rejects(a, KernelRestartError);
    await assert.rejects(b, KernelRestartError);
    assert.equal(workers.length, 2);
    assert.deepEqual(restarts[0].during, ["normals", "curvature"]);
    assert.match(restarts[0].why, /unreachable/);
    // o worker novo funciona
    const c = k.deviation();
    workers[1].reply(workers[1].posted[0].id, 7);
    assert.equal(await c, 7);
  } finally { restore(); }
});

test("abort(): false quando livre; true e rejeição marcada como cancelamento quando ocupado", async () => {
  const { k, workers, restarts } = setup();
  assert.equal(k.abort(), false);
  assert.equal(k.restarts, 0);
  const p = k.export("stl", "p");
  assert.equal(k.abort(), true);
  await assert.rejects(p, (e: unknown) => e instanceof KernelRestartError && e.aborted);
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(restarts, [{ why: "cancelado pelo utilizador", during: ["export"], aborted: true }]);
  assert.equal(k.busy, false);
});

test("respostas tardias de um worker substituído são ignoradas", async () => {
  const { k, workers } = setup();
  const p = k.normals();
  const oldId = workers[0].posted[0].id;
  k.abort();
  await assert.rejects(p);
  const q = k.normals();
  workers[0].reply(oldId, "velho"); // mesmo que o id coincidisse, vem do worker antigo
  workers[0].reply(workers[1].posted[0].id, "velho");
  assert.equal(k.busy, true);
  workers[1].reply(workers[1].posted[0].id, "novo");
  assert.equal(await q, "novo");
});

test("reconstruções coalescidas: as substituídas resolvem null e o force mantém-se", async () => {
  const { k, last } = setup();
  const r1 = k.rebuild(doc);
  await tick();
  const r2 = k.rebuild(doc, true);
  const r3 = k.rebuild(doc);
  assert.equal(await r2, null);
  const w = last();
  assert.equal(w.posted.length, 1);
  w.reply(w.posted[0].id, "r1");
  assert.equal(await r1, null, "r3 já está em espera, o resultado de r1 está ultrapassado");
  await tick();
  assert.equal(w.posted.length, 2);
  assert.equal(w.posted[1].force, true, "o force de r2 passa para r3");
  w.reply(w.posted[1].id, "r3");
  assert.equal(await r3, "r3");
});

test("resultado de uma reconstrução já ultrapassada por outra em espera é null", async () => {
  const { k, last } = setup();
  const r1 = k.rebuild(doc);
  await tick();
  const r2 = k.rebuild(doc);
  last().reply(last().posted[0].id, "r1");
  assert.equal(await r1, null);
  await tick();
  last().reply(last().posted[1].id, "r2");
  assert.equal(await r2, "r2");
});

test("cancelar a reconstrução em curso: a que está em espera corre no worker novo", async () => {
  const { k, workers } = setup();
  const r1 = k.rebuild(doc);
  await tick();
  const r2 = k.rebuild(doc);
  k.abort();
  await assert.rejects(r1, KernelRestartError);
  await tick();
  assert.equal(workers.length, 2);
  assert.equal(workers[1].posted.length, 1);
  assert.equal(workers[1].posted[0].type, "rebuild");
  workers[1].reply(workers[1].posted[0].id, "r2");
  assert.equal(await r2, "r2");
});

// Processo à parte (Electron utilityProcess) onde corre o agente de simulação: um solver ou um pedido
// que encrave aqui não congela a janela nem o processo principal, e pode ser morto sem fechar a app.
// O processo principal passa o módulo e o token pelo ambiente e recebe { port, tools } quando o
// servidor está à escuta (ou { error } se não arrancar).
const { pathToFileURL } = require("node:url");

async function main() {
  const mod = await import(pathToFileURL(process.env.GALCAD_AGENT_MODULE).href);
  const { server } = mod.serve(0, process.env.GALCAD_AGENT_TOKEN);
  await new Promise((ok, fail) => {
    if (server.listening) return ok();
    server.once("listening", ok);
    server.once("error", fail);
  });
  process.parentPort.postMessage({ port: server.address().port, tools: mod.tools() });
}

// em caso de erro o processo principal mata este processo depois de ler a mensagem
main().catch((e) => process.parentPort.postMessage({ error: String(e?.stack ?? e) }));
